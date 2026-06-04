/**
 * Pyth `PriceUpdateV2` parser offset-verification tests.
 *
 * Builds a synthetic PriceUpdateV2 buffer with known field values at
 * each documented offset, then round-trips through `parsePythPriceUpdateV2`.
 * If the on-chain wrapper's layout assumptions ever drift, these
 * fixtures fail loudly — keeper-side mismatch with the wrapper would
 * otherwise surface only as production rejection-log noise.
 */
import { describe, it, expect } from "vitest";
import {
  parsePythPriceUpdateV2,
  pythPriceToE6,
  PRICE_UPDATE_V2_MIN_LEN,
} from "../../src/services/kind2-pyth-parse.js";

/** Build a synthetic PriceUpdateV2 buffer with the given fields. */
function buildPriceUpdateV2(opts: {
  verificationLevel?: number;
  feedId?: Uint8Array;
  price?: bigint;
  conf?: bigint;
  exponent?: number;
  publishTime?: bigint;
} = {}): Uint8Array {
  const buf = new Uint8Array(PRICE_UPDATE_V2_MIN_LEN);
  // verification_level at offset 40 (default 1 = Full)
  buf[40] = opts.verificationLevel ?? 1;
  // PriceFeedMessage starts at offset 41
  const view = new DataView(buf.buffer);
  if (opts.feedId) buf.set(opts.feedId, 41);
  view.setBigInt64(73, opts.price ?? 0n, true);
  view.setBigUint64(81, opts.conf ?? 0n, true);
  view.setInt32(89, opts.exponent ?? 0, true);
  view.setBigInt64(93, opts.publishTime ?? 0n, true);
  return buf;
}

const seq = (start: number, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, (_, i) => (start + i) & 0xff);

describe("parsePythPriceUpdateV2", () => {
  it("returns null when buffer is too short", () => {
    expect(parsePythPriceUpdateV2(new Uint8Array(0))).toBeNull();
    expect(parsePythPriceUpdateV2(new Uint8Array(PRICE_UPDATE_V2_MIN_LEN - 1))).toBeNull();
  });

  it("returns null when verification_level is not Full (1)", () => {
    const partial = buildPriceUpdateV2({ verificationLevel: 0 });
    expect(parsePythPriceUpdateV2(partial)).toBeNull();
    const garbage = buildPriceUpdateV2({ verificationLevel: 2 });
    expect(parsePythPriceUpdateV2(garbage)).toBeNull();
  });

  it("decodes a fully-populated Full-verified PriceUpdateV2", () => {
    const feedId = seq(0x11, 32);
    const buf = buildPriceUpdateV2({
      verificationLevel: 1,
      feedId,
      price: 12_345_678_900n, // raw Pyth price
      conf: 100_000_000n,
      exponent: -8,
      publishTime: 1_780_000_000n,
    });
    const parsed = parsePythPriceUpdateV2(buf);
    expect(parsed).not.toBeNull();
    expect(parsed!.feedId).toEqual(feedId);
    expect(parsed!.price).toBe(12_345_678_900n);
    expect(parsed!.exponent).toBe(-8);
    expect(parsed!.publishTime).toBe(1_780_000_000n);
  });

  it("handles signed-int boundaries cleanly", () => {
    const buf = buildPriceUpdateV2({
      price: -1n, // negative price is a real Pyth state during outages
      exponent: 18, // max positive
      publishTime: -1n, // negative timestamp — caller should refuse
    });
    const parsed = parsePythPriceUpdateV2(buf)!;
    expect(parsed.price).toBe(-1n);
    expect(parsed.exponent).toBe(18);
    expect(parsed.publishTime).toBe(-1n);
  });
});

describe("pythPriceToE6 — wrapper-parity vectors", () => {
  it("returns null on non-positive raw price (wrapper would reject as OracleInvalid)", () => {
    expect(pythPriceToE6(0n, -8)).toBeNull();
    expect(pythPriceToE6(-1n, -8)).toBeNull();
  });

  it("returns null on exponent out of i32-abs(18) range", () => {
    expect(pythPriceToE6(100n, 19)).toBeNull();
    expect(pythPriceToE6(100n, -19)).toBeNull();
  });

  it("scale = exponent + 6; positive scale multiplies", () => {
    // raw = 5, expo = -2 → scale = 4 → 5 * 10_000 = 50_000
    expect(pythPriceToE6(5n, -2)).toBe(50_000n);
    // raw = 1, expo = 0 → scale = 6 → 1 * 1_000_000
    expect(pythPriceToE6(1n, 0)).toBe(1_000_000n);
  });

  it("scale = exponent + 6; negative scale divides (toward zero)", () => {
    // raw = 100, expo = -8 → scale = -2 → 100 / 100 = 1
    expect(pythPriceToE6(100n, -8)).toBe(1n);
    // raw = 12_345, expo = -8 → scale = -2 → 12_345 / 100 = 123 (trunc)
    expect(pythPriceToE6(12_345n, -8)).toBe(123n);
  });

  it("returns null when result would exceed u64::MAX", () => {
    expect(pythPriceToE6(1n, 18)).toBeNull(); // 10^24, well past u64::MAX
  });

  it("realistic BTC-at-$100k vector", () => {
    // Pyth BTC/USD typically expo=-8, price = 100_000 * 10^8 = 10_000_000_000_000
    // → e6 = 100_000 * 10^6 = 100_000_000_000
    const raw = 10_000_000_000_000n;
    expect(pythPriceToE6(raw, -8)).toBe(100_000_000_000n);
  });
});
