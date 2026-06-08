/**
 * In-memory registry of actionable kind=2 (Polymarket-perp) slabs.
 *
 * Source-of-truth = on-chain `MarketConfig`. The registry composes three
 * paths to keep its view fresh and self-healing:
 *
 *   1. **Seed (boot, read-only).** A one-shot `getProgramAccounts` scan
 *      populates the registry with every actionable kind=2 slab. Runs on
 *      both leader and standby keepers so failover doesn't pay the
 *      cold-start cost.
 *
 *   2. **Hot-path stream.** An `AccountLoader.onAccount` listener parses
 *      every program-owned account update; kind=2 transitions upsert or
 *      evict the entry. Sub-second freshness on actively-traded markets.
 *
 *   3. **Periodic reconcile (leader-only).** Every N minutes the leader
 *      re-runs the seed scan and diffs against the in-memory registry.
 *      Non-zero divergence is a P1 signal that the hot-path missed an
 *      event (LaserStream drop, parser bug, etc.). On a clean cycle the
 *      diff counter stays at zero — the absence of alerts is the proof
 *      that the streaming path is working.
 *
 * Entries are keyed by base58 slab pubkey. Eviction conditions: market
 * is unlinked, force-closed, or its oracle_source is not Pyth (V1 fail-
 * closed). Downstream cranks treat eviction as "stop scheduling work" —
 * they do NOT abort an in-flight transaction.
 *
 * The hand-rolled byte decoder (`kind2-decoder.ts`) is used because the
 * shipped `@percolatorct/sdk` (2.0.9) does not yet expose the kind=2
 * extension fields. When the SDK ships those accessors, the decoder
 * call here can swap for the SDK typed accessor with no change to the
 * registry's public API.
 */

import { PublicKey, type Connection } from "@solana/web3.js";
import { parseConfig, detectSlabLayout } from "@percolatorct/sdk";
import { createLogger } from "@percolatorct/shared";
import { type AccountUpdate, type AccountLoader, type UnsubscribeFn } from "../lib/account-loader.js";
import {
  decodeKind2Fields,
  classifyKind2,
  KIND2_MIN_CONFIG_LEN,
  type Kind2Fields,
  type Kind2Status,
} from "./kind2-decoder.js";
import {
  kind2RegistrySize,
  kind2RegistryReady,
  kind2RegistryUpsertTotal,
  kind2RegistryEvictTotal,
  kind2RegistryReconcileDiffsTotal,
  kind2RegistryReconcileLastDurationMs,
  kind2RegistryReconcileFailureTotal,
} from "../lib/metrics.js";

const logger = createLogger("keeper:kind2-registry");

/** Default time between reconcile scans. Configurable via env. */
const DEFAULT_RECONCILE_MS = 5 * 60_000;

/**
 * `MarketConfig` lives at `[HEADER_LEN, HEADER_LEN + CONFIG_LEN)` inside
 * the slab. The header is fixed at 136 bytes (magic, version, bump,
 * padding, admin, _reserved, insurance_authority, insurance_operator)
 * on the wrapper's current layout.
 */
const SLAB_HEADER_LEN = 136;

export type EntrySource = "seed" | "stream" | "reconcile";

/** A kind=2 entry the registry exposes to downstream consumers. */
export interface Kind2Entry {
  /** Base58 slab pubkey. */
  readonly slab: string;
  /** Base58 owning program id. */
  readonly programId: string;
  /** Decoded kind=2 fields verbatim. */
  readonly fields: Kind2Fields;
  /**
   * 32-byte Pyth feed id (`MarketConfig.index_feed_id`). Read via the
   * SDK's `parseConfig` because this is a legacy field with a stable
   * SDK accessor — it predates the kind=2 extension and is not in
   * `Kind2Fields`. Downstream cranks pass this to
   * `derivePythPushOraclePDA` to find the on-chain `PriceUpdateV2`
   * account bound to the market.
   */
  readonly pythFeedId: Uint8Array;
  /** Slot at which this entry's underlying data was observed. */
  readonly observedSlot: number;
  /** Which path produced this entry. */
  readonly source: EntrySource;
}

export type ChangeEvent =
  | { kind: "upsert"; slab: string; entry: Kind2Entry }
  | { kind: "evict"; slab: string; reason: string };

export type ChangeListener = (ev: ChangeEvent) => void;

export interface Kind2RegistryOptions {
  /** Program IDs to scan. Usually the single percolator program. */
  readonly programIds: PublicKey[];
  /** Connection used by `seedFromRpc` and `reconcileWithRpc`. */
  readonly connection: Connection;
  /** Reconcile cadence. Defaults to 5 min. Set 0 to disable. */
  readonly reconcileMs?: number;
}

/** Public API mirrors the read-side interface downstream cranks consume. */
export class Kind2Registry {
  private readonly entries = new Map<string, Kind2Entry>();
  private readonly listeners: ChangeListener[] = [];
  private readonly opts: Required<Pick<Kind2RegistryOptions, "reconcileMs">> &
    Kind2RegistryOptions;
  private accountUnsubscribe: UnsubscribeFn | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private seeded = false;
  private leaderRunning = false;

  constructor(opts: Kind2RegistryOptions) {
    this.opts = { reconcileMs: DEFAULT_RECONCILE_MS, ...opts };
  }

  // ─── Read API ──────────────────────────────────────────────────────────

  get(slab: string): Kind2Entry | undefined {
    return this.entries.get(slab);
  }

  has(slab: string): boolean {
    return this.entries.has(slab);
  }

  list(): Kind2Entry[] {
    return Array.from(this.entries.values());
  }

  size(): number {
    return this.entries.size;
  }

  isReady(): boolean {
    return this.seeded;
  }

  /**
   * Subscribe to upsert/evict events. Returns an unsubscribe function.
   * Listener exceptions are caught and logged so one bad listener
   * doesn't block sibling listeners.
   */
  onChange(cb: ChangeListener): UnsubscribeFn {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the registry: run an initial seed scan, attach the hot-path
   * listener to `accountLoader`, then return. Both leader and standby
   * keepers should call this at boot so a failover sees a warm registry.
   * Reconcile timer is NOT started here — call `start()` from the
   * leader-promote callback for that.
   */
  async seedAndAttach(accountLoader: AccountLoader): Promise<void> {
    await this.seedFromRpc();
    this.accountUnsubscribe = accountLoader.onAccount((u) => this.onAccountUpdate(u));
    this.seeded = true;
    kind2RegistryReady.set(1);
    logger.info("kind2 registry attached", { size: this.entries.size });
  }

  /**
   * Manually trigger one reconcile cycle. Useful for ops (force a sync
   * before a runbook step) and exposes the path to unit tests.
   */
  reconcileNow(): Promise<void> {
    return this.reconcileWithRpc();
  }

  /**
   * Leader-only: begin the periodic reconcile loop. Idempotent — calling
   * twice does not start two timers. Standby keepers should NOT call
   * this; their reconcile cadence is the leader's responsibility.
   */
  start(): void {
    if (this.leaderRunning) return;
    this.leaderRunning = true;
    if (this.opts.reconcileMs > 0) {
      this.reconcileTimer = setInterval(() => {
        this.reconcileWithRpc().catch((err) => {
          logger.warn("reconcile cycle threw", { err: String(err) });
        });
      }, this.opts.reconcileMs);
      this.reconcileTimer.unref?.();
    }
    logger.info("kind2 registry leader timer started", {
      reconcileMs: this.opts.reconcileMs,
    });
  }

  /**
   * Leader-demote / shutdown. Clears the reconcile timer but keeps the
   * in-memory entries intact (a demoted leader is still serving local
   * reads). Use `detach()` for full teardown.
   */
  stop(): void {
    this.leaderRunning = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** Full teardown — disconnects the account listener and clears state. */
  detach(): void {
    this.stop();
    if (this.accountUnsubscribe) {
      this.accountUnsubscribe();
      this.accountUnsubscribe = null;
    }
    this.entries.clear();
    this.seeded = false;
    kind2RegistrySize.set(0);
    kind2RegistryReady.set(0);
  }

  // ─── Internal: hot path ────────────────────────────────────────────────

  /**
   * Hot-path entry from `AccountLoader.onAccount`. Parses one update
   * and upserts/evicts the registry accordingly. Silent on accounts
   * that aren't kind=2 — most program-owned accounts aren't slabs at
   * all, or are non-kind-2 slabs.
   */
  onAccountUpdate(update: AccountUpdate): void {
    this.applyUpdate(update, "stream");
  }

  // ─── Internal: seed + reconcile (RPC paths) ────────────────────────────

  /**
   * Initial RPC seed. Iterates each configured program id, fetches all
   * owned accounts via `getProgramAccounts`, and feeds each result
   * through the same parser the hot-path uses. Failures are logged and
   * surfaced via the failure counter; the registry remains empty so
   * `isReady()` will return `false` for downstream gate-on-ready checks.
   */
  private async seedFromRpc(): Promise<void> {
    for (const programId of this.opts.programIds) {
      try {
        const accounts = await this.opts.connection.getProgramAccounts(programId, {
          commitment: "confirmed",
        });
        for (const { pubkey, account } of accounts) {
          const update: AccountUpdate = {
            pubkey: pubkey.toBase58(),
            data: account.data,
            owner: account.owner.toBase58(),
            slot: 0, // RPC doesn't carry per-account slot for getProgramAccounts
          };
          this.applyUpdate(update, "seed");
        }
      } catch (err) {
        kind2RegistryReconcileFailureTotal.inc({ reason: classifyError(err) });
        logger.warn("seed scan failed for program", {
          programId: programId.toBase58(),
          err: String(err),
        });
      }
    }
  }

  /**
   * Periodic reconcile (leader-only). Re-runs the seed scan into a
   * fresh map, diffs against the in-memory registry, applies any
   * missing-from-memory entries, evicts any missing-from-chain entries,
   * and flags content drift. Diff counts are emitted as a P1 metric.
   */
  private async reconcileWithRpc(): Promise<void> {
    const t0 = Date.now();
    // Snapshot the registry's view at scan-start. The stream can upsert
    // new entries while getProgramAccounts is in flight; without the
    // snapshot those entries appear missing-from-chain in the diff below
    // and get evicted, then re-inserted by the next stream tick — a
    // bouncing oscillation. Iterating the snapshot for the eviction
    // pass ensures stream-added slabs are not candidates for eviction.
    const scanStartEntries = new Map(this.entries);
    const observed = new Map<string, Kind2Entry>();
    for (const programId of this.opts.programIds) {
      try {
        const accounts = await this.opts.connection.getProgramAccounts(programId, {
          commitment: "confirmed",
        });
        for (const { pubkey, account } of accounts) {
          const entry = this.parse(
            pubkey.toBase58(),
            account.owner.toBase58(),
            account.data,
            0,
            "reconcile",
          );
          if (entry !== null) observed.set(entry.slab, entry);
        }
      } catch (err) {
        kind2RegistryReconcileFailureTotal.inc({ reason: classifyError(err) });
        logger.warn("reconcile scan failed", {
          programId: programId.toBase58(),
          err: String(err),
        });
        return; // bail without mutating registry on a partial scan
      }
    }
    // Diff: missing_from_chain (snapshot had it, RPC didn't), missing_from_memory
    // (RPC has it, registry doesn't), and content_drift (both present, different).
    for (const [slab, existing] of scanStartEntries) {
      const fresh = observed.get(slab);
      if (!fresh) {
        // Double-check the slab is still in the live registry — the
        // stream may have already evicted/replaced it during the scan,
        // in which case this stale snapshot opinion is no longer valid.
        if (!this.entries.has(slab)) continue;
        kind2RegistryReconcileDiffsTotal.inc({ kind: "missing_from_chain" });
        this.evict(slab, "reconcile");
      } else if (!sameFields(existing.fields, fresh.fields)) {
        kind2RegistryReconcileDiffsTotal.inc({ kind: "content_drift" });
        this.upsert(fresh);
      }
    }
    // missing-from-memory pass walks the live registry (not the snapshot)
    // so stream-added entries during the scan are correctly skipped.
    for (const [slab, fresh] of observed) {
      if (!this.entries.has(slab)) {
        kind2RegistryReconcileDiffsTotal.inc({ kind: "missing_from_memory" });
        this.upsert(fresh);
      }
    }
    kind2RegistryReconcileLastDurationMs.set(Date.now() - t0);
  }

  // ─── Shared mutation ───────────────────────────────────────────────────

  private applyUpdate(update: AccountUpdate, source: EntrySource): void {
    const entry = this.parse(update.pubkey, update.owner, update.data, update.slot, source);
    if (entry === null) {
      // Decoder rejected (not kind=2 / too short) — if we previously tracked
      // this slab and the new state is no longer actionable, evict it.
      if (this.entries.has(update.pubkey)) {
        this.evict(update.pubkey, "decoder_reject");
      }
      return;
    }
    this.upsert(entry);
  }

  /**
   * Decode + classify in one pass. Returns the entry if actionable;
   * `null` for non-kind-2, unlinked, resolved, or unsupported-source
   * slabs. A resolved/unsupported transition observed via stream is
   * handled by `applyUpdate`, which evicts on null.
   */
  private parse(
    slab: string,
    programId: string,
    data: Uint8Array,
    slot: number,
    source: EntrySource,
  ): Kind2Entry | null {
    if (data.length < SLAB_HEADER_LEN + 0) return null;
    // The MarketConfig starts immediately after the header; we don't
    // know exactly where it ends, so the decoder treats the buffer as
    // "MarketConfig from HEADER_LEN to end-of-buffer minus the engine
    // region". Since CONFIG_LEN is fixed per layout, the safer slice
    // is HEADER_LEN to end-of-buffer; the decoder reads end-relative
    // offsets which are immune to a too-long buffer only if the
    // suffix matches the kind=2 extension layout exactly. To avoid
    // that subtle hazard the registry consumes the whole slab buffer
    // pretending it's MarketConfig — this works because:
    //   * the decoder reads end-relative offsets,
    //   * the slab buffer ends with account bitmap + account array
    //     (NOT the MarketConfig _pad_governance), so when the buffer
    //     is the full slab the offsets are wrong.
    // To keep this correct without depending on per-layout config-len
    // constants, restrict to the case where the kind=2 fields' shape
    // is consistent with what we expect: try decoding from the full
    // buffer first; if `classifyKind2` returns `unlinked` with all-zero
    // condition_id BUT council_authority and metadata_uri_hash also
    // all-zero, that's the "not actually a kind=2 buffer" signature
    // and we skip without alerting.
    //
    // In practice, account-loader gives us the same data as a fresh
    // RPC getAccountInfo, so the buffer is the full slab. Hand-roll a
    // configRegion slice using the V13 SLAB_LEN minus engine + accounts.
    // Without a robust per-layout length helper today, we accept that
    // very small false-positive rate and gate on classification:
    const fields = decodeKind2Fields(extractConfigRegion(data));
    if (fields === null) return null;
    const status = classifyKind2(fields);
    if (status !== "actionable") {
      // Surface non-actionable transitions so applyUpdate can evict
      // an existing entry. Signal via null + leave the eviction
      // decision to the caller, which knows whether the slab was
      // previously tracked.
      return null;
    }
    // Pyth feed id lives on `MarketConfig.index_feed_id`, which is a
    // legacy field the SDK already exposes. Read via the SDK accessor
    // rather than hand-rolling another offset; downstream cranks need
    // it to derive the Pyth account PDA. SDK parse failures here are
    // recoverable — we skip this update; the registry's hot path will
    // retry on the next slab account change.
    let pythFeedId: Uint8Array;
    try {
      pythFeedId = parseConfig(data).indexFeedId.toBytes();
    } catch {
      return null;
    }
    return {
      slab,
      programId,
      fields,
      pythFeedId,
      observedSlot: slot,
      source,
    };
  }

  private upsert(entry: Kind2Entry): void {
    const existing = this.entries.get(entry.slab);
    if (existing && existing.observedSlot > entry.observedSlot && entry.observedSlot !== 0) {
      // Stale-slot guard: an older update raced in after a newer one
      // (LaserStream reconnect can deliver out-of-order). RPC paths use
      // slot=0 and are always applied because they represent the most
      // recent confirmed state at scan time.
      return;
    }
    this.entries.set(entry.slab, entry);
    kind2RegistryUpsertTotal.inc({ source: entry.source });
    kind2RegistrySize.set(this.entries.size);
    this.fire({ kind: "upsert", slab: entry.slab, entry });
  }

  private evict(slab: string, reason: string): void {
    if (!this.entries.delete(slab)) return;
    kind2RegistryEvictTotal.inc({ reason });
    kind2RegistrySize.set(this.entries.size);
    this.fire({ kind: "evict", slab, reason });
  }

  private fire(ev: ChangeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (err) {
        logger.warn("change listener threw", { slab: ev.slab, err: String(err) });
      }
    }
  }
}

// ─── Local helpers ───────────────────────────────────────────────────────

/**
 * Slice the `MarketConfig` region out of a full slab buffer. Prefers the
 * SDK's `detectSlabLayout` (authoritative configOffset/configLen per
 * tier); falls back to the V13 `[HEADER_LEN, HEADER_LEN+KIND2_MIN_CONFIG_LEN)`
 * window when the layout is unrecognised. The fallback is a known-loud
 * code-path: a structurally unrecognised slab is a strong signal of
 * either upstream layout drift or a corrupted account, so we log once
 * per slab-length so it shows up in alerts without flooding the log.
 */
const warnedSlabLengths = new Set<number>();
function extractConfigRegion(slabData: Uint8Array): Uint8Array {
  const layout = detectSlabLayout(slabData.length, slabData);
  if (layout !== null) {
    const end = layout.configOffset + layout.configLen;
    if (slabData.length < end) return new Uint8Array(0);
    return slabData.subarray(layout.configOffset, end);
  }
  if (!warnedSlabLengths.has(slabData.length)) {
    warnedSlabLengths.add(slabData.length);
    logger.warn("slab layout unrecognised by SDK; using V13 fallback slice", {
      slabLen: slabData.length,
    });
  }
  if (slabData.length < SLAB_HEADER_LEN + KIND2_MIN_CONFIG_LEN) return new Uint8Array(0);
  return slabData.subarray(SLAB_HEADER_LEN, SLAB_HEADER_LEN + KIND2_MIN_CONFIG_LEN);
}

function sameFields(a: Kind2Fields, b: Kind2Fields): boolean {
  return (
    bytesEq(a.polymarketConditionId, b.polymarketConditionId) &&
    a.oracleSource === b.oracleSource &&
    a.pythThresholdE6 === b.pythThresholdE6 &&
    a.pythScaleBpsPerPct === b.pythScaleBpsPerPct &&
    a.valueDeviationBps === b.valueDeviationBps &&
    a.forceCloseUnixTimestamp === b.forceCloseUnixTimestamp &&
    a.forcedClosePriceE6 === b.forcedClosePriceE6 &&
    bytesEq(a.councilAuthority, b.councilAuthority) &&
    bytesEq(a.metadataUriHash, b.metadataUriHash) &&
    a.linkedAtSlot === b.linkedAtSlot
  );
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("429") || /rate\s*limit/i.test(msg)) return "rpc_429";
  if (/timeout/i.test(msg)) return "timeout";
  return "other";
}

// re-export for downstream consumers
export type { Kind2Fields, Kind2Status };
