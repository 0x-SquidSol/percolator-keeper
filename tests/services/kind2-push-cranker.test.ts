/**
 * Hot-path behaviour tests for the kind=2 push cranker.
 *
 * Exercises the cranker's `tick()` and `pushOne()` paths against mock
 * collaborators (registry stub, in-memory account cache, fake
 * connection, fake keeper-send via vi.mock). Covers the gate, the
 * three rejection classifications, and the watchdog.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { Kind2PushCranker } from "../../src/services/kind2-push-cranker.js";
import { AccountCache } from "../../src/lib/account-cache.js";
import {
  parsePythPriceUpdateV2,
  PRICE_UPDATE_V2_MIN_LEN,
} from "../../src/services/kind2-pyth-parse.js";
import type { Kind2Entry } from "../../src/services/kind2-registry.js";
import type { LeaderLock } from "../../src/lib/leader.js";

// ─── Mock collaborators ────────────────────────────────────────────────

const sendMock = vi.fn();
vi.mock("../../src/lib/keeper-send.js", () => ({
  keeperSend: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual<typeof import("@percolatorct/sdk")>("@percolatorct/sdk");
  return {
    ...actual,
    derivePythPushOraclePDA: (_feedHex: string) => [
      new PublicKey(new Uint8Array(32).fill(7)),
      255,
    ],
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
  sendCriticalAlert: vi.fn(async () => {}),
}));

// ─── Test fixtures ──────────────────────────────────────────────────────

const PROGRAM_ID = new PublicKey("ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv");

const seq = (start: number, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

function buildPythBytes(publishTime: bigint, rawPrice: bigint, exponent: number): Uint8Array {
  const buf = new Uint8Array(PRICE_UPDATE_V2_MIN_LEN);
  buf[40] = 1; // Full
  const view = new DataView(buf.buffer);
  view.setBigInt64(73, rawPrice, true);
  view.setInt32(89, exponent, true);
  view.setBigInt64(93, publishTime, true);
  return buf;
}

const SLAB_A = new PublicKey(new Uint8Array(32).fill(1)).toBase58();

function entryFor(slab: string): Kind2Entry {
  return {
    slab,
    programId: PROGRAM_ID.toBase58(),
    fields: {
      polymarketConditionId: seq(0x10, 32),
      oracleSource: 0,
      pythThresholdE6: 100_000_000_000n,
      pythScaleBpsPerPct: 100,
      valueDeviationBps: 500,
      forceCloseUnixTimestamp: 1_780_000_000n,
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
  return {
    getAccountInfo: vi.fn(async () => null),
  } as unknown as Connection;
}

function makeCranker(opts: {
  registry: StubRegistry;
  cache: AccountCache;
  connection?: Connection;
}): Kind2PushCranker {
  return new Kind2PushCranker({
    registry: opts.registry as unknown as Parameters<typeof Kind2PushCranker>[0]["registry"],
    cache: opts.cache,
    leader: {} as LeaderLock,
    connection: opts.connection ?? makeConnection(),
    payer: Keypair.generate(),
    programId: PROGRAM_ID,
    // KeeperBudget: only `canSpend` and `recordTx` are touched by the mocked send.
    budget: { canSpend: () => true, recordTx: () => {}, getStats: () => ({}) } as never,
    getCurrentSlot: () => 1_000,
    tickMs: 10_000, // never auto-fires in tests; we call tick() manually
    watchdogMs: 10_000,
    p1FailureThreshold: 3,
    p1DedupMs: 60_000,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("Kind2PushCranker — gate + submit", () => {
  let registry: StubRegistry;
  let cache: AccountCache;
  let cranker: Kind2PushCranker;

  beforeEach(() => {
    sendMock.mockReset();
    registry = new StubRegistry();
    cache = new AccountCache();
    cranker = makeCranker({ registry, cache });
  });

  afterEach(() => {
    cranker.stop();
  });

  it("tick with no markets is a no-op", async () => {
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when Pyth account is not in cache", async () => {
    registry.set([entryFor(SLAB_A)]);
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("submits when Pyth is fresh and gate is satisfied", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it("skips submit when publish_time is not strictly advancing", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledOnce();
    // Second tick: same Pyth bytes, publishTime unchanged → must skip.
    sendMock.mockClear();
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("re-submits when Pyth advances", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockResolvedValue({ signature: "sig1", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Advance Pyth publish_time by 1 second.
    cache.set(pythPubkey, buildPythBytes(1_700_000_001n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    sendMock.mockResolvedValue({ signature: "sig2", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("classifies OracleStale rejection silently", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockRejectedValue(
      Object.assign(new Error("Transaction failed: custom program error: 0x6"), {
        logs: ["Program log: PushOracleSnapshot: publish_time=X not greater than ring_last=Y (replay/stale)"],
      }),
    );
    await expect(cranker.tick()).resolves.toBeUndefined();
    // Tick swallows the error; no throw escaped.
  });

  it("advances watermark on OracleStale so it doesn't re-submit the same publishTime", async () => {
    // Regression for stale-retry infinite-loop bug: pre-fix the cranker
    // returned from the stale branch without updating
    // lastSubmittedPublishTime, so every subsequent tick re-fetched the
    // SAME Pyth observation and re-submitted it forever.
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    const publishTime = 1_700_000_000n;
    cache.set(pythPubkey, buildPythBytes(publishTime, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);

    // First tick: submit succeeds in being called, returns OracleStale.
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("Transaction failed: custom program error: 0x6"), {
        logs: ["Program log: PushOracleSnapshot: publish_time=X not greater than ring_last=Y (replay/stale)"],
      }),
    );
    await cranker.tick();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Second tick with the SAME publishTime: the watermark advanced on
    // the stale rejection, so the off-chain gate at parsed.publishTime
    // <= lastSubmittedPublishTime now short-circuits before submit.
    sendMock.mockClear();
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("classifies OracleInvalid (deviation) rejection and parks the market", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockRejectedValue(
      Object.assign(new Error("Transaction failed: custom program error: 0xc"), {
        logs: ["Program log: PushOracleSnapshot: deviation guard rejects (observed=X > tolerance=Y)"],
      }),
    );
    await cranker.tick();
    // Second tick should NOT re-submit immediately — market parked for 60s.
    sendMock.mockClear();
    cache.set(pythPubkey, buildPythBytes(1_700_000_001n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    await cranker.tick();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("classifies resolved-market rejection (InvalidAccountData) without P1", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockRejectedValue(
      Object.assign(new Error("Transaction failed: InvalidAccountData"), {
        logs: ["Program log: PushOracleSnapshot: refuses resolved market"],
      }),
    );
    await expect(cranker.tick()).resolves.toBeUndefined();
  });

  it("skips when budget gate returns null (soft skip, no failure recorded)", async () => {
    const entry = entryFor(SLAB_A);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    registry.set([entry]);
    sendMock.mockResolvedValue(null); // budget exhausted
    await cranker.tick();
    expect(sendMock).toHaveBeenCalled();
    // Watermark NOT advanced — next tick should re-attempt.
    sendMock.mockClear();
    sendMock.mockResolvedValue({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await cranker.tick();
    expect(sendMock).toHaveBeenCalled();
  });
});

describe("Kind2PushCranker — tick overlap + watchdog", () => {
  it("drops the second tick when the first is still in flight", async () => {
    const registry = new StubRegistry();
    const cache = new AccountCache();
    const cranker = makeCranker({ registry, cache });
    registry.set([entryFor(SLAB_A)]);
    const pythPubkey = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
    cache.set(pythPubkey, buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8), "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", 1_000);
    sendMock.mockReset();
    // Hold the first send open so the second tick collides.
    let resolveSend: (v: unknown) => void = () => {};
    sendMock.mockReturnValueOnce(new Promise((r) => { resolveSend = r; }));
    const firstTick = cranker.tick();
    // Second tick fires while first is still inflight — should be a no-op
    const secondTick = cranker.tick();
    await secondTick;
    expect(sendMock).toHaveBeenCalledTimes(1);
    resolveSend({ signature: "sig", estimatedCost: 5_000, simulatedCu: 30_000 });
    await firstTick;
    cranker.stop();
  });

  it("watchdog forces getAccountInfo for stale markets", async () => {
    const registry = new StubRegistry();
    const cache = new AccountCache();
    const connection = {
      getAccountInfo: vi.fn(async () => ({
        data: buildPythBytes(1_700_000_000n, 10_000_000_000_000n, -8),
        owner: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
        lamports: 1, executable: false, rentEpoch: 0,
      })),
    } as unknown as Connection;
    const cranker = makeCranker({ registry, cache, connection });
    registry.set([entryFor(SLAB_A)]);
    await cranker.runWatchdog();
    expect(connection.getAccountInfo).toHaveBeenCalledOnce();
    cranker.stop();
  });
});

describe("parsePythPriceUpdateV2 sanity (sanity-check the test fixture builder)", () => {
  it("round-trips the synthetic Pyth buffer used by cranker tests", () => {
    const buf = buildPythBytes(1_780_000_000n, 12_345_678n, -8);
    const parsed = parsePythPriceUpdateV2(buf);
    expect(parsed).not.toBeNull();
    expect(parsed!.publishTime).toBe(1_780_000_000n);
    expect(parsed!.price).toBe(12_345_678n);
    expect(parsed!.exponent).toBe(-8);
  });
});
