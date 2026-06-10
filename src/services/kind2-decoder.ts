/**
 * Pure-function byte decoder for the kind=2 (Polymarket-perp) extension
 * fields of an on-chain `MarketConfig`. Offsets are expressed relative
 * to the END of the config region, because the kind=2 extension is
 * always appended at the tail of `MarketConfig` with `_pad_governance`
 * as the last 8 bytes. End-relative offsets remain stable across any
 * MarketConfig growth that happens *before* the kind=2 extension.
 *
 * The shipped `@percolatorct/sdk` (2.0.9 at K1' authoring) does not yet
 * expose these fields on `MarketConfig` — that work lands in the SDK
 * release that ships with the V13 layout (see roadmap Phase 7 SDK1).
 * Until then, this decoder is the keeper's authoritative parser for
 * the kind=2 fields. When SDK1 ships, callers should switch to the
 * SDK-provided typed accessor and this file can be deleted.
 *
 * Layout (counting backward from the end of `MarketConfig`):
 *
 *   [-8,    0): _pad_governance          [u8; 8]
 *   [-16,  -8): linked_at_slot           u64  LE
 *   [-48, -16): metadata_uri_hash        [u8; 32]
 *   [-80, -48): council_authority        [u8; 32]
 *   [-88, -80): forced_close_price_e6    u64  LE
 *   [-96, -88): force_close_unix_timestamp i64 LE
 *   [-98, -96): _pad_value_anchoring     [u8; 2]
 *   [-100,-98): value_deviation_bps      u16  LE
 *   [-104,-100): pyth_scale_bps_per_pct  i32  LE
 *   [-112,-104): pyth_threshold_e6       u64  LE
 *   [-120,-112): _pad_polymarket_tail    [u8; 8]
 *   [-1560,-120): oracle_ring_buf        [OracleSnapshotEntry; 60]
 *   [-1568,-1560): oracle_source u8 + _pad_oracle_source [u8; 7]
 *   [-1600,-1568): polymarket_condition_id [u8; 32]
 *
 * Source of truth for the layout:
 *   `dcccrypto/percolator-prog/src/percolator.rs` MarketConfig struct
 *   (the kind=2 fields appended at the tail of the MarketConfig struct).
 *
 * Bounds-checking: every decode function asserts `configBytes.length`
 * is at least the minimum kind=2-extended config size before reading.
 * A buffer shorter than that returns `null` from `decodeKind2Fields`.
 */

/**
 * Minimum byte length of `MarketConfig` after the kind=2 extension lands.
 * Anything shorter than this is a pre-V13 MarketConfig and the kind=2
 * fields are not present. The keeper treats those slabs as "not kind=2"
 * and ignores them for registry purposes.
 *
 * The exact V13 CONFIG_LEN is fixed by the on-chain Rust struct's
 * `size_of::<MarketConfig>()` and is verified in `kind2-decoder.test.ts`
 * by round-tripping a fixture buffer through the decoder. If the layout
 * grows again (a new extension appended past `_pad_governance`), this
 * constant and the end-relative offsets above must both update.
 */
export const KIND2_MIN_CONFIG_LEN = 1600;

/** End-relative offsets within `MarketConfig`. All negative. */
const OFF_PAD_GOVERNANCE_END = 0;
const OFF_LINKED_AT_SLOT = -16;
const OFF_METADATA_URI_HASH = -48;
const OFF_COUNCIL_AUTHORITY = -80;
const OFF_FORCED_CLOSE_PRICE_E6 = -88;
const OFF_FORCE_CLOSE_UNIX_TIMESTAMP = -96;
const OFF_VALUE_DEVIATION_BPS = -100;
const OFF_PYTH_SCALE_BPS_PER_PCT = -104;
const OFF_PYTH_THRESHOLD_E6 = -112;
const OFF_ORACLE_SOURCE = -1568;
const OFF_POLYMARKET_CONDITION_ID = -1600;

/** Length of each [u8; 32] field. */
const HASH_LEN = 32;

/** Decoded kind=2 (Polymarket-perp) configuration fields. */
export interface Kind2Fields {
  /** `[u8; 32]` Polymarket CTF condition-id. All-zero = unlinked. */
  readonly polymarketConditionId: Uint8Array;
  /** `u8` oracle source discriminator. V1 accepts only `0` (Pyth). */
  readonly oracleSource: number;
  /** `u64` Pyth price threshold in e6 units. `0n` = unmapped. */
  readonly pythThresholdE6: bigint;
  /**
   * `i32` slope of `on_chain_p` per 1% price move around the threshold,
   * in e6 bps. Signed — negative slopes are valid for "X stays below
   * threshold" market phrasings.
   */
  readonly pythScaleBpsPerPct: number;
  /**
   * `u16` deviation tolerance in bps of the e6 probability space.
   * `0` = mapping not yet configured (PushOracleSnapshot will refuse).
   */
  readonly valueDeviationBps: number;
  /** `i64` admin-set force-close clock. `0n` = unconfigured. */
  readonly forceCloseUnixTimestamp: bigint;
  /** `u64` captured settlement price after ForceCloseKind2. `0n` = not yet force-closed. */
  readonly forcedClosePriceE6: bigint;
  /** `[u8; 32]` council co-signer pubkey. All-zero = unconfigured. */
  readonly councilAuthority: Uint8Array;
  /** `[u8; 32]` advisory off-chain attestation hash. All-zero = unlinked. */
  readonly metadataUriHash: Uint8Array;
  /** `u64` slot at which LinkPolymarketMarket succeeded. `0n` = unlinked. */
  readonly linkedAtSlot: bigint;
}

/**
 * Read a slice of `length` bytes from the end-relative offset.
 * Returns a copy so callers cannot mutate the original buffer.
 */
function readBytesFromEnd(buf: Uint8Array, endOffset: number, length: number): Uint8Array {
  const start = buf.length + endOffset;
  return new Uint8Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + length));
}

/**
 * Decode the kind=2 extension fields from a `MarketConfig` byte buffer.
 *
 * Returns `null` if the buffer is too short to contain the extension
 * (caller should treat as "not a kind=2 slab"). Otherwise returns the
 * decoded fields verbatim — caller is responsible for interpreting
 * sentinel values (all-zero condition_id = unlinked,
 * forced_close_price_e6 != 0 = already resolved, etc.).
 *
 * The buffer passed in MUST be the `MarketConfig` region only, i.e.
 * `slab.subarray(HEADER_LEN, HEADER_LEN + CONFIG_LEN)`. Passing the
 * full slab will produce wrong offsets (the engine state region
 * follows the config and would be misinterpreted as kind=2 fields).
 */
export function decodeKind2Fields(configBytes: Uint8Array): Kind2Fields | null {
  if (configBytes.length < KIND2_MIN_CONFIG_LEN) return null;
  // INVARIANT: callers pass a slice that ENDS at the kind=2 extension's
  // last byte (i.e. at `_pad_governance`). End-relative offsets (-1600..0)
  // are robust to PREFIX growth — see the "offsets are end-relative and
  // survive prefix padding" test — but they would silently mis-read if a
  // future MarketConfig layout appended new fields PAST `_pad_governance`,
  // because the new tail bytes would slide into the offset window. The
  // SDK's `detectSlabLayout` (consumed by the registry's `extractConfigRegion`)
  // returns `configLen` per tier; that is the authoritative slice
  // contract. If the SDK ever ships a layout where kind=2 is no longer
  // at the tail, the registry's slice must be the kind=2 extension
  // sub-region — NOT the full MarketConfig — and the SDK should expose
  // a typed `MarketConfig.kind2()` accessor that obsoletes this decoder.
  // Until then, treat the contract as "caller slices to kind=2 tail."

  const view = new DataView(
    configBytes.buffer,
    configBytes.byteOffset,
    configBytes.byteLength,
  );
  const end = configBytes.length + OFF_PAD_GOVERNANCE_END; // == configBytes.length
  void end; // documented anchor; offsets below are end-relative

  return {
    polymarketConditionId: readBytesFromEnd(configBytes, OFF_POLYMARKET_CONDITION_ID, HASH_LEN),
    oracleSource: view.getUint8(configBytes.length + OFF_ORACLE_SOURCE),
    pythThresholdE6: view.getBigUint64(configBytes.length + OFF_PYTH_THRESHOLD_E6, true),
    pythScaleBpsPerPct: view.getInt32(configBytes.length + OFF_PYTH_SCALE_BPS_PER_PCT, true),
    valueDeviationBps: view.getUint16(configBytes.length + OFF_VALUE_DEVIATION_BPS, true),
    forceCloseUnixTimestamp: view.getBigInt64(
      configBytes.length + OFF_FORCE_CLOSE_UNIX_TIMESTAMP,
      true,
    ),
    forcedClosePriceE6: view.getBigUint64(configBytes.length + OFF_FORCED_CLOSE_PRICE_E6, true),
    councilAuthority: readBytesFromEnd(configBytes, OFF_COUNCIL_AUTHORITY, HASH_LEN),
    metadataUriHash: readBytesFromEnd(configBytes, OFF_METADATA_URI_HASH, HASH_LEN),
    linkedAtSlot: view.getBigUint64(configBytes.length + OFF_LINKED_AT_SLOT, true),
  };
}

/** True iff every byte in `bytes` is zero. */
export function isAllZero(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * Classifies a slab's actionability for the kind=2 registry.
 *
 *   - `actionable`: linked (condition_id non-zero), not force-closed
 *     (forced_close_price_e6 == 0), Pyth-only (oracle_source == 0).
 *     Should be tracked by the registry and fed to downstream cranks.
 *   - `unlinked`: kind=2 fields all-zero or condition_id zero.
 *     Either a non-kind=2 slab, or a kind=2 slab pre-Link. Skip.
 *   - `resolved`: force-close has fired (forced_close_price_e6 != 0).
 *     Evict from the registry; downstream cranks should stop acting.
 *   - `unsupported-source`: linked but `oracle_source != 0`. V1 is
 *     Pyth-only fail-closed; the keeper does not crank such markets.
 */
export type Kind2Status =
  | "actionable"
  | "unlinked"
  | "resolved"
  | "unsupported-source";

export function classifyKind2(fields: Kind2Fields): Kind2Status {
  if (fields.forcedClosePriceE6 !== 0n) return "resolved";
  if (isAllZero(fields.polymarketConditionId)) return "unlinked";
  if (fields.oracleSource !== 0) return "unsupported-source";
  return "actionable";
}
