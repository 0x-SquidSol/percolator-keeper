/**
 * Regression for ADL-1 / ADL-2 (was the PoC that proved the finding).
 *
 * Original finding (against dcccrypto/percolator-prog main, src/percolator.rs handle_execute_adl):
 *   - percolator.rs:14537  require_admin(header.admin, accounts[0])      → signer MUST be the market admin
 *   - percolator.rs:14590  if insurance_fund.balance != 0 → InsuranceFundNotDepleted
 *   The keeper signed ExecuteAdl with the (non-admin) CRANK_KEYPAIR and triggered while the
 *   insurance fund still held a balance → every send reverted (0xf / 0x2f).
 *
 * Fix: ADL is now OBSERVE-ONLY. The keeper sends NO ExecuteAdl. These tests lock that in:
 *   ADL-1 — adlNeeded is false unless insurance_fund.balance == 0.
 *   ADL-2 — no ExecuteAdl is ever encoded/built/sent, even when ADL preconditions are met.
 * If anyone re-introduces a keeper-side ADL send path, the ADL-2 spies below will fire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Spies on every encode/build/send primitive a regression could use to send ExecuteAdl.
// Created via vi.hoisted so they exist before the hoisted vi.mock factories run.
const spies = vi.hoisted(() => ({
  encodeExecuteAdl: vi.fn(() => Buffer.from([50, 0, 0])),
  buildIx: vi.fn(() => ({ keys: [], data: Buffer.from([]) })),
  buildAccountMetas: vi.fn(() => []),
  sendWithRetryKeeper: vi.fn(async () => "sig"),
}));

vi.mock("@percolatorct/sdk", () => ({
  fetchSlab: vi.fn(),
  parseEngine: vi.fn(),
  parseConfig: vi.fn(),
  parseAllAccounts: vi.fn(() => []),
  // present-but-must-never-be-called by the keeper's ADL path:
  encodeExecuteAdl: spies.encodeExecuteAdl,
  buildIx: spies.buildIx,
  buildAccountMetas: spies.buildAccountMetas,
  ACCOUNTS_EXECUTE_ADL: [],
  derivePythPushOraclePDA: vi.fn(() => [{ toBase58: () => "x" }, 255]),
}));

vi.mock("@percolatorct/shared", () => ({
  getConnection: vi.fn(() => ({})),
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  sendWarningAlert: vi.fn(async () => {}),
  // must never be called by ADL:
  sendWithRetryKeeper: spies.sendWithRetryKeeper,
  loadKeypair: vi.fn(() => ({ publicKey: { toBase58: () => "crank" } })),
}));

import * as sdk from "@percolatorct/sdk";
import { AdlService } from "../../src/services/adl.js";

const slabKey = { toBase58: () => "slab", equals: () => false, toBytes: () => new Uint8Array(32) };
const market: any = { slabAddress: slabKey, programId: { toBase58: () => "prog" } };

function engine(pnlPosTot: bigint, balance: bigint) {
  return { pnlPosTot, insuranceFund: { balance, feeRevenue: 0n, isolatedBalance: 0n, isolationBps: 0 } };
}

describe("regression: keeper ADL aligns with dcccrypto percolator-prog ExecuteAdl gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sdk.fetchSlab).mockResolvedValue(new Uint8Array(1024));
  });

  it("ADL-1: does NOT flag adlNeeded while insurance_fund.balance > 0 (program requires balance==0)", async () => {
    vi.mocked(sdk.parseEngine).mockReturnValue(engine(1_000_000n, 5_000_000n) as any);
    vi.mocked(sdk.parseConfig).mockReturnValue({ maxPnlCap: 500_000n } as any);

    const svc = new AdlService();
    const state = await svc.getAdlState("slab", market);

    expect(state.capExceeded).toBe(true); // profit IS above cap …
    expect(state.insuranceDepleted).toBe(false); // … but fund is NOT depleted …
    expect(state.adlNeeded).toBe(false); // … so ADL is NOT admissible. (ADL-1 fixed)
  });

  it("ADL-1: flags adlNeeded only once insurance_fund.balance == 0", async () => {
    vi.mocked(sdk.parseEngine).mockReturnValue(engine(1_000_000n, 0n) as any);
    vi.mocked(sdk.parseConfig).mockReturnValue({ maxPnlCap: 500_000n } as any);

    const svc = new AdlService();
    const state = await svc.getAdlState("slab", market);

    expect(state.insuranceDepleted).toBe(true);
    expect(state.adlNeeded).toBe(true);
  });

  it("ADL-2: even when ADL preconditions are met, the keeper encodes/builds/sends NOTHING", async () => {
    // balance==0 && pnl>cap → ADL is admissible on-chain, the exact case that
    // previously triggered a (doomed, non-admin) ExecuteAdl send.
    vi.mocked(sdk.parseEngine).mockReturnValue(engine(1_000_000n, 0n) as any);
    vi.mocked(sdk.parseConfig).mockReturnValue({ maxPnlCap: 500_000n } as any);

    const svc = new AdlService();
    const markets = new Map<string, any>([["slab", { market, permanentlySkipped: false }]]);
    svc.setMarketSource(() => markets);
    const result = await svc.scanAll();

    expect(result.needingAdl).toBe(1); // observed as needing ADL …
    // … but NO ExecuteAdl was encoded, built, or sent (admin/multisig action only).
    expect(spies.encodeExecuteAdl).not.toHaveBeenCalled();
    expect(spies.buildIx).not.toHaveBeenCalled();
    expect(spies.buildAccountMetas).not.toHaveBeenCalled();
    expect(spies.sendWithRetryKeeper).not.toHaveBeenCalled();
  });
});
