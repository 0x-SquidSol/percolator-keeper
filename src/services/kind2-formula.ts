/**
 * Bit-exact off-chain mirror of the wrapper's on-chain
 * `pyth_price_to_p_yes_e6` formula. Source of truth:
 *   `dcccrypto/percolator-prog/src/oracle_ring.rs` lines 217-244.
 *
 * Used by the push cranker: the keeper computes `p_yes_e6` off-chain
 * from a Pyth observation, submits it via `PushOracleSnapshot`, and the
 * wrapper re-runs THIS formula on-chain and rejects any caller value
 * that disagrees with its own recomputation. Drift between this mirror
 * and the Rust original causes systematic snapshot rejections, so the
 * deliverable is byte-exact parity on every legitimate input.
 *
 * Domain contract (matches the on-chain types):
 *   * `pythPriceE6: bigint`     — u64, the Pyth price in e6 scaled units
 *   * `thresholdE6: bigint`     — u64, the strike threshold in same units
 *   * `scaleBpsPerPct: number`  — i32, signed slope of p_yes per 1% price
 *
 * Defensive fallbacks intentionally mirrored from Rust:
 *   * `thresholdE6 === 0n`  → returns 500_000n (the on-chain function's
 *     panic-guard for division by zero; the on-chain `SetPythPriceMapping`
 *     setter already rejects zero, so this case is dead code in
 *     production but mirroring it keeps the contract).
 *   * `scaleBpsPerPct === 0` → numerator is identically zero, so the
 *     function returns 500_000n for every price (not a special-case in
 *     code, just a consequence of the math).
 *
 * Caller-bug assertions (NOT mirrored from Rust — these throw because
 * they cannot legitimately happen on data from the kind=2 registry):
 *   * `pythPriceE6 < 0n` (the on-chain u64 cannot be negative; a
 *     negative BigInt here means a caller computed it wrong)
 *   * `scaleBpsPerPct` outside i32 range, or not an integer
 *
 * BigInt division semantics: JS `BigInt` `/` truncates toward zero,
 * which matches Rust `i128 / i128` exactly. Verified by a dedicated
 * test vector with a strictly-negative non-divisible numerator
 * (`f(6, 7, 1)`: trunc-div gives -1428, floor-div would give -1429).
 *
 * TODO(wasm-parity): once `pyth_price_to_p_yes_e6` is split into a
 * no_std crate compilable to `wasm32-unknown-unknown`, add a
 * differential-test harness that feeds identical inputs through the
 * Rust WASM and this TS mirror and asserts byte-equal outputs across
 * a property-tested input domain. Today, parity rests on the Rust
 * unit-test vectors transcribed into the TS test suite plus the
 * property-based fuzz tests in `kind2-formula.test.ts`.
 */

/** Lower clamp on the e6 probability output. Mirrors `POLY_CLAMP_LO` in `oracle_ring.rs:42`. */
export const POLY_CLAMP_LO_E6 = 10_000n;
/** Upper clamp on the e6 probability output. Mirrors `POLY_CLAMP_HI` in `oracle_ring.rs:46`. */
export const POLY_CLAMP_HI_E6 = 990_000n;
/** Midpoint of the e6 probability domain. Returned for the threshold==0 and scale==0 cases. */
export const POLY_MID_E6 = 500_000n;

/** Rust i32 lower bound, used to range-check `scaleBpsPerPct`. */
const I32_MIN = -2_147_483_648;
/** Rust i32 upper bound. */
const I32_MAX = 2_147_483_647;
/** Rust u64 upper bound, used as a range check on price/threshold. */
const U64_MAX = (1n << 64n) - 1n;
/** 10_000 bps per 100% — the literal in the Rust numerator. */
const BPS_PER_HUNDRED_PCT = 10_000n;

/**
 * Compute p_yes_e6 from a Pyth observation. Byte-exact mirror of the
 * on-chain `pyth_price_to_p_yes_e6`. See module docstring for the
 * full domain + fallback contract.
 *
 * Throws `RangeError` on inputs that cannot legitimately arise from
 * an actionable kind=2 slab (negative price, out-of-u64 magnitudes,
 * non-integer or out-of-i32 scale). The on-chain wrapper would never
 * produce such inputs, so a throw here surfaces a caller bug (likely
 * a registry classification miss) rather than silently miscomputing.
 */
export function pythPriceToPYesE6(
  pythPriceE6: bigint,
  thresholdE6: bigint,
  scaleBpsPerPct: number,
): bigint {
  // -- caller-bug assertions ---------------------------------------------
  if (pythPriceE6 < 0n || pythPriceE6 > U64_MAX) {
    throw new RangeError(`pythPriceE6 out of u64 range: ${pythPriceE6}`);
  }
  if (thresholdE6 < 0n || thresholdE6 > U64_MAX) {
    throw new RangeError(`thresholdE6 out of u64 range: ${thresholdE6}`);
  }
  if (
    !Number.isInteger(scaleBpsPerPct) ||
    scaleBpsPerPct < I32_MIN ||
    scaleBpsPerPct > I32_MAX
  ) {
    throw new RangeError(`scaleBpsPerPct out of i32 range: ${scaleBpsPerPct}`);
  }

  // -- defensive midpoint fallback (mirrors Rust line 222-227) ----------
  if (thresholdE6 === 0n) return POLY_MID_E6;

  // -- core arithmetic (byte-exact mirror of the Rust i128 path) --------
  // BigInt has arbitrary precision; the i128 overflow proof in the Rust
  // module header is satisfied automatically. We keep the same operation
  // order so intermediate values match for any reviewer comparing the
  // two implementations side-by-side.
  const delta = pythPriceE6 - thresholdE6;
  const numerator = BigInt(scaleBpsPerPct) * delta * BPS_PER_HUNDRED_PCT;
  // BigInt `/` truncates toward zero — same semantics as Rust integer `/`.
  // Test vector `formula_truncates_toward_zero` pins this down.
  const pChange = numerator / thresholdE6;
  const pSigned = POLY_MID_E6 + pChange;

  if (pSigned < POLY_CLAMP_LO_E6) return POLY_CLAMP_LO_E6;
  if (pSigned > POLY_CLAMP_HI_E6) return POLY_CLAMP_HI_E6;
  return pSigned;
}
