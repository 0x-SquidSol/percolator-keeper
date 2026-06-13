/**
 * Regression test for the Chainlink oracle-account bug (end-to-end through liquidate()).
 *
 * The program dispatches read_engine_price_e6 on the oracle account's OWNER. For
 * a Chainlink market, config.index_feed_id IS the aggregator account pubkey; for
 * a Pyth market, index_feed_id is a feed id and the oracle account is the derived
 * Pyth Push PDA. The keeper previously derived a Pyth PDA for ALL non-HYPERP
 * markets, so Chainlink markets got the wrong account and reverted permanently.
 *
 * The fix resolves the oracle account by inspecting the owner of the account at
 * index_feed_id. These tests drive the real liquidate() and capture the oracle
 * account passed into the LiquidateAtOracle instruction:
 *   - Chainlink-owned feed account  -> oracle account == index_feed_id (aggregator)
 *   - feed id is not an account (null) -> oracle account == derived Pyth Push PDA
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const CHAINLINK_OCR2 = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const AGGREGATOR = new PublicKey("Cv4T27XbjVoKUYwP72NQQanvZeA7W4YF9L4EnYT9kx5o");
const PYTH_PDA = PublicKey.unique();

const captured: PublicKey[] = [];
// Controllable owner-lookup result for the account at index_feed_id.
const h = vi.hoisted(() => ({ getAccountInfo: vi.fn() }));

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: { toBase58: () => "SysvarC1ock11111111111111111111111111111111", equals: () => false },
  };
});

vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(async () => new Uint8Array(1024)),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  parseAccount: vi.fn(),
  parseUsedIndices: vi.fn(),
  detectLayout: vi.fn(),
  buildAccountMetas: vi.fn((_accounts: unknown, keys: PublicKey[]) => {
    captured.push(keys[3]!); // [signer, slab, clock, ORACLE]
    return [];
  }),
  buildIx: vi.fn(() => ({})),
  encodeLiquidateAtOracle: vi.fn(() => Buffer.from([1])),
  encodeKeeperCrank: vi.fn(() => Buffer.from([2])),
  derivePythPushOraclePDA: vi.fn(() => [PYTH_PDA, 0]),
  ACCOUNTS_LIQUIDATE_AT_ORACLE: {},
  ACCOUNTS_KEEPER_CRANK: {},
}));

vi.mock("@percolatorct/shared", () => ({
  config: { crankKeypair: "mock-keypair-path" },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWarningAlert: vi.fn(),
  getConnection: vi.fn(() => ({ getAccountInfo: h.getAccountInfo })),
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => false }, secretKey: new Uint8Array(64) })),
  sendWithRetry: vi.fn(),
  sendWithRetryKeeper: vi.fn(),
  pollSignatureStatus: vi.fn(),
  getRecentPriorityFees: vi.fn(async () => ({ priorityFeeMicroLamports: 5000, computeUnitLimit: 200000 })),
  checkTransactionSize: vi.fn(),
  eventBus: { publish: vi.fn() },
  acquireToken: vi.fn(async () => {}),
  getFallbackConnection: vi.fn(() => ({ getAccountInfo: h.getAccountInfo })),
  backoffMs: vi.fn(() => 100),
  getErrorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}));

vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(async () => ({ signature: "sig", estimatedCost: 5000 })), sharedBudget: new KeeperBudget() };
});

import { LiquidationService } from "../../src/services/liquidation.js";
import { _resetOracleAccountCache } from "../../src/lib/oracle-account.js";
import * as core from "@percolatorct/sdk";

/** A non-HYPERP market: index_feed_id != 0 (== the aggregator), oracle_authority == 0. */
function externalFeedMarket() {
  return {
    slabAddress: { toBase58: () => "Market111111111111111111111111111111111", toBytes: () => new Uint8Array(32) },
    programId: { toBase58: () => "Program11111111111111111111111111111111" },
    config: {
      indexFeedId: { toBytes: () => AGGREGATOR.toBytes(), toBase58: () => AGGREGATOR.toBase58(), equals: () => false },
      oracleAuthority: { toBase58: () => "11111111111111111111111111111111", toBytes: () => new Uint8Array(32), equals: () => true },
    },
  } as any;
}

describe("Chainlink oracle-account resolution (liquidate)", () => {
  let svc: LiquidationService;

  beforeEach(() => {
    vi.clearAllMocks();
    captured.length = 0;
    _resetOracleAccountCache();
    svc = new LiquidationService({ fetchPrice: vi.fn() } as any, 15000);
    vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 0n } as any);
    vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any);
    vi.mocked(core.parseConfig).mockReturnValue({
      oracleAuthority: { equals: () => true, toBytes: () => new Uint8Array(32) },
      indexFeedId: { equals: () => false, toBytes: () => AGGREGATOR.toBytes() },
      authorityPriceE6: 0n, lastEffectivePriceE6: 1_000_000n, authorityTimestamp: 0n,
    } as any);
    vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
    vi.mocked(core.parseAccount).mockReturnValue({ kind: 0, owner: { toBase58: () => "U" }, positionSize: 1n, capital: 0n, pnl: 0n } as any);
    vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
  });

  afterEach(() => svc.stop());

  it("Chainlink market → passes index_feed_id (the aggregator) as the oracle account", async () => {
    h.getAccountInfo.mockResolvedValue({ owner: CHAINLINK_OCR2, data: new Uint8Array(0) });

    await svc.liquidate(externalFeedMarket(), 0).catch(() => null);

    expect(captured.length).toBeGreaterThan(0);
    for (const acct of captured) {
      expect(acct.toBase58()).toBe(AGGREGATOR.toBase58());
    }
  });

  it("Pyth market (feed id is not an account) → derives the Pyth Push PDA", async () => {
    h.getAccountInfo.mockResolvedValue(null);

    await svc.liquidate(externalFeedMarket(), 0).catch(() => null);

    expect(captured.length).toBeGreaterThan(0);
    for (const acct of captured) {
      expect(acct.toBase58()).toBe(PYTH_PDA.toBase58());
    }
  });
});
