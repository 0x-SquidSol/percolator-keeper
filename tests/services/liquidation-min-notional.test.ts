/**
 * Regression test for the liquidation min-notional floor.
 *
 * The keeper liquidates as a permissionless cranker and earns no liquidation fee
 * (the on-chain penalty goes to the protocol), so every liquidation is a pure
 * cost — a crank+LiquidateAtOracle tx paying a Jito tip (default 200_000
 * lamports) + fees. Previously scanMarket()/liquidate() had no minimum-notional
 * floor, so the keeper would liquidate dust at a loss and an attacker could spam
 * tiny undercollateralized positions across many owners to drain the wallet.
 *
 * notional = abs(positionSize) * priceE6 / 1e6 is denominated in a fixed
 * 6-decimal USD quote unit (1_000_000n == $1) for every market — POS_SCALE and
 * the price scale are fixed, so collateral-mint decimals don't enter it. A
 * single USD-denominated floor (default $1) is therefore correct across all
 * markets and is applied in both scanMarket and the pre-submit re-check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js");
  return {
    ...actual,
    SYSVAR_CLOCK_PUBKEY: { toBase58: () => "SysvarC1ock11111111111111111111111111111111", equals: () => false },
  };
});

vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(),
  parseConfig: vi.fn(),
  parseEngine: vi.fn(),
  parseParams: vi.fn(),
  parseAccount: vi.fn(),
  parseUsedIndices: vi.fn(),
  detectLayout: vi.fn(),
  buildAccountMetas: vi.fn(() => []),
  buildIx: vi.fn(() => ({})),
  encodeLiquidateAtOracle: vi.fn(() => Buffer.from([1])),
  encodeKeeperCrank: vi.fn(() => Buffer.from([2])),
  encodePushOraclePrice: vi.fn(() => Buffer.from([3])),
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => "Oracle11111111111111111111111111111111" }, 0]),
  ACCOUNTS_LIQUIDATE_AT_ORACLE: {},
  ACCOUNTS_KEEPER_CRANK: {},
  ACCOUNTS_PUSH_ORACLE_PRICE: {},
}));

vi.mock("@percolatorct/shared", () => ({
  config: { crankKeypair: "mock-keypair-path" },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWarningAlert: vi.fn(),
  getConnection: vi.fn(() => ({})),
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => "11111111111111111111111111111111", equals: () => false }, secretKey: new Uint8Array(64) })),
  sendWithRetry: vi.fn(),
  sendWithRetryKeeper: vi.fn(),
  pollSignatureStatus: vi.fn(),
  getRecentPriorityFees: vi.fn(async () => ({ priorityFeeMicroLamports: 5000, computeUnitLimit: 200000 })),
  checkTransactionSize: vi.fn(),
  eventBus: { publish: vi.fn() },
  acquireToken: vi.fn(async () => {}),
  getFallbackConnection: vi.fn(() => ({})),
  backoffMs: vi.fn(() => 100),
  getErrorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}));

vi.mock("../../src/lib/keeper-send.js", async () => {
  const { KeeperBudget } = await vi.importActual<typeof import("../../src/lib/budget.js")>("../../src/lib/budget.js");
  return { keeperSend: vi.fn(async () => ({ signature: "sig", estimatedCost: 5000 })), sharedBudget: new KeeperBudget() };
});

import { LiquidationService, parseMinLiqNotional } from "../../src/services/liquidation.js";
import * as core from "@percolatorct/sdk";
import * as keeperSendModule from "../../src/lib/keeper-send.js";

function zeroKey() {
  return { toBase58: () => "11111111111111111111111111111111", toBytes: () => new Uint8Array(32), equals: () => false };
}

// Price $1 (1e6). At $1, notional (6-decimal USD units) == positionSize.
const mkAccount = (over: Record<string, unknown>) => ({
  kind: 0,
  owner: { toBase58: () => "Owner11111111111111111111111111111111111" },
  positionSize: 0n,
  capital: 0n,
  pnl: 0n,
  ...over,
});
const DUST = mkAccount({ positionSize: 10_000n, capital: 0n });        // notional $0.01, underwater
const MATERIAL = mkAccount({ positionSize: 10_000_000_000n, capital: 100_000_000n }); // $10,000, ~1% margin

function market() {
  return {
    slabAddress: { toBase58: () => "Market111111111111111111111111111111111" },
    programId: { toBase58: () => "Program11111111111111111111111111111111" },
    config: { indexFeedId: { toBytes: () => new Uint8Array(32) } },
  } as any;
}

describe("liquidation min-notional floor", () => {
  let svc: LiquidationService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new LiquidationService({ fetchPrice: vi.fn() } as any, 15000);
    vi.mocked(core.fetchSlab).mockResolvedValue(new Uint8Array(1024));
    vi.mocked(core.parseEngine).mockReturnValue({ totalOpenInterest: 100_000_000n } as any);
    vi.mocked(core.parseParams).mockReturnValue({ maintenanceMarginBps: 500n } as any); // 5%
    vi.mocked(core.parseConfig).mockReturnValue({
      oracleAuthority: zeroKey(),
      indexFeedId: zeroKey(), // Hyperp mode
      authorityPriceE6: 1_000_000n,
      lastEffectivePriceE6: 1_000_000n,
      authorityTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    } as any);
    vi.mocked(core.detectLayout).mockReturnValue({ accountsOffset: 0 } as any);
  });

  afterEach(() => svc.stop());

  describe("parseMinLiqNotional", () => {
    it("defaults to $1 (1_000_000n) on missing/empty input", () => {
      expect(parseMinLiqNotional(undefined)).toBe(1_000_000n);
      expect(parseMinLiqNotional("")).toBe(1_000_000n);
      expect(parseMinLiqNotional("   ")).toBe(1_000_000n);
    });
    it("parses a valid non-negative integer", () => {
      expect(parseMinLiqNotional("5000000")).toBe(5_000_000n);
      expect(parseMinLiqNotional("0")).toBe(0n); // explicit disable
    });
    it("falls back to default on invalid / negative input", () => {
      expect(parseMinLiqNotional("abc")).toBe(1_000_000n);
      expect(parseMinLiqNotional("1.5")).toBe(1_000_000n);
      expect(parseMinLiqNotional("-100")).toBe(1_000_000n);
    });
  });

  describe("scanMarket", () => {
    it("skips a dust-notional position and keeps a material one", async () => {
      vi.mocked(core.parseUsedIndices).mockReturnValue([0, 1]);
      vi.mocked(core.parseAccount).mockImplementation((_d: any, i: number) => (i === 0 ? { ...DUST } : { ...MATERIAL }) as any);

      const candidates = await svc.scanMarket(market());

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.accountIdx).toBe(1); // material kept, dust (idx 0) skipped
    });

    it("keeps a position exactly at the floor, skips one just below", async () => {
      // notional == positionSize at $1. Floor is $1 == 1_000_000n. Both underwater.
      vi.mocked(core.parseUsedIndices).mockReturnValue([0, 1]);
      vi.mocked(core.parseAccount).mockImplementation((_d: any, i: number) =>
        (i === 0 ? mkAccount({ positionSize: 999_999n }) : mkAccount({ positionSize: 1_000_000n })) as any);

      const candidates = await svc.scanMarket(market());

      expect(candidates.map((c) => c.accountIdx)).toEqual([1]); // exactly-at-floor kept; below skipped
    });
  });

  describe("liquidate pre-submit floor", () => {
    it("aborts (returns null, no send) when the fresh notional is below the floor", async () => {
      // The pre-submit re-check re-parses fresh state; make it dust.
      vi.mocked(core.parseUsedIndices).mockReturnValue([0]);
      vi.mocked(core.parseAccount).mockReturnValue({ ...DUST } as any);

      const result = await svc.liquidate(market(), 0);

      expect(result).toBeNull();
      expect(keeperSendModule.keeperSend).not.toHaveBeenCalled();
    });
  });
});
