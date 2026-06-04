/**
 * Hot-path behaviour tests for the kind=2 force-close cranker.
 *
 * Exercises the cranker's `tick()`, `isEligibleForFire()`, and
 * `fireOne()` paths against a stub registry and a mocked keeper-send.
 * Covers the eligibility predicate (jitter + post-buffer + done flag),
 * the three rejection classifications (race-loss / paused /
 * not-yet-eligible), and the one-shot-per-market semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { Kind2ForceCloseCranker } from "../../src/services/kind2-force-close-cranker.js";
import type { Kind2Entry } from "../../src/services/kind2-registry.js";

// ─── Mock collaborators ────────────────────────────────────────────────

const sendMock = vi.fn();
vi.mock("../../src/lib/keeper-send.js", () => ({
  keeperSend: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    buildIx: ({ programId, keys, data }: {
      programId: PublicKey;
      keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
      data: Uint8Array;
    }) => ({ programId, keys, data }),
  };
});

vi.mock("@percolatorct/shared", () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  }),
}));

// ─── Test fixtures ──────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");
const SLAB_A = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

const seq = (start: number, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

function entryFor(slab: string, forceCloseUnixTimestamp: bigint): Kind2Entry {
  return {
    slab,
    programId: PROGRAM_ID.toBase58(),
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

class StubRegistry {
  private items: Kind2Entry[] = [];
  list(): Kind2Entry[] { return this.items; }
  set(entries: Kind2Entry[]): void { this.items = entries; }
}

function makeConnection(): Connection {
  return {} as unknown as Connection;
}

function makeCranker(opts: {
  registry: StubRegistry;
  now?: () => number;
  jitterMaxSecs?: number;
}): Kind2ForceCloseCranker {
  return new Kind2ForceCloseCranker({
    registry: opts.registry as unknown as Parameters<typeof Kind2ForceCloseCranker>[0]["registry"],
    connection: makeConnection(),
    payer: Keypair.generate(),
    programId: PROGRAM_ID,
    budget: { canSpend: () => true, recordTx: () => {}, getStats: () => ({}) } as never,
    tickMs: 10_000,
    postBufferSecs: 30,
    // Force jitter to 0 in eligibility tests so we can assert exact timing.
    jitterMaxSecs: opts.jitterMaxSecs ?? 1,
    now: opts.now,
  });
}

// ─── Eligibility predicate ─────────────────────────────────────────────

describe("Kind2ForceCloseCranker — isEligibleForFire", () => {
  beforeEach(() => sendMock.mockReset());

  it("rejects when force_close_unix_timestamp is zero (not configured)", () => {
    const registry = new StubRegistry();
    const cranker = makeCranker({
      registry,
      now: () => 2_000_000_000_000,
      jitterMaxSecs: 1,
    });
    const entry = entryFor(SLAB_A, 0n);
    expect(cranker.isEligibleForFire(entry)).toBe(false);
  });

  it("rejects before fc_ts + post_buffer + jitter has elapsed", () => {
    // Force jitterMaxSecs = 1 → jitter will be 0 (Math.floor(random * 1) = 0)
    // fc_ts = 1_800_000_000, post_buffer = 30 → eligible at 1_800_000_030s
    const registry = new StubRegistry();
    const nowMs = 1_800_000_010 * 1000; // 20s before eligible
    const cranker = makeCranker({ registry, now: () => nowMs, jitterMaxSecs: 1 });
    const entry = entryFor(SLAB_A, 1_800_000_000n);
    expect(cranker.isEligibleForFire(entry)).toBe(false);
  });

  it("accepts at fc_ts + post_buffer (jitter = 0)", () => {
    const registry = new StubRegistry();
    const fcTs = 1_800_000_000n;
    const nowMs = (Number(fcTs) + 30) * 1000;
    const cranker = makeCranker({ registry, now: () => nowMs, jitterMaxSecs: 1 });
    const entry = entryFor(SLAB_A, fcTs);
    expect(cranker.isEligibleForFire(entry)).toBe(true);
  });

  it("uses a stable jitter across multiple calls for the same slab", () => {
    const registry = new StubRegistry();
    const fcTs = 1_800_000_000n;
    const cranker = makeCranker({
      registry,
      now: () => (Number(fcTs) + 30) * 1000,
      jitterMaxSecs: 60, // wider so jitter is likely > 0
    });
    const entry = entryFor(SLAB_A, fcTs);
    // First call samples jitter; second call must use the same value.
    const first = cranker.isEligibleForFire(entry);
    const second = cranker.isEligibleForFire(entry);
    expect(first).toBe(second);
  });
});

// ─── Fire path + classification ────────────────────────────────────────

describe("Kind2ForceCloseCranker — fireOne", () => {
  let registry: StubRegistry;
  let cranker: Kind2ForceCloseCranker;
  const fcTs = 1_800_000_000n;
  const nowAtFire = (Number(fcTs) + 30) * 1000;

  beforeEach(() => {
    sendMock.mockReset();
    registry = new StubRegistry();
    cranker = makeCranker({ registry, now: () => nowAtFire, jitterMaxSecs: 1 });
  });

  afterEach(() => cranker.stop());

  it("submits a tag-88 ix with [payer(signer), slab(writable)] accounts", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledOnce();
    const [/* connection */, ixs] = sendMock.mock.calls[0];
    expect(ixs).toHaveLength(1);
    const ix = ixs[0];
    expect(Array.from(ix.data)).toEqual([88]); // tag-88, no payload
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[1].pubkey.toBase58()).toBe(SLAB_A);
    expect(ix.keys[1].isWritable).toBe(true);
  });

  it("marks the market done after a successful submit (no re-attempt)", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledTimes(1);
    sendMock.mockClear();
    // Second tick must skip — market is done.
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("classifies 'already resolved' InvalidAccountData as race-loss and marks done", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockRejectedValue(
      Object.assign(new Error("Transaction failed: InvalidAccountData"), {
        logs: ["Program log: ForceCloseKind2: already resolved"],
      }),
    );
    await cranker.tick();
    sendMock.mockClear();
    // Race-loss → done → next tick must skip.
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("classifies paused market and backs off without marking done", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("Transaction failed: InvalidAccountData"), {
        logs: ["Program log: ForceCloseKind2: refuses paused market"],
      }),
    );
    await cranker.tick();
    // Backoff active → next tick within window must skip.
    sendMock.mockClear();
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does NOT mark done when keeperSend returns null (budget exhausted)", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockResolvedValueOnce(null); // budget exhausted
    await cranker.tick();
    // Next tick should retry because we never marked done.
    sendMock.mockClear();
    sendMock.mockResolvedValueOnce({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalled();
  });

  it("classifies generic errors as 'other' and applies exponential backoff", async () => {
    const entry = entryFor(SLAB_A, fcTs);
    registry.set([entry]);
    sendMock.mockRejectedValueOnce(new Error("RPC connection reset"));
    await cranker.tick();
    sendMock.mockClear();
    // Immediately after: still in backoff.
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// ─── Tick-level integration ────────────────────────────────────────────

describe("Kind2ForceCloseCranker — tick", () => {
  it("walks every actionable market and skips ones not eligible", async () => {
    sendMock.mockReset();
    const registry = new StubRegistry();
    const fcTs = 1_800_000_000n;
    const nowMs = (Number(fcTs) + 30) * 1000;
    const cranker = makeCranker({ registry, now: () => nowMs, jitterMaxSecs: 1 });
    const SLAB_B = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
    // Slab A: eligible. Slab B: timestamp far in the future, not eligible.
    registry.set([
      entryFor(SLAB_A, fcTs),
      entryFor(SLAB_B, fcTs + 1_000_000n),
    ]);
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledOnce();
    cranker.stop();
  });

  it("does not double-submit when a tick overlaps an inflight submit", async () => {
    sendMock.mockReset();
    const registry = new StubRegistry();
    const fcTs = 1_800_000_000n;
    const nowMs = (Number(fcTs) + 30) * 1000;
    const cranker = makeCranker({ registry, now: () => nowMs, jitterMaxSecs: 1 });
    registry.set([entryFor(SLAB_A, fcTs)]);
    let resolveSend: (v: unknown) => void = () => {};
    sendMock.mockReturnValueOnce(new Promise((r) => { resolveSend = r; }));
    const firstTick = cranker.tick();
    // Second tick fires while first is still inflight — overlap guard kicks in.
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledTimes(1);
    resolveSend({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await firstTick;
    cranker.stop();
  });
});
