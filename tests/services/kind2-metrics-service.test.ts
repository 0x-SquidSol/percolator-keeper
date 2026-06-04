/**
 * Behaviour tests for the kind=2 per-slab metrics service.
 *
 * Exercises `notePushSuccess()`, the refresh tick, and the registry-evict
 * cleanup that removes per-slab gauge label sets so retired markets do
 * not leave stale series on the dashboard forever.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Kind2MetricsService } from "../../src/services/kind2-metrics-service.js";
import {
  kind2LastPushAgeSecs,
  kind2TimeToForceCloseSecs,
} from "../../src/lib/metrics.js";
import type { Kind2Entry, ChangeListener } from "../../src/services/kind2-registry.js";

// ─── Test fixtures ──────────────────────────────────────────────────────

const seq = (start: number, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

function entryFor(slab: string, forceCloseUnixTimestamp: bigint): Kind2Entry {
  return {
    slab,
    programId: "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
    fields: {
      polymarketConditionId: seq(0x10, 32),
      oracleSource: 0,
      pythThresholdE6: 100_000_000_000n,
      pythScaleBpsPerPct: 100,
      valueDeviationBps: 500,
      forceCloseUnixTimestamp,
      forcedClosePriceE6: 0n,
      councilAuthority: seq(0x20, 32),
      metadataUriHash: seq(0x30, 32),
      linkedAtSlot: 1n,
    },
    pythFeedId: seq(0x40, 32),
    observedSlot: 100,
    source: "stream",
  };
}

/** Stub `Kind2Registry` that exposes a synthetic `list()` and a captured `onChange` callback. */
class StubRegistry {
  private items: Kind2Entry[] = [];
  private listener: ChangeListener | null = null;

  list(): Kind2Entry[] {
    return this.items;
  }

  set(entries: Kind2Entry[]): void {
    this.items = entries;
  }

  onChange(cb: ChangeListener): () => void {
    this.listener = cb;
    return () => {
      this.listener = null;
    };
  }

  fireEvict(slab: string): void {
    this.listener?.({ kind: "evict", slab, reason: "test" });
  }
}

function readGauge(
  gauge: typeof kind2LastPushAgeSecs | typeof kind2TimeToForceCloseSecs,
  slab: string,
): number | null {
  // prom-client exposes the underlying hashMap via the .hashMap property.
  // Each entry's value lives at `.value`.
  // Using a typed helper keeps the test free of `any` casts.
  const internal = gauge as unknown as {
    hashMap: Record<string, { value: number }>;
  };
  for (const key of Object.keys(internal.hashMap)) {
    if (key.includes(slab)) return internal.hashMap[key].value;
  }
  return null;
}

const SLAB_A = "11111111111111111111111111111111";
const SLAB_B = "22222222222222222222222222222222";

describe("Kind2MetricsService", () => {
  let registry: StubRegistry;
  let clock: { now: number };
  let svc: Kind2MetricsService;

  beforeEach(() => {
    registry = new StubRegistry();
    clock = { now: 1_780_000_000_000 };
    // Reset gauges so tests don't see leakage from prior tests.
    kind2LastPushAgeSecs.reset();
    kind2TimeToForceCloseSecs.reset();
    svc = new Kind2MetricsService({
      registry: registry as unknown as Parameters<typeof Kind2MetricsService>[0]["registry"],
      tickMs: 10_000,
      now: () => clock.now,
    });
  });

  it("refresh reports zero last-push-age for slabs that have never been pushed", () => {
    registry.set([entryFor(SLAB_A, 1_780_500_000n)]);
    svc.refresh();
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).toBe(0);
  });

  it("notePushSuccess + refresh ticks last-push-age upward as wall-clock advances", () => {
    registry.set([entryFor(SLAB_A, 1_780_500_000n)]);
    svc.notePushSuccess(SLAB_A);
    clock.now += 7_000;
    svc.refresh();
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).toBeCloseTo(7, 3);
  });

  it("time-to-force-close is signed; negative once the timestamp has passed", () => {
    // force_close_unix_timestamp = 1_780_000_000 (matches clock.now / 1000)
    // → time remaining ≈ 0 (initially)
    registry.set([entryFor(SLAB_A, 1_780_000_000n)]);
    svc.refresh();
    expect(readGauge(kind2TimeToForceCloseSecs, SLAB_A)).toBe(0);
    // Advance clock 30s past the force-close timestamp.
    clock.now += 30_000;
    svc.refresh();
    expect(readGauge(kind2TimeToForceCloseSecs, SLAB_A)).toBe(-30);
  });

  it("skips time-to-force-close emission for markets with zero timestamp", () => {
    registry.set([entryFor(SLAB_A, 0n)]);
    svc.refresh();
    expect(readGauge(kind2TimeToForceCloseSecs, SLAB_A)).toBeNull();
  });

  it("evict event clears per-slab gauge label sets so retired markets stop emitting", () => {
    registry.set([entryFor(SLAB_A, 1_780_500_000n), entryFor(SLAB_B, 1_780_500_000n)]);
    svc.start();
    svc.notePushSuccess(SLAB_A);
    svc.notePushSuccess(SLAB_B);
    svc.refresh();
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).not.toBeNull();
    expect(readGauge(kind2LastPushAgeSecs, SLAB_B)).not.toBeNull();
    // Slab A force-closes; registry emits evict.
    registry.fireEvict(SLAB_A);
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).toBeNull();
    expect(readGauge(kind2TimeToForceCloseSecs, SLAB_A)).toBeNull();
    // Slab B's series stays intact.
    expect(readGauge(kind2LastPushAgeSecs, SLAB_B)).not.toBeNull();
    svc.stop();
  });

  it("stop unsubscribes; subsequent evicts do not clear gauges", () => {
    registry.set([entryFor(SLAB_A, 1_780_500_000n)]);
    svc.start();
    svc.notePushSuccess(SLAB_A);
    svc.refresh();
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).not.toBeNull();
    svc.stop();
    registry.fireEvict(SLAB_A);
    // No subscriber → gauge series untouched.
    expect(readGauge(kind2LastPushAgeSecs, SLAB_A)).not.toBeNull();
  });

  it("start is idempotent", () => {
    svc.start();
    svc.start();
    svc.stop();
    // No exception = pass.
  });
});
