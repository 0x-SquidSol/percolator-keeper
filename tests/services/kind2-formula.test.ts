/**
 * Parity contract for the off-chain `pyth_price_to_p_yes_e6` mirror.
 *
 * Two sections:
 *
 *   1. Every Rust unit-test vector from `oracle_ring.rs` lines 540-663
 *      transcribed verbatim. If the Rust side changes a number, the
 *      TS side SHOULD break — that is the point of this section.
 *
 *   2. Property-based fuzz over the legitimate u64/u64/i32 domain via
 *      fast-check. Catches precision bugs the unit tests miss (e.g.,
 *      a stray `Number()` cast losing magnitude past 2^53 on extreme
 *      inputs), and encodes mathematical invariants — midpoint, scale
 *      symmetry, monotonicity — that survive refactoring.
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  pythPriceToPYesE6,
  POLY_CLAMP_LO_E6,
  POLY_CLAMP_HI_E6,
  POLY_MID_E6,
} from "../../src/services/kind2-formula.js";

// ─── Section 1: Rust unit-test vector transcriptions ─────────────────────
// Source: `dcccrypto/percolator-prog/src/oracle_ring.rs` lines 540-663.
// Each Rust `#[test]` is mirrored 1:1 below.

/** $100k threshold in e6 USD. Matches `BTC_THRESHOLD_E6` in oracle_ring.rs:543. */
const BTC_THRESHOLD_E6 = 100_000_000_000n;
const I32_MIN = -2_147_483_648;
const U64_MAX = (1n << 64n) - 1n;

describe("kind2-formula — Rust parity vectors", () => {
  it("formula_at_threshold_returns_midpoint", () => {
    // oracle_ring.rs:545-560
    expect(pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, 100)).toBe(500_000n);
    expect(pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, -100)).toBe(500_000n);
    expect(pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, I32_MIN)).toBe(500_000n);
  });

  it("formula_one_percent_above_with_unit_scale", () => {
    // oracle_ring.rs:562-570
    const price = BTC_THRESHOLD_E6 + BTC_THRESHOLD_E6 / 100n;
    expect(pythPriceToPYesE6(price, BTC_THRESHOLD_E6, 100)).toBe(510_000n);
  });

  it("formula_one_percent_below_with_unit_scale", () => {
    // oracle_ring.rs:572-580
    const price = BTC_THRESHOLD_E6 - BTC_THRESHOLD_E6 / 100n;
    expect(pythPriceToPYesE6(price, BTC_THRESHOLD_E6, 100)).toBe(490_000n);
  });

  it("formula_negative_scale_inverts_direction", () => {
    // oracle_ring.rs:582-590
    const price = BTC_THRESHOLD_E6 + BTC_THRESHOLD_E6 / 100n;
    expect(pythPriceToPYesE6(price, BTC_THRESHOLD_E6, -100)).toBe(490_000n);
  });

  it("formula_clamps_at_extremes", () => {
    // oracle_ring.rs:592-605
    expect(pythPriceToPYesE6(BTC_THRESHOLD_E6 * 2n, BTC_THRESHOLD_E6, 10_000)).toBe(POLY_CLAMP_HI_E6);
    expect(pythPriceToPYesE6(0n, BTC_THRESHOLD_E6, 10_000)).toBe(POLY_CLAMP_LO_E6);
  });

  it("formula_zero_threshold_returns_midpoint", () => {
    // oracle_ring.rs:607-612 — defensive panic-guard, mirrored by design.
    expect(pythPriceToPYesE6(1_000_000n, 0n, 100)).toBe(500_000n);
    expect(pythPriceToPYesE6(0n, 0n, I32_MIN)).toBe(500_000n);
  });

  it("formula_handles_scale_i32_min_without_panic", () => {
    // oracle_ring.rs:614-623
    const price = BTC_THRESHOLD_E6 + BTC_THRESHOLD_E6 / 100n;
    expect(pythPriceToPYesE6(price, BTC_THRESHOLD_E6, I32_MIN)).toBe(POLY_CLAMP_LO_E6);
  });

  it("formula_zero_scale_returns_midpoint_everywhere", () => {
    // oracle_ring.rs:625-647
    const prices = [
      0n,
      1n,
      BTC_THRESHOLD_E6 / 2n,
      BTC_THRESHOLD_E6,
      BTC_THRESHOLD_E6 * 2n,
      U64_MAX / 2n,
    ];
    for (const price of prices) {
      expect(pythPriceToPYesE6(price, BTC_THRESHOLD_E6, 0)).toBe(500_000n);
    }
  });

  it("formula_price_zero_with_positive_scale_clamps_low", () => {
    // oracle_ring.rs:649-657
    expect(pythPriceToPYesE6(0n, BTC_THRESHOLD_E6, 100)).toBe(POLY_CLAMP_LO_E6);
  });

  it("formula_price_zero_with_negative_scale_clamps_high", () => {
    // oracle_ring.rs:658-662
    expect(pythPriceToPYesE6(0n, BTC_THRESHOLD_E6, -100)).toBe(POLY_CLAMP_HI_E6);
  });
});

// ─── Section 2: semantic invariants ──────────────────────────────────────

describe("kind2-formula — semantic pinning", () => {
  it("BigInt division truncates toward zero, matching Rust signed integer `/`", () => {
    // Pick threshold=7 to force a non-divisible numerator with negative sign:
    //   price=6, threshold=7, scale=1 → delta=-1, numerator = 1 * -1 * 10_000 = -10_000
    //   trunc-div: -10_000 / 7 = -1428 (toward zero — Rust + BigInt)
    //   floor-div: -10_000 / 7 = -1429 (toward -inf — Python)
    // If JS BigInt ever changes semantics, this test will catch it.
    expect(pythPriceToPYesE6(6n, 7n, 1)).toBe(498_572n); // 500_000 - 1_428
  });

  it("throws RangeError on negative price (caller-bug assertion)", () => {
    expect(() => pythPriceToPYesE6(-1n, BTC_THRESHOLD_E6, 100)).toThrow(RangeError);
  });

  it("throws RangeError on price > u64::MAX", () => {
    expect(() => pythPriceToPYesE6(U64_MAX + 1n, BTC_THRESHOLD_E6, 100)).toThrow(RangeError);
  });

  it("throws RangeError on scale outside i32", () => {
    expect(() => pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, 2_147_483_648)).toThrow(RangeError);
    expect(() => pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, -2_147_483_649)).toThrow(RangeError);
  });

  it("throws RangeError on non-integer scale", () => {
    expect(() => pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, 1.5)).toThrow(RangeError);
    expect(() => pythPriceToPYesE6(BTC_THRESHOLD_E6, BTC_THRESHOLD_E6, NaN)).toThrow(RangeError);
  });
});

// ─── Section 3: property tests over the legitimate domain ────────────────
// Domain matches the Rust overflow proof (oracle_ring.rs:192-206):
//   threshold ∈ [1, u64::MAX/2], price ∈ [0, u64::MAX/2], scale ∈ i32.
// Halving the u64 ceiling keeps |delta| ≤ 2^64 so the i128 intermediate
// stays well under i128::MAX.

const u64HalfArb = fc.bigInt({ min: 0n, max: U64_MAX / 2n });
const u64HalfPositiveArb = fc.bigInt({ min: 1n, max: U64_MAX / 2n });
// i32::MIN excluded from property domain — covered explicitly in Section 1.
const scaleArb = fc.integer({ min: -2_147_483_647, max: 2_147_483_647 });

describe("kind2-formula — properties on the legitimate domain", () => {
  it("output is always within [POLY_CLAMP_LO_E6, POLY_CLAMP_HI_E6]", () => {
    fc.assert(
      fc.property(u64HalfArb, u64HalfPositiveArb, scaleArb, (price, threshold, scale) => {
        const p = pythPriceToPYesE6(price, threshold, scale);
        return p >= POLY_CLAMP_LO_E6 && p <= POLY_CLAMP_HI_E6;
      }),
      { numRuns: 500 },
    );
  });

  it("midpoint invariant: f(threshold, threshold, scale) === 500_000", () => {
    fc.assert(
      fc.property(u64HalfPositiveArb, scaleArb, (threshold, scale) =>
        pythPriceToPYesE6(threshold, threshold, scale) === POLY_MID_E6,
      ),
      { numRuns: 500 },
    );
  });

  it("scale-sign symmetry on the un-clamped midband", () => {
    // f(p, t, +s) + f(p, t, -s) === 1_000_000 when neither side clamps.
    fc.assert(
      fc.property(
        // Prices within ±5% of BTC threshold so we stay un-clamped.
        fc.bigInt({ min: 95_000_000_000n, max: 105_000_000_000n }),
        fc.integer({ min: 1, max: 100 }),
        (price, scale) => {
          const up = pythPriceToPYesE6(price, BTC_THRESHOLD_E6, scale);
          const down = pythPriceToPYesE6(price, BTC_THRESHOLD_E6, -scale);
          // Symmetry holds only inside the linear band.
          if (up === POLY_CLAMP_LO_E6 || up === POLY_CLAMP_HI_E6) return true;
          if (down === POLY_CLAMP_LO_E6 || down === POLY_CLAMP_HI_E6) return true;
          return up + down === 1_000_000n;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("monotonic in price for fixed positive (threshold, scale)", () => {
    fc.assert(
      fc.property(
        u64HalfPositiveArb,
        fc.integer({ min: 1, max: 2_147_483_647 }),
        fc.array(u64HalfArb, { minLength: 2, maxLength: 20 }),
        (threshold, scale, rawPrices) => {
          const prices = [...rawPrices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          let prev = pythPriceToPYesE6(prices[0], threshold, scale);
          for (let i = 1; i < prices.length; i++) {
            const cur = pythPriceToPYesE6(prices[i], threshold, scale);
            if (cur < prev) return false;
            prev = cur;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not throw on any input in the legitimate domain", () => {
    fc.assert(
      fc.property(u64HalfArb, u64HalfPositiveArb, scaleArb, (price, threshold, scale) => {
        expect(() => pythPriceToPYesE6(price, threshold, scale)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
