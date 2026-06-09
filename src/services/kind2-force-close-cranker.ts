/**
 * Permissionless `ForceCloseKind2` (tag 88) cranker for actionable kind=2 slabs.
 *
 * Each kind=2 market is configured with a `force_close_unix_timestamp`
 * far ahead of Polymarket's expected resolution. From that timestamp
 * onward, any caller can submit `ForceCloseKind2` and the slab settles
 * at the captured TWAP (or refund-mode if the ring is empty). This
 * cranker is the keeper's permissionless contribution to that flow —
 * the on-chain instruction is permissionless, so backup keepers, MEV
 * searchers, or motivated community members can fire it too.
 *
 * Single setInterval tick at 5s cadence (mirrors K3's lifecycle but at a
 * looser cadence since force-close fires once per market lifetime). On
 * each tick:
 *
 *   1. Read the registry's actionable markets.
 *   2. For each market, lazily sample a per-market jitter (0–30s)
 *      stable across this keeper's lifetime — collision avoidance for
 *      multiple concurrent keepers without re-rolling on each tick.
 *   3. Skip markets where `now < force_close_unix_timestamp + jitter`
 *      (fire window not open).
 *   4. Skip markets we've already marked `done` (success or race-loss).
 *   5. Skip markets currently in backoff or with an inflight submit.
 *   6. Build the tag-88 instruction (1-byte payload), submit via the
 *      existing keeper send path.
 *   7. Classify the result. `InvalidAccountData` = race-loss, treated
 *      as success because the market resolved exactly as intended;
 *      we just weren't the caller who fired. Mark `done`.
 *
 * The on-chain `clock.unix_timestamp >= force_close_unix_timestamp`
 * check is the source-of-truth gate. Our local check just avoids
 * burning fees on a premature attempt and gives concurrent keepers
 * a jitter window to dispatch into.
 *
 * One-shot per market: once `done` is set, we stop attempting. The
 * registry will evict the slab on the next slab account update
 * (because `forced_close_price_e6 != 0` post-resolve).
 *
 * Hand-rolled tag-88 encoder: the shipped `@percolatorct/sdk` (2.0.9)
 * does not expose `encodeForceCloseKind2`. Behind a single internal
 * function so the SDK swap is one line.
 */

import {
  PublicKey,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { buildIx } from "@percolatorct/sdk";
import { createLogger } from "@percolatorct/shared";
import { Kind2Registry, type Kind2Entry } from "./kind2-registry.js";
import { keeperSend, type KeeperSendResult } from "../lib/keeper-send.js";
import { KeeperBudget } from "../lib/budget.js";
import {
  kind2ForceCloseEligible,
  kind2ForceCloseAttemptTotal,
  kind2ForceCloseSuccessTotal,
  kind2ForceCloseRaceLossTotal,
  kind2ForceCloseRejectTotal,
  kind2ForceCloseTickDurationMs,
} from "../lib/metrics.js";

const logger = createLogger("keeper:kind2-force-close");

/**
 * Hand-rolled `ForceCloseKind2` (tag 88) encoder. The on-chain handler
 * takes no instruction-data payload beyond the 1-byte tag. Source of
 * truth: `handle_force_close_kind2` at
 * `dcccrypto/percolator-prog/src/percolator.rs` line 18767.
 */
const TAG_FORCE_CLOSE_KIND2 = 88;
function encodeForceCloseKind2(): Uint8Array {
  return new Uint8Array([TAG_FORCE_CLOSE_KIND2]);
}

/** Classification of an on-chain rejection. */
type RejectKind = "race_loss" | "paused" | "not_yet_eligible" | "other";

/**
 * Map a tx-submit error's logs to a rejection classification. The
 * wrapper's force-close handler returns `ProgramError::InvalidAccountData`
 * for: already-resolved (lost the race), paused, and the wrapper-level
 * one-shot sentinel. The numeric code is the same in all three cases,
 * so we lean on the msg! preambles to disambiguate where possible.
 */
function classifyReject(err: unknown): RejectKind {
  const msg = err instanceof Error ? err.message : String(err);
  const logs = (err as { logs?: string[] }).logs ?? [];
  const joined = (msg + "\n" + logs.join("\n")).toLowerCase();
  if (
    joined.includes("already resolved") ||
    joined.includes("already force-closed")
  ) {
    return "race_loss";
  }
  if (joined.includes("refuses paused market")) {
    return "paused";
  }
  if (joined.includes("not yet eligible") || joined.includes("force_close_unix")) {
    return "not_yet_eligible";
  }
  // Unspecific InvalidAccountData on a market whose force-close window
  // we believed was open: most likely race-loss too.
  if (joined.includes("invalidaccountdata") && joined.includes("forceclosekind2")) {
    return "race_loss";
  }
  return "other";
}

/** Per-market mutable state. */
interface MarketState {
  /** Per-market jitter (seconds), sampled once at first observation and stable across ticks. */
  readonly jitterSecs: number;
  /** True once the market has either successfully force-closed or we observed a race-loss. */
  done: boolean;
  /** Wall-clock ms after which the next attempt is permitted (exponential backoff on transient errors). */
  nextEligibleMs: number;
  /** Consecutive non-success non-race rejections — drives backoff growth. */
  consecFailures: number;
  /** True while a submit for this slab is in flight (single-flight guard). */
  inflight: boolean;
}

export interface Kind2ForceCloseCrankerOptions {
  readonly registry: Kind2Registry;
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly programId: PublicKey;
  readonly budget: KeeperBudget;
  /** Tick cadence in ms. Default 5_000. */
  readonly tickMs?: number;
  /**
   * Post-T buffer in seconds. The on-chain handler requires
   * `clock.unix_timestamp >= force_close_unix_timestamp`; we add this
   * buffer to absorb Solana clock-skew. Default 30.
   */
  readonly postBufferSecs?: number;
  /** Max jitter in seconds for collision avoidance across concurrent keepers. Default 30. */
  readonly jitterMaxSecs?: number;
  /** Max per-market exponential backoff in ms on transient errors. Default 60_000. */
  readonly maxBackoffMs?: number;
  /** Optional clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class Kind2ForceCloseCranker {
  private readonly opts: Required<
    Omit<Kind2ForceCloseCrankerOptions, "registry" | "connection" | "payer" | "programId" | "budget">
  > & Kind2ForceCloseCrankerOptions;
  private readonly state = new Map<string, MarketState>();
  private tickTimer: NodeJS.Timeout | null = null;
  private tickInflight = false;

  constructor(opts: Kind2ForceCloseCrankerOptions) {
    this.opts = {
      tickMs: 5_000,
      postBufferSecs: 30,
      jitterMaxSecs: 30,
      maxBackoffMs: 60_000,
      now: Date.now,
      ...opts,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        logger.warn("tick threw", { err: String(err) });
      });
    }, this.opts.tickMs);
    this.tickTimer.unref?.();
    logger.info("kind2 force-close cranker started", {
      tickMs: this.opts.tickMs,
      postBufferSecs: this.opts.postBufferSecs,
      jitterMaxSecs: this.opts.jitterMaxSecs,
    });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ── Tick (test-visible) ───────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.tickInflight) return;
    this.tickInflight = true;
    const t0 = this.opts.now();
    try {
      const entries = this.opts.registry.list();
      let eligibleCount = 0;
      const dispatches: Promise<unknown>[] = [];
      for (const entry of entries) {
        if (this.isEligibleForFire(entry)) {
          eligibleCount += 1;
          dispatches.push(this.fireOne(entry));
        }
      }
      kind2ForceCloseEligible.set(eligibleCount);
      await Promise.allSettled(dispatches);
    } finally {
      kind2ForceCloseTickDurationMs.observe(this.opts.now() - t0);
      this.tickInflight = false;
    }
  }

  // ── Per-market eligibility + dispatch ─────────────────────────────────

  /**
   * Test-visible: predicate that determines whether a market should be
   * dispatched on this tick. Combines on-chain time gate, jitter,
   * backoff, inflight guard, and the once-only `done` flag.
   */
  isEligibleForFire(entry: Kind2Entry): boolean {
    const st = this.getState(entry);
    if (st.done) return false;
    if (st.inflight) return false;
    const nowMs = this.opts.now();
    if (nowMs < st.nextEligibleMs) return false;

    const fcSecs = entry.fields.forceCloseUnixTimestamp;
    if (fcSecs <= 0n) return false;
    const nowSecs = BigInt(Math.floor(nowMs / 1000));
    const fireAtSecs =
      fcSecs +
      BigInt(this.opts.postBufferSecs) +
      BigInt(st.jitterSecs);
    return nowSecs >= fireAtSecs;
  }

  async fireOne(entry: Kind2Entry): Promise<void> {
    const slab = entry.slab;
    const st = this.getState(entry);
    if (st.inflight || st.done) return;
    st.inflight = true;
    kind2ForceCloseAttemptTotal.inc();
    try {
      const ix = this.buildIx(slab);
      const result = await this.submit(ix);
      if (result === null) {
        // Budget exhausted — soft skip, do not mark done.
        return;
      }
      // Success: we won the race. Mark done so we never re-attempt.
      st.done = true;
      st.consecFailures = 0;
      st.nextEligibleMs = 0;
      // Pull tx logs to attribute the settlement branch. The wrapper
      // emits one "ForceCloseKind2: ... refund_mode=... twap_unbounded=..."
      // line on success; we parse the two relevant fields. Failures here
      // (RPC blip, missing tx, regex miss) MUST NOT mask the success — the
      // helper is internally try/catch'd and returns "unknown" so the
      // counter never under-reports, and the success state is already
      // committed above before the await.
      const branch = await this.classifySuccessBranch(result.signature);
      kind2ForceCloseSuccessTotal.inc({ branch });
      logger.info("kind2 force-close fired", { slab, signature: result.signature, branch });
    } catch (err) {
      this.handleSubmitError(slab, st, err);
    } finally {
      st.inflight = false;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Pull program logs for the confirmed force-close tx and classify which
   * of the three wrapper settlement paths fired. Wrapper msg! on success:
   *
   *   "ForceCloseKind2: slab={} settled_price_e6={} refund_mode={} \
   *    (twap_unbounded={:?}, engine_last={}, force_close_unix_ts={}, now={})"
   *
   * Branch detection:
   *   * refund_mode=true                                 → "refund"
   *   * refund_mode=false AND twap_unbounded=Some(...)   → "twap"
   *   * refund_mode=false AND twap_unbounded=None        → "engine_last"
   *
   * "engine_last" is the silent-degradation case after the force-close
   * two-gate TWAP fix — operators need to know when a market quietly fell
   * through to engine_last instead of settling at TWAP.
   *
   * Any failure path here returns "unknown" so the success count is
   * preserved. Sustained "unknown" indicates the wrapper msg! format
   * drifted from this parser — fix the regex.
   */
  private async classifySuccessBranch(
    signature: string,
  ): Promise<"twap" | "engine_last" | "refund" | "unknown"> {
    try {
      const tx = await this.opts.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const logs = tx?.meta?.logMessages ?? [];
      const line = logs.find((l) => l.includes("ForceCloseKind2: slab="));
      if (!line) return "unknown";
      const refundMatch = /refund_mode=(true|false)/.exec(line);
      const twapMatch = /twap_unbounded=(Some|None)/.exec(line);
      if (!refundMatch || !twapMatch) return "unknown";
      if (refundMatch[1] === "true") return "refund";
      return twapMatch[1] === "Some" ? "twap" : "engine_last";
    } catch (err) {
      logger.warn("kind2 force-close: branch classification failed", {
        signature,
        err: String(err),
      });
      return "unknown";
    }
  }

  private buildIx(slab: string): TransactionInstruction {
    const data = encodeForceCloseKind2();
    // Account layout for tag 88: [caller(signer), slab(writable)].
    // Source-of-truth: `handle_force_close_kind2` line 18767-18324 of
    // the wrapper. The on-chain handler reads only these two accounts;
    // no clock account is passed because it's read via `Clock::get()`.
    const keys = [
      { pubkey: this.opts.payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(slab), isSigner: false, isWritable: true },
    ];
    return buildIx({ programId: this.opts.programId, keys, data });
  }

  private async submit(ix: TransactionInstruction): Promise<KeeperSendResult | null> {
    return keeperSend(
      this.opts.connection,
      [ix],
      [this.opts.payer],
      "crank",
      this.opts.budget,
    );
  }

  private handleSubmitError(slab: string, st: MarketState, err: unknown): void {
    const kind = classifyReject(err);
    if (kind === "race_loss") {
      // Another caller (backup keeper, MEV searcher, community member)
      // already fired. The market is correctly settled — we just
      // weren't the one who did it. Mark done; no alert.
      st.done = true;
      kind2ForceCloseRaceLossTotal.inc();
      logger.info("kind2 force-close: race lost cleanly", { slab });
      return;
    }
    if (kind === "paused") {
      // Operator pause is transient. Long backoff (60s) so we don't
      // spin while pause is investigated.
      kind2ForceCloseRejectTotal.inc({ reason: "paused" });
      st.nextEligibleMs = this.opts.now() + 60_000;
      return;
    }
    if (kind === "not_yet_eligible") {
      // Our local gate said the window was open but the chain disagrees.
      // Indicates >30s clock-drift between our host and the cluster.
      // Loud warning, short backoff, re-evaluate next tick.
      kind2ForceCloseRejectTotal.inc({ reason: "not_yet_eligible" });
      logger.warn("kind2 force-close: chain rejected as premature; clock drift?", { slab });
      st.nextEligibleMs = this.opts.now() + 15_000;
      return;
    }
    // Unclassified — standard exponential backoff.
    kind2ForceCloseRejectTotal.inc({ reason: "other" });
    st.consecFailures += 1;
    const expBackoff = 2_000 * Math.pow(2, Math.min(st.consecFailures, 5));
    st.nextEligibleMs = this.opts.now() + Math.min(expBackoff, this.opts.maxBackoffMs);
    logger.warn("kind2 force-close: submit failed", {
      slab,
      consec: st.consecFailures,
      err: String(err),
    });
  }

  private getState(entry: Kind2Entry): MarketState {
    let st = this.state.get(entry.slab);
    if (!st) {
      // Sample jitter once per market and persist. Re-rolling per-tick
      // would defeat HA-collision avoidance — two concurrent keepers
      // need different stable jitter values to dispatch at different
      // moments.
      st = {
        jitterSecs: Math.floor(Math.random() * this.opts.jitterMaxSecs),
        done: false,
        nextEligibleMs: 0,
        consecFailures: 0,
        inflight: false,
      };
      this.state.set(entry.slab, st);
    }
    return st;
  }
}
