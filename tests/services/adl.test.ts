/**
 * ADL Service removal verification — v17 convergence.
 *
 * AdlService was removed as part of v17 convergence:
 *   - ExecuteAdl (v12 tag 50/101) does not exist in the v17 wrapper program.
 *   - encodeExecuteAdl() in @percolatorct/sdk 3.0.0 throws removedInstruction().
 *   - src/services/adl.ts is now an empty stub (export {}).
 *
 * All previous AdlService tests are superseded by this removal-verification suite.
 * To restore ADL, re-implement using PermissionlessCrank(action=Liquidate) or a
 * new on-chain instruction, then re-add unit tests.
 */
import { describe, it, expect } from "vitest";

describe("AdlService — v17 removal", () => {
  it("adl.ts exports nothing (AdlService was removed)", async () => {
    // adl.ts now contains only `export {}` — no named exports.
    const adlModule = await import("../../src/services/adl.js");
    // The module should resolve but export no named values.
    const exports = Object.keys(adlModule);
    expect(exports).toHaveLength(0);
  });

  it("encodeExecuteAdl throws removedInstruction in SDK 3.0.0", async () => {
    // Import the real (non-mocked) SDK to verify the runtime guard.
    const sdk = await import("@percolatorct/sdk");
    expect(typeof sdk.encodeExecuteAdl).toBe("function");
    // Calling it must throw — not just return a bad payload.
    expect(() => sdk.encodeExecuteAdl({ targetIdx: 0 })).toThrow();
  });

  it("encodePermissionlessCrank (v17 replacement) does NOT throw", async () => {
    const sdk = await import("@percolatorct/sdk");
    expect(typeof sdk.encodePermissionlessCrank).toBe("function");
    expect(typeof sdk.CrankAction).toBe("object");
    const data = sdk.encodePermissionlessCrank({
      action: sdk.CrankAction.Liquidate,
      assetIndex: 0,
      nowSlot: 0n,
      closeQ: 0n,
      feeBps: 0n,
      recoveryReason: 0,
    });
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);
  });
});
