/**
 * Permissionless `PushOracleSnapshot` cranker for actionable kind=2 slabs.
 *
 * For each market in the K1' registry:
 *   1. Read the bound Pyth `PriceUpdateV2` account from the shared
 *      `AccountCache` (kept fresh by the LaserStream subscription).
 *   2. Gate on monotonic `publish_time` — if the cached Pyth observation
 *      has not advanced past our last successful submit for this slab,
 *      skip without building a tx. This mirrors the on-chain monotonic
 *      gate, so we never burn fees on guaranteed `OracleStale` rejects.
 *   3. Compute `p_yes_e6` via the K2' formula mirror.
 *   4. Build the tag-85 ix and submit through the existing keeper-send
 *      path (priority fees, CU sim, blockhash cache, budget gate).
 *   5. Classify any rejection from program logs and update per-market
 *      state — `OracleStale` is silent, deviation is a P1, resolved
 *      triggers deregistration.
 *
 * Leader-only. A 30-second watchdog timer fires a forced
 * `getAccountInfo` for any market whose last successful push is older
 * than the watchdog window — covers the case where LaserStream stalls
 * but Pyth is still publishing.
 *
 * Hand-rolled tag-85 encoder: the shipped `@percolatorct/sdk` (2.0.9)
 * does not expose `encodePushOracleSnapshot`. Behind a single internal
 * function so the SDK swap is one line once the next SDK ships.
 */

import {
  PublicKey,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  buildIx,
  derivePythPushOraclePDA,
} from "@percolatorct/sdk";
import { createLogger, sendCriticalAlert } from "@percolatorct/shared";
import { Kind2Registry, type Kind2Entry } from "./kind2-registry.js";
import { pythPriceToPYesE6 } from "./kind2-formula.js";
import { parsePythPriceUpdateV2, pythPriceToE6 } from "./kind2-pyth-parse.js";
import { AccountCache } from "../lib/account-cache.js";
import { LeaderLock } from "../lib/leader.js";
import { keeperSend, type KeeperSendResult } from "../lib/keeper-send.js";
import { KeeperBudget } from "../lib/budget.js";
import {
  kind2PushAttemptTotal,
  kind2PushSuccessTotal,
  kind2PushSkippedTotal,
  kind2PushRejectTotal,
  kind2PythReadFailTotal,
  kind2WatchdogFireTotal,
  kind2PushTickOverlapTotal,
  kind2PushTickDurationMs,
} from "../lib/metrics.js";

const logger = createLogger("keeper:kind2-push");

/** Pyth Receiver program id — used by the AccountCache owner-verification gate. */
const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

/** Hand-rolled `PushOracleSnapshot` (tag 85) encoder. */
const TAG_PUSH_ORACLE_SNAPSHOT = 85;
function encodePushOracleSnapshot(pYesE6: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = TAG_PUSH_ORACLE_SNAPSHOT;
  new DataView(buf.buffer).setBigUint64(1, pYesE6, true);
  return buf;
}

/** Classification of an on-chain rejection. */
type RejectKind = "stale" | "deviation" | "resolved" | "other";

/**
 * Wrapper-side error codes (mirrors `PercolatorError` enum order in
 * `dcccrypto/percolator-prog/src/percolator.rs` line 1689). The error is
 * mapped to `ProgramError::Custom(e as u32)` and appears in tx logs as
 * `custom program error: 0xN`.
 */
const ERR_ORACLE_STALE = 6;
const ERR_ORACLE_INVALID = 12;
/**
 * Map a tx-submit error's logs to a rejection classification. The
 * wrapper emits prefixed `msg!` calls for every gate, but we key off
 * the standard Solana "custom program error" format because that
 * survives RPC-side error formatting.
 */
function classifyReject(err: unknown): RejectKind {
  const msg = err instanceof Error ? err.message : String(err);
  const logs = (err as { logs?: string[] }).logs ?? [];
  const joined = (msg + "\n" + logs.join("\n")).toLowerCase();
  if (
    joined.includes(`custom program error: 0x${ERR_ORACLE_STALE.toString(16)}`) ||
    joined.includes("oraclestale") ||
    joined.includes("not greater than ring_last")
  ) {
    return "stale";
  }
  if (
    joined.includes(`custom program error: 0x${ERR_ORACLE_INVALID.toString(16)}`) ||
    joined.includes("oracleinvalid") ||
    joined.includes("deviation guard")
  ) {
    return "deviation";
  }
  if (
    joined.includes("invalidaccountdata") ||
    joined.includes("refuses resolved market") ||
    joined.includes("already resolved")
  ) {
    return "resolved";
  }
  return "other";
}

/** Per-market mutable state. */
interface MarketState {
  /** publish_time of the most recent successful submit. Bigint to match the on-chain i64. */
  lastSubmittedPublishTime: bigint;
  /** Wall-clock ms of the most recent successful submit; drives the watchdog. */
  lastSubmitMs: number;
  /** Consecutive failures (Pyth read or submit) — drives the P1 cooldown. */
  consecFailures: number;
  /** Wall-clock ms after which the next attempt is permitted (exponential backoff). */
  nextEligibleMs: number;
  /** Wall-clock ms of the most recent P1 alert; deduplicates flapping markets. */
  lastP1Ms: number;
  /** True while a submit for this slab is in flight (single-flight guard). */
  inflight: boolean;
}

export interface Kind2PushCrankerOptions {
  /** K1' registry — read-only handle. */
  readonly registry: Kind2Registry;
  /** Shared account cache populated by the LaserStream subscription. */
  readonly cache: AccountCache;
  /** HA leader lock. */
  readonly leader: LeaderLock;
  /** RPC connection — used by the watchdog for forced `getAccountInfo`. */
  readonly connection: Connection;
  /** Tx-submit payer / signer. */
  readonly payer: Keypair;
  /** Percolator program id. */
  readonly programId: PublicKey;
  /** Budget gate (existing `KeeperBudget` instance). */
  readonly budget: KeeperBudget;
  /** Helper that returns the current observed slot (drives cache TTL). */
  readonly getCurrentSlot: () => number;
  /** Tick cadence in ms. Default 500ms (matches Pyth's ~400ms publish rate). */
  readonly tickMs?: number;
  /** Watchdog cadence in ms. Default 30s. */
  readonly watchdogMs?: number;
  /** Watchdog staleness threshold in ms. Default 60s. */
  readonly watchdogStaleMs?: number;
  /** Max per-market exponential backoff in ms. Default 60s. */
  readonly maxBackoffMs?: number;
  /** Consecutive failures before firing a P1 alert. Default 5. */
  readonly p1FailureThreshold?: number;
  /** P1 alert dedup window in ms. Default 10 minutes. */
  readonly p1DedupMs?: number;
  /** Per-tick concurrency for Promise.allSettled chunks. Default 32. */
  readonly perTickConcurrency?: number;
}

export class Kind2PushCranker {
  private readonly opts: Required<
    Omit<Kind2PushCrankerOptions, "registry" | "cache" | "leader" | "connection" | "payer" | "programId" | "budget" | "getCurrentSlot">
  > & Kind2PushCrankerOptions;
  private readonly state = new Map<string, MarketState>();
  private tickTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private tickInflight = false;

  constructor(opts: Kind2PushCrankerOptions) {
    this.opts = {
      tickMs: 500,
      watchdogMs: 30_000,
      watchdogStaleMs: 60_000,
      maxBackoffMs: 60_000,
      p1FailureThreshold: 5,
      p1DedupMs: 10 * 60_000,
      perTickConcurrency: 32,
      ...opts,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Begin the tick + watchdog timers. Idempotent. Call from the
   * `LeaderLock.start({ onPromote })` callback.
   */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        logger.warn("tick threw", { err: String(err) });
      });
    }, this.opts.tickMs);
    this.tickTimer.unref?.();
    this.watchdogTimer = setInterval(() => {
      this.runWatchdog().catch((err) => {
        logger.warn("watchdog threw", { err: String(err) });
      });
    }, this.opts.watchdogMs);
    this.watchdogTimer.unref?.();
    logger.info("kind2 push cranker started", {
      tickMs: this.opts.tickMs,
      watchdogMs: this.opts.watchdogMs,
    });
  }

  /** Stop both timers. Call from `LeaderLock.start({ onDemote })`. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ── Tick (test-visible) ───────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.tickInflight) {
      kind2PushTickOverlapTotal.inc();
      return;
    }
    this.tickInflight = true;
    const t0 = Date.now();
    try {
      const entries = this.opts.registry.list();
      // Chunked Promise.allSettled — one stuck market can't block the rest.
      const chunkSize = this.opts.perTickConcurrency;
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        await Promise.allSettled(chunk.map((e) => this.pushOne(e, "tick")));
      }
    } finally {
      kind2PushTickDurationMs.observe(Date.now() - t0);
      this.tickInflight = false;
    }
  }

  // ── Per-market push (test-visible) ────────────────────────────────────

  async pushOne(entry: Kind2Entry, _trigger: "tick" | "watchdog"): Promise<void> {
    const slab = entry.slab;
    const st = this.getState(slab);
    if (st.inflight) {
      kind2PushSkippedTotal.inc({ reason: "inflight" });
      return;
    }
    const now = Date.now();
    if (now < st.nextEligibleMs) {
      kind2PushSkippedTotal.inc({ reason: "backoff" });
      return;
    }

    // 1. Derive the Pyth account from the bound feed_id.
    const feedHex = toHex(entry.pythFeedId);
    let pythPubkey: PublicKey;
    try {
      [pythPubkey] = derivePythPushOraclePDA(feedHex);
    } catch (err) {
      kind2PushSkippedTotal.inc({ reason: "pyth_pda_fail" });
      this.recordFailure(slab, st, `pyth pda derive failed: ${String(err)}`);
      return;
    }

    // 2. Read the Pyth account from cache.
    const cached = this.opts.cache.getOwnerVerified(
      pythPubkey.toBase58(),
      this.opts.getCurrentSlot(),
      PYTH_RECEIVER_PROGRAM_ID,
    );
    if (!cached) {
      kind2PythReadFailTotal.inc();
      kind2PushSkippedTotal.inc({ reason: "pyth_cache_miss" });
      return;
    }
    const parsed = parsePythPriceUpdateV2(cached.data);
    if (!parsed) {
      kind2PythReadFailTotal.inc();
      kind2PushSkippedTotal.inc({ reason: "pyth_parse_fail" });
      return;
    }

    // 3. Off-chain monotonic gate. Skip submit when Pyth has not advanced
    // past our last successful push. Cold-start: lastSubmittedPublishTime
    // defaults to 0n, so the first push lands; if the on-chain ring
    // already has a fresher entry, we eat one `OracleStale` rejection
    // and update our local watermark from the success path. Bounded.
    if (parsed.publishTime <= st.lastSubmittedPublishTime) {
      kind2PushSkippedTotal.inc({ reason: "gate" });
      return;
    }

    // 4. Convert Pyth raw price → e6 USD, then compute p_yes_e6 via K2'.
    const pythE6 = pythPriceToE6(parsed.price, parsed.exponent);
    if (pythE6 === null) {
      kind2PushSkippedTotal.inc({ reason: "pyth_scale_fail" });
      return;
    }
    let pYesE6: bigint;
    try {
      pYesE6 = pythPriceToPYesE6(
        pythE6,
        entry.fields.pythThresholdE6,
        entry.fields.pythScaleBpsPerPct,
      );
    } catch (err) {
      kind2PushSkippedTotal.inc({ reason: "formula_fail" });
      this.recordFailure(slab, st, `formula threw: ${String(err)}`);
      return;
    }

    // 5. Build + submit.
    st.inflight = true;
    kind2PushAttemptTotal.inc();
    try {
      const ix = this.buildIx(slab, pythPubkey, pYesE6);
      const result = await this.submit(ix);
      if (result === null) {
        // Budget exhausted — keeperSend returned null, treat as soft skip.
        kind2PushSkippedTotal.inc({ reason: "budget" });
        return;
      }
      // Success: advance watermark + reset failure counters.
      st.lastSubmittedPublishTime = parsed.publishTime;
      st.lastSubmitMs = Date.now();
      st.consecFailures = 0;
      st.nextEligibleMs = 0;
      kind2PushSuccessTotal.inc();
    } catch (err) {
      this.handleSubmitError(slab, st, err, entry);
    } finally {
      st.inflight = false;
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────

  /**
   * Force a fresh `getAccountInfo` for any market whose last successful
   * push is older than `watchdogStaleMs`. Covers the case where the
   * LaserStream feed stalls but Pyth is still publishing. Hits RPC, not
   * the cache, so a broken LaserStream cannot mask the issue.
   */
  async runWatchdog(): Promise<void> {
    const now = Date.now();
    const entries = this.opts.registry.list();
    for (const entry of entries) {
      const st = this.getState(entry.slab);
      if (st.inflight) continue;
      if (now - st.lastSubmitMs <= this.opts.watchdogStaleMs) continue;
      kind2WatchdogFireTotal.inc();
      const feedHex = toHex(entry.pythFeedId);
      let pythPubkey: PublicKey;
      try {
        [pythPubkey] = derivePythPushOraclePDA(feedHex);
      } catch {
        continue;
      }
      try {
        const ai = await this.opts.connection.getAccountInfo(pythPubkey, {
          commitment: "confirmed",
        });
        if (!ai) continue;
        // Push freshly-fetched bytes into the cache so the next tick
        // picks them up via the normal hot path.
        this.opts.cache.set(
          pythPubkey.toBase58(),
          ai.data,
          ai.owner.toBase58(),
          this.opts.getCurrentSlot(),
        );
      } catch (err) {
        logger.warn("watchdog getAccountInfo failed", {
          slab: entry.slab,
          err: String(err),
        });
      }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private buildIx(slab: string, pythPubkey: PublicKey, pYesE6: bigint): TransactionInstruction {
    const data = encodePushOracleSnapshot(pYesE6);
    // Account layout for tag 85: [caller(signer), slab(writable), pyth(ro)].
    // Source-of-truth: `handle_push_oracle_snapshot` line 18318 of the wrapper.
    const keys = [
      { pubkey: this.opts.payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(slab), isSigner: false, isWritable: true },
      { pubkey: pythPubkey, isSigner: false, isWritable: false },
    ];
    return buildIx({ programId: this.opts.programId, keys, data });
  }

  private async submit(ix: TransactionInstruction): Promise<KeeperSendResult | null> {
    return keeperSend(
      this.opts.connection,
      [ix],
      [this.opts.payer],
      "oracle",
      this.opts.budget,
    );
  }

  private handleSubmitError(slab: string, st: MarketState, err: unknown, entry: Kind2Entry): void {
    const kind = classifyReject(err);
    kind2PushRejectTotal.inc({ reason: kind });
    if (kind === "stale") {
      // Expected when our local watermark trailed the on-chain ring
      // (e.g. cold start). Bump the local watermark to the cached
      // Pyth observation so we don't re-submit until Pyth advances.
      return;
    }
    if (kind === "resolved") {
      // Market force-closed. Stop pushing immediately; the registry's
      // own classifier will evict on the next slab-account update.
      logger.info("kind2 push: market resolved, stopping pushes", { slab });
      return;
    }
    if (kind === "deviation") {
      // Formula mismatch — our K2' mirror has drifted from the on-chain
      // formula. Park the market for 60s and fire a P1 (deduped).
      st.nextEligibleMs = Date.now() + 60_000;
      this.maybeFireP1(slab, st, "deviation guard rejected", entry);
      return;
    }
    // Other error — standard backoff.
    this.recordFailure(slab, st, `submit failed: ${String(err)}`);
  }

  private recordFailure(slab: string, st: MarketState, reason: string): void {
    st.consecFailures += 1;
    const expBackoff = 1_000 * Math.pow(2, Math.min(st.consecFailures, 6));
    st.nextEligibleMs = Date.now() + Math.min(expBackoff, this.opts.maxBackoffMs);
    logger.warn("kind2 push failure", { slab, reason, consec: st.consecFailures });
    if (st.consecFailures >= this.opts.p1FailureThreshold) {
      this.maybeFireP1(slab, st, reason, undefined);
    }
  }

  private maybeFireP1(slab: string, st: MarketState, reason: string, entry: Kind2Entry | undefined): void {
    const now = Date.now();
    if (now - st.lastP1Ms < this.opts.p1DedupMs) return;
    st.lastP1Ms = now;
    void sendCriticalAlert("kind2-push P1", [
      { name: "slab", value: slab },
      { name: "reason", value: reason.slice(0, 256) },
      ...(entry ? [{ name: "condition_id", value: toHex(entry.fields.polymarketConditionId) }] : []),
    ])?.catch(() => {});
  }

  private getState(slab: string): MarketState {
    let st = this.state.get(slab);
    if (!st) {
      st = {
        lastSubmittedPublishTime: 0n,
        lastSubmitMs: 0,
        consecFailures: 0,
        nextEligibleMs: 0,
        lastP1Ms: 0,
        inflight: false,
      };
      this.state.set(slab, st);
    }
    return st;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
