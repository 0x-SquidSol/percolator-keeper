/**
 * Minimal `PriceUpdateV2` byte reader for the kind=2 push cranker.
 *
 * The shipped `@percolatorct/sdk` (2.0.9) does not vendor a Pyth account
 * parser, and adding `@pythnetwork/pyth-solana-receiver-sdk` would pull
 * in Anchor + a chain of transitive deps the keeper otherwise avoids.
 * For the cranker's hot path we only need three primitive fields:
 *   * `price` (i64) — Pyth's raw price in `price * 10^exponent` USD
 *   * `exponent` (i32) — typically negative (e.g. -8)
 *   * `publish_time` (i64) — unix seconds, the monotonicity gate
 *
 * Layout (from `dcccrypto/percolator-prog/src/percolator.rs` lines 4358-4500):
 *
 *   [0,   8): Anchor discriminator
 *   [8,  40): write_authority (Pubkey, 32 bytes)
 *   [40, 41): verification_level enum tag — must be `1` (Full) on Pyth-receiver
 *             accounts the wrapper accepts. `Partial` is refused on-chain.
 *   [41,   ): borsh-serialized PriceFeedMessage:
 *               [+0,  +32): feed_id  ([u8; 32])
 *               [+32, +40): price    (i64 LE)
 *               [+40, +48): conf     (u64 LE)
 *               [+48, +52): exponent (i32 LE)
 *               [+52, +60): publish_time (i64 LE)
 *
 *   PRICE_UPDATE_V2_MIN_LEN = 134 — accounts shorter than this are rejected.
 *
 * Source-of-truth pin: any layout change in Pyth's `PriceUpdateV2` or
 * `PriceFeedMessage` would break the wrapper's `read_pyth_price_e6`
 * first, which would surface as `OracleInvalid` rejections at submit
 * time. The cranker's failure-mode metrics catch that loudly before
 * any silent miscompute can propagate.
 */

/** Anchor discriminator + write_authority + verification_level tag = 41 bytes. */
const PRICE_FEED_MESSAGE_OFFSET = 41;
/** Minimum byte length of a PriceUpdateV2 account. Mirrors `PRICE_UPDATE_V2_MIN_LEN`. */
export const PRICE_UPDATE_V2_MIN_LEN = 134;
/** Verification-level tag value for `Full` (the only level the wrapper accepts). */
const VERIFICATION_LEVEL_FULL = 1;
const VERIFICATION_LEVEL_OFFSET = 40;

const FEED_ID_OFFSET = PRICE_FEED_MESSAGE_OFFSET + 0; // 41
const PRICE_OFFSET = PRICE_FEED_MESSAGE_OFFSET + 32; // 73
const EXPONENT_OFFSET = PRICE_FEED_MESSAGE_OFFSET + 48; // 89
const PUBLISH_TIME_OFFSET = PRICE_FEED_MESSAGE_OFFSET + 52; // 93

/** Result of parsing a Pyth PriceUpdateV2 account. All fields raw (no e6 conversion). */
export interface PriceFeed {
  /** `[u8; 32]` Pyth feed id. Must match `MarketConfig.index_feed_id`. */
  readonly feedId: Uint8Array;
  /** `i64` raw Pyth price. Caller multiplies by `10^(exponent + 6)` for e6 USD. */
  readonly price: bigint;
  /** `i32` exponent (typically negative). */
  readonly exponent: number;
  /** `i64` unix seconds at which Pyth network observed the price. */
  readonly publishTime: bigint;
}

/**
 * Parse the kind=2-relevant fields out of a PriceUpdateV2 byte buffer.
 * Returns `null` if the buffer is too short or verification_level is
 * not `Full`. The wrapper applies the same gate, so a `null` here
 * means an on-chain submit would also reject — skip cleanly.
 */
export function parsePythPriceUpdateV2(data: Uint8Array): PriceFeed | null {
  if (data.length < PRICE_UPDATE_V2_MIN_LEN) return null;
  if (data[VERIFICATION_LEVEL_OFFSET] !== VERIFICATION_LEVEL_FULL) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    feedId: data.slice(FEED_ID_OFFSET, FEED_ID_OFFSET + 32),
    price: view.getBigInt64(PRICE_OFFSET, true),
    exponent: view.getInt32(EXPONENT_OFFSET, true),
    publishTime: view.getBigInt64(PUBLISH_TIME_OFFSET, true),
  };
}

/**
 * Convert a Pyth raw price + exponent to e6-scaled USD, matching the
 * wrapper's `read_pyth_price_e6` (lines 4530-4549). Returns `null` on
 * overflow / negative price / out-of-range exponent — the wrapper
 * applies the same checks, so a `null` here means the on-chain submit
 * would reject as `OracleInvalid`.
 *
 * `scale = exponent + 6`. For `scale >= 0`: multiply by `10^scale`.
 * For `scale < 0`: integer-divide by `10^(-scale)`. Bounds checked
 * against u64::MAX to mirror the wrapper.
 */
const MAX_EXPO_ABS = 18;
const U64_MAX = (1n << 64n) - 1n;

export function pythPriceToE6(rawPrice: bigint, exponent: number): bigint | null {
  if (rawPrice <= 0n) return null;
  if (exponent < -MAX_EXPO_ABS || exponent > MAX_EXPO_ABS) return null;
  const scale = exponent + 6;
  let result: bigint;
  if (scale >= 0) {
    result = rawPrice * 10n ** BigInt(scale);
  } else {
    result = rawPrice / 10n ** BigInt(-scale);
  }
  if (result <= 0n || result > U64_MAX) return null;
  return result;
}
