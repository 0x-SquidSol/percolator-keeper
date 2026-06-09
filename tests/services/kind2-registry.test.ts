/**
 * Kind=2 registry service tests.
 *
 * Cover the hot-path stream behaviour end-to-end: synthesise slab
 * buffers via the same fixture pattern the decoder tests use, push
 * them through a mock `AccountLoader.onAccount`, and assert the
 * registry's public API responds correctly.
 *
 * RPC paths (seedFromRpc, reconcileWithRpc) are exercised against an
 * in-memory Connection-like that returns a programmable set of
 * `getProgramAccounts` results.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PublicKey, type Connection } from "@solana/web3.js";
import { Kind2Registry, type Kind2Entry, type ChangeEvent } from "../../src/services/kind2-registry.js";
import { KIND2_MIN_CONFIG_LEN } from "../../src/services/kind2-decoder.js";
import type { AccountLoader, AccountUpdate, UnsubscribeFn } from "../../src/lib/account-loader.js";

// Header length the registry trims before passing bytes to the decoder.
// Mirrors `SLAB_HEADER_LEN` in `kind2-registry.ts`.
const SLAB_HEADER_LEN = 136;

const PROGRAM_ID = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");

/**
 * Build a synthetic full-slab buffer: 136 header bytes + at least
 * KIND2_MIN_CONFIG_LEN config bytes, with kind=2 extension fields
 * written at the canonical end-relative offsets.
 */
function buildSlab(overrides: {
  polymarketConditionId?: Uint8Array;
  oracleSource?: number;
  pythThresholdE6?: bigint;
  pythScaleBpsPerPct?: number;
  valueDeviationBps?: number;
  forceCloseUnixTimestamp?: bigint;
  forcedClosePriceE6?: bigint;
  councilAuthority?: Uint8Array;
  metadataUriHash?: Uint8Array;
  linkedAtSlot?: bigint;
} = {}): Uint8Array {
  const slab = new Uint8Array(SLAB_HEADER_LEN + KIND2_MIN_CONFIG_LEN);
  const view = new DataView(slab.buffer);
  const end = slab.length;

  if (overrides.polymarketConditionId) {
    slab.set(overrides.polymarketConditionId, end - 1600);
  }
  if (overrides.oracleSource !== undefined) {
    view.setUint8(end - 1568, overrides.oracleSource);
  }
  if (overrides.pythThresholdE6 !== undefined) {
    view.setBigUint64(end - 112, overrides.pythThresholdE6, true);
  }
  if (overrides.pythScaleBpsPerPct !== undefined) {
    view.setInt32(end - 104, overrides.pythScaleBpsPerPct, true);
  }
  if (overrides.valueDeviationBps !== undefined) {
    view.setUint16(end - 100, overrides.valueDeviationBps, true);
  }
  if (overrides.forceCloseUnixTimestamp !== undefined) {
    view.setBigInt64(end - 96, overrides.forceCloseUnixTimestamp, true);
  }
  if (overrides.forcedClosePriceE6 !== undefined) {
    view.setBigUint64(end - 88, overrides.forcedClosePriceE6, true);
  }
  if (overrides.councilAuthority) {
    slab.set(overrides.councilAuthority, end - 80);
  }
  if (overrides.metadataUriHash) {
    slab.set(overrides.metadataUriHash, end - 48);
  }
  if (overrides.linkedAtSlot !== undefined) {
    view.setBigUint64(end - 16, overrides.linkedAtSlot, true);
  }
  return slab;
}

const seq = (start: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);

const SLAB_A = new PublicKey(new Uint8Array(32).fill(1));
const SLAB_B = new PublicKey(new Uint8Array(32).fill(2));

function actionableSlabBytes(): Uint8Array {
  return buildSlab({
    polymarketConditionId: seq(0xa0),
    oracleSource: 0,
    pythThresholdE6: 150_000_000_000n,
    pythScaleBpsPerPct: 5_000,
    valueDeviationBps: 500,
    forceCloseUnixTimestamp: 1_780_000_000n,
    forcedClosePriceE6: 0n,
    councilAuthority: seq(0xb0),
    metadataUriHash: seq(0xc0),
    linkedAtSlot: 1_000n,
  });
}

function makeUpdate(pubkey: PublicKey, data: Uint8Array, slot = 0): AccountUpdate {
  return {
    pubkey: pubkey.toBase58(),
    data,
    owner: PROGRAM_ID.toBase58(),
    slot,
  };
}

/** Mock AccountLoader exposing a `fireUpdate` hook for tests. */
class FakeLoader {
  private listener: ((u: AccountUpdate) => void) | null = null;
  onAccount(cb: (u: AccountUpdate) => void): UnsubscribeFn {
    this.listener = cb;
    return () => { this.listener = null; };
  }
  fireUpdate(u: AccountUpdate): void { this.listener?.(u); }
  asLoader(): AccountLoader {
    // Cast: the real AccountLoader has many more methods; the registry
    // only consumes `onAccount`.
    return this as unknown as AccountLoader;
  }
}

/** Mock Connection that returns a programmable account list. */
function mockConnection(
  fixtures: Array<{ pubkey: PublicKey; data: Uint8Array }>,
): Connection {
  return {
    getProgramAccounts: vi.fn(async () =>
      fixtures.map(({ pubkey, data }) => ({
        pubkey,
        account: {
          data,
          owner: PROGRAM_ID,
          executable: false,
          lamports: 1,
        },
      })),
    ),
  } as unknown as Connection;
}

describe("Kind2Registry — hot path", () => {
  let loader: FakeLoader;
  let registry: Kind2Registry;

  beforeEach(async () => {
    loader = new FakeLoader();
    registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: mockConnection([]),
      reconcileMs: 0,
    });
    await registry.seedAndAttach(loader.asLoader());
  });

  it("upserts on actionable update and exposes via get()", () => {
    const evs: ChangeEvent[] = [];
    registry.onChange((ev) => evs.push(ev));
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes(), 100));
    expect(registry.size()).toBe(1);
    const entry = registry.get(SLAB_A.toBase58())!;
    expect(entry.fields.oracleSource).toBe(0);
    expect(entry.fields.pythThresholdE6).toBe(150_000_000_000n);
    expect(entry.fields.linkedAtSlot).toBe(1_000n);
    expect(entry.source).toBe("stream");
    expect(entry.observedSlot).toBe(100);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "upsert", slab: SLAB_A.toBase58() });
  });

  it("ignores updates with non-Pyth oracle_source (V1 fail-closed)", () => {
    const bytes = buildSlab({
      polymarketConditionId: seq(0x11),
      oracleSource: 1,
      pythThresholdE6: 1n,
      valueDeviationBps: 100,
      linkedAtSlot: 1n,
    });
    loader.fireUpdate(makeUpdate(SLAB_A, bytes));
    expect(registry.size()).toBe(0);
  });

  it("evicts a previously-tracked slab once it goes resolved", () => {
    const evs: ChangeEvent[] = [];
    registry.onChange((ev) => evs.push(ev));
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes()));
    expect(registry.size()).toBe(1);
    // Same slab, now force-closed.
    const resolved = buildSlab({
      polymarketConditionId: seq(0xa0),
      oracleSource: 0,
      pythThresholdE6: 150_000_000_000n,
      forcedClosePriceE6: 420_000n,
      linkedAtSlot: 1_000n,
    });
    loader.fireUpdate(makeUpdate(SLAB_A, resolved));
    expect(registry.size()).toBe(0);
    expect(evs.find((e) => e.kind === "evict")).toMatchObject({
      kind: "evict",
      slab: SLAB_A.toBase58(),
    });
  });

  it("does NOT evict on an update for a slab we don't track", () => {
    const evs: ChangeEvent[] = [];
    registry.onChange((ev) => evs.push(ev));
    // Send a resolved-state update for a slab we never registered.
    const resolved = buildSlab({
      polymarketConditionId: seq(0xff),
      forcedClosePriceE6: 1n,
    });
    loader.fireUpdate(makeUpdate(SLAB_B, resolved));
    expect(registry.size()).toBe(0);
    expect(evs).toHaveLength(0);
  });

  it("stale-slot updates are silently dropped", () => {
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes(), 200));
    const newer = registry.get(SLAB_A.toBase58())!;
    expect(newer.observedSlot).toBe(200);
    // Same content but older slot — should be ignored.
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes(), 100));
    expect(registry.get(SLAB_A.toBase58())!.observedSlot).toBe(200);
  });

  it("listener exceptions do not propagate", () => {
    registry.onChange(() => { throw new Error("listener crash"); });
    expect(() => loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes()))).not.toThrow();
    expect(registry.size()).toBe(1);
  });

  it("detach() clears state and removes the listener", () => {
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes()));
    expect(registry.size()).toBe(1);
    registry.detach();
    expect(registry.size()).toBe(0);
    expect(registry.isReady()).toBe(false);
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes()));
    expect(registry.size()).toBe(0); // listener detached
  });
});

describe("Kind2Registry — seed + reconcile", () => {
  it("seedFromRpc populates the registry from getProgramAccounts", async () => {
    const conn = mockConnection([
      { pubkey: SLAB_A, data: actionableSlabBytes() },
    ]);
    const registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: conn,
      reconcileMs: 0,
    });
    const loader = new FakeLoader();
    await registry.seedAndAttach(loader.asLoader());
    expect(registry.size()).toBe(1);
    expect(registry.isReady()).toBe(true);
    expect(registry.get(SLAB_A.toBase58())!.source).toBe("seed");
  });

  it("seed skips non-actionable accounts (resolved / unlinked)", async () => {
    const resolved = buildSlab({
      polymarketConditionId: seq(0xff),
      forcedClosePriceE6: 1n,
    });
    const unlinked = buildSlab({}); // all-zero
    const conn = mockConnection([
      { pubkey: SLAB_A, data: resolved },
      { pubkey: SLAB_B, data: unlinked },
    ]);
    const registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: conn,
      reconcileMs: 0,
    });
    await registry.seedAndAttach(new FakeLoader().asLoader());
    expect(registry.size()).toBe(0);
    expect(registry.isReady()).toBe(true);
  });
});

describe("Kind2Registry — reconcile vs stream race", () => {
  it("does not evict a slab that the stream inserts while reconcile is in flight", async () => {
    // Regression for the stream-vs-reconcile race:
    //   1. Reconcile snapshots `this.entries` (empty) and starts the RPC fetch.
    //   2. Stream fires an upsert for SLAB_A *during* the fetch.
    //   3. RPC returns with NO accounts (the stream observation hasn't yet
    //      reached the RPC's "confirmed" view).
    //   4. Pre-fix: the diff walked `this.entries`, saw SLAB_A as
    //      missing-from-chain, evicted it. Stream re-inserts on next tick.
    //   5. Post-fix: the diff walks the scan-start SNAPSHOT (which was empty),
    //      so SLAB_A is not a candidate for eviction at all.
    const loader = new FakeLoader();

    // First call (seed) returns empty immediately; subsequent calls
    // (reconcile) block on the deferred so the stream can race with them.
    let callCount = 0;
    let resolveRpc: () => void = () => {};
    const rpcReady = new Promise<void>((r) => { resolveRpc = r; });
    const conn = {
      getProgramAccounts: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return []; // seed
        await rpcReady;
        return []; // reconcile sees no accounts
      }),
    } as unknown as Connection;

    const registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: conn,
      reconcileMs: 0,
    });
    await registry.seedAndAttach(loader.asLoader());
    expect(registry.size()).toBe(0);

    // Kick off a reconcile but do NOT await yet — the RPC is gated.
    const reconcilePromise = registry.reconcileNow();

    // Yield once so reconcile reaches the await inside getProgramAccounts.
    await Promise.resolve();

    // Stream fires while reconcile is mid-flight.
    loader.fireUpdate(makeUpdate(SLAB_A, actionableSlabBytes(), 100));
    expect(registry.size()).toBe(1);

    // Release the RPC (returns empty); let reconcile finish.
    resolveRpc();
    await reconcilePromise;

    // The stream-inserted slab must still be there. Pre-fix this was 0.
    expect(registry.size()).toBe(1);
    expect(registry.get(SLAB_A.toBase58())).toBeTruthy();
  });

  it("coalesces concurrent reconcileNow() callers onto a single RPC scan", async () => {
    // Without coalescing, ops calling reconcileNow() while the periodic
    // timer is mid-scan kicks off a second getProgramAccounts and a
    // parallel diff pass — double-counting metrics and re-introducing
    // the stream-vs-reconcile race in a new shape. With the inflight
    // promise gate, both callers await the same scan.
    const loader = new FakeLoader();
    let callCount = 0;
    let resolveRpc: () => void = () => {};
    const rpcReady = new Promise<void>((r) => { resolveRpc = r; });
    const conn = {
      getProgramAccounts: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return []; // seed
        await rpcReady;
        return [];
      }),
    } as unknown as Connection;

    const registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: conn,
      reconcileMs: 0,
    });
    await registry.seedAndAttach(loader.asLoader());
    const callsAfterSeed = callCount;

    // Three reconciles in rapid succession; the first gates on rpcReady,
    // the next two must coalesce onto the same in-flight promise.
    const p1 = registry.reconcileNow();
    const p2 = registry.reconcileNow();
    const p3 = registry.reconcileNow();
    await Promise.resolve();

    // Only ONE additional getProgramAccounts has fired despite three calls.
    expect(callCount - callsAfterSeed).toBe(1);

    resolveRpc();
    await Promise.all([p1, p2, p3]);

    // Still only one — the coalesced callers all resolved off the same scan.
    expect(callCount - callsAfterSeed).toBe(1);

    // After the in-flight clears, a fresh reconcile must launch a new scan.
    let resolveRpc2: () => void = () => {};
    const rpcReady2 = new Promise<void>((r) => { resolveRpc2 = r; });
    (conn.getProgramAccounts as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      callCount++;
      await rpcReady2;
      return [];
    });
    const p4 = registry.reconcileNow();
    await Promise.resolve();
    expect(callCount - callsAfterSeed).toBe(2);
    resolveRpc2();
    await p4;
  });
});

describe("Kind2Registry — full-slab decoder slice", () => {
  // Regression guard: production slabs carry CONFIG + engine + risk_buf +
  // gen_table (tens of KB). The decoder reads end-relative offsets that
  // are only valid against the CONFIG region; slicing to end-of-buffer
  // makes every field read from gen_table garbage. Buffer kind=2 fields
  // at end-of-CONFIG (NOT end-of-buffer) and trailing bytes are non-zero
  // garbage — both conditions are required to catch the original bug.
  function buildFullSlab(overrides: Parameters<typeof buildSlab>[0] = {}): Uint8Array {
    const config = buildSlab(overrides);
    const trailingLen = 8 * 1024; // representative engine+risk_buf+gen_table
    const full = new Uint8Array(config.length + trailingLen);
    full.set(config, 0);
    for (let i = config.length; i < full.length; i++) {
      full[i] = (i & 0xff) || 0x77; // non-zero garbage so a wrong slice fails loudly
    }
    return full;
  }

  it("decodes kind=2 fields correctly when slab carries engine+gen_table suffix", () => {
    const loader = new FakeLoader();
    const registry = new Kind2Registry({
      programIds: [PROGRAM_ID],
      connection: mockConnection([]),
      reconcileMs: 0,
    });
    // Sync seed-then-attach for the test harness.
    return registry.seedAndAttach(loader.asLoader()).then(() => {
      const bytes = buildFullSlab({
        polymarketConditionId: seq(0xa0),
        oracleSource: 0,
        pythThresholdE6: 150_000_000_000n,
        pythScaleBpsPerPct: 5_000,
        valueDeviationBps: 500,
        forceCloseUnixTimestamp: 1_780_000_000n,
        forcedClosePriceE6: 0n,
        councilAuthority: seq(0xb0),
        metadataUriHash: seq(0xc0),
        linkedAtSlot: 1_000n,
      });
      loader.fireUpdate(makeUpdate(SLAB_A, bytes, 100));
      expect(registry.size()).toBe(1);
      const entry = registry.get(SLAB_A.toBase58())!;
      expect(entry.fields.oracleSource).toBe(0);
      expect(entry.fields.pythThresholdE6).toBe(150_000_000_000n);
      expect(entry.fields.linkedAtSlot).toBe(1_000n);
      // Field values would be unrecognisable garbage if the slice still
      // extended to end-of-buffer.
      expect(Array.from(entry.fields.polymarketConditionId)).toEqual(
        Array.from(seq(0xa0)),
      );
    });
  });
});
