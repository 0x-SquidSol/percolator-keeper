/**
 * Per-slab observability service for the kind=2 keeper stack.
 *
 * Owns the two per-slab gauges that visualize this keeper's contribution
 * to each market's lifecycle:
 *
 *   * `kind2_last_push_age_secs{slab}` — seconds since this keeper's
 *     last successful `PushOracleSnapshot` for the slab. Reset to 0 on
 *     a confirmed submit (via `notePushSuccess`); advanced by the
 *     periodic refresh tick. NOT the on-chain ring's authoritative
 *     freshness — that's the ring's own concern. This measures whether
 *     OUR cranker is doing its job per market.
 *
 *   * `kind2_time_to_force_close_secs{slab}` — countdown to each
 *     market's `force_close_unix_timestamp`. Goes negative once the
 *     timestamp has elapsed but the force-close cranker has not yet
 *     fired (typically a short window — post-buffer + jitter).
 *
 * The service subscribes to the registry's `onChange` events. On
 * eviction, it clears both gauge labels for the retired slab via
 * `prom-client`'s `gauge.remove({ slab })`. Without this cleanup,
 * force-closed markets would keep emitting forever-growing stale
 * series and any alert hung off these gauges would become noisy.
 *
 * The service runs on BOTH leader and standby keepers. The gauges are
 * "what this keeper sees" — telemetry is per-process, not per-leader.
 * `notePushSuccess` is fire-and-forget so the cranker hot path stays
 * unchanged in latency-critical paths.
 */

import { createLogger } from "@percolatorct/shared";
import { Kind2Registry } from "./kind2-registry.js";
import { type UnsubscribeFn } from "../lib/account-loader.js";
import {
  kind2LastPushAgeSecs,
  kind2TimeToForceCloseSecs,
} from "../lib/metrics.js";

const logger = createLogger("keeper:kind2-metrics");

/** Default time between gauge refresh ticks. 5s is fine — these gauges
 *  drive humans-watching-Grafana, not millisecond-latency consumers. */
const DEFAULT_TICK_MS = 5_000;

export interface Kind2MetricsServiceOptions {
  readonly registry: Kind2Registry;
  /** Refresh cadence in ms. Default 5_000. */
  readonly tickMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class Kind2MetricsService {
  private readonly opts: Required<Kind2MetricsServiceOptions>;
  /** Map of slab → wall-clock ms of this keeper's last successful push. */
  private readonly lastPushMs = new Map<string, number>();
  private tickTimer: NodeJS.Timeout | null = null;
  private unsubscribe: UnsubscribeFn | null = null;

  constructor(opts: Kind2MetricsServiceOptions) {
    this.opts = {
      tickMs: DEFAULT_TICK_MS,
      now: Date.now,
      ...opts,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.tickTimer) return;
    // Subscribe before the first tick so we never miss an eviction
    // during the boot window. The handler clears the slab's gauge
    // labels so retired markets stop polluting the dashboard.
    this.unsubscribe = this.opts.registry.onChange((ev) => {
      if (ev.kind === "evict") {
        this.lastPushMs.delete(ev.slab);
        kind2LastPushAgeSecs.remove({ slab: ev.slab });
        kind2TimeToForceCloseSecs.remove({ slab: ev.slab });
      }
    });
    this.tickTimer = setInterval(() => {
      try {
        this.refresh();
      } catch (err) {
        logger.warn("metrics tick threw", { err: String(err) });
      }
    }, this.opts.tickMs);
    this.tickTimer.unref?.();
    logger.info("kind2 metrics service started", { tickMs: this.opts.tickMs });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // ── Push-success hook ─────────────────────────────────────────────────

  /**
   * Called by the K3' push cranker after a confirmed `PushOracleSnapshot`.
   * O(1); does not block the cranker's hot path. The gauge's actual
   * value is updated by the next refresh tick — this just stamps the
   * timestamp.
   */
  notePushSuccess(slab: string): void {
    this.lastPushMs.set(slab, this.opts.now());
  }

  // ── Refresh (test-visible) ────────────────────────────────────────────

  /**
   * Walk the registry once and update both gauges for every actionable
   * market. Cheap: registry.list() is in-memory and the per-slab cost
   * is two `gauge.set` calls + a `bigint → number` conversion.
   *
   * For markets we've never pushed for, `last_push_age_secs` is set to
   * `0` rather than left absent — gives Grafana a stable series so
   * alerts on "age > threshold" don't fire on absent data.
   */
  refresh(): void {
    const nowMs = this.opts.now();
    const nowSecs = Math.floor(nowMs / 1000);
    for (const entry of this.opts.registry.list()) {
      const last = this.lastPushMs.get(entry.slab);
      const ageSecs = last === undefined ? 0 : (nowMs - last) / 1000;
      kind2LastPushAgeSecs.set({ slab: entry.slab }, ageSecs);

      const fcTs = entry.fields.forceCloseUnixTimestamp;
      if (fcTs > 0n) {
        // `bigint → number` is safe: unix seconds fit well below
        // Number.MAX_SAFE_INTEGER (year ~9999+).
        kind2TimeToForceCloseSecs.set(
          { slab: entry.slab },
          Number(fcTs) - nowSecs,
        );
      }
    }
  }
}
