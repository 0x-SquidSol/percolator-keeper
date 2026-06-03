/**
 * Kind=2 byte-decoder offset verification.
 *
 * Builds a synthetic `MarketConfig` buffer at exactly the kind=2-extended
 * size, writes known values at every end-relative offset, then round-trips
 * through the decoder. If on-chain layout changes (a new extension
 * appended past `_pad_governance`, padding adjustments, etc.) these tests
 * fail loudly — the keeper's view of kind=2 fields diverges from what the
 * wrapper writes.
 */
import { describe, it, expect } from "vitest";
import {
  decodeKind2Fields,
  classifyKind2,
  isAllZero,
  KIND2_MIN_CONFIG_LEN,
} from "../../src/services/kind2-decoder.js";

/**
 * Build a zeroed config buffer of the kind=2-extended size, with optional
 * field overrides written at the correct end-relative offsets. Mirrors the
 * end-relative offset table in `kind2-decoder.ts`.
 */
function buildFixture(overrides: {
  polymarketConditionId?: Uint8Array;
  oracleSource?: number;
  pythThresholdE6?: bigint;
  pythScaleBpsPerPct?: number;
  valueDeviationBps?: number;
  forceCloseUnixTimestamp?: bigint;
  forcedClosePriceE6?: bigint;
  councilAuthority?: Uint8Array;
  metadataUriHash?: Uint8Array;
  linkedAtSlot?: bigint;
  /** Extra bytes to prepend so the buffer simulates a non-minimal config. */
  prefixPaddingLen?: number;
} = {}): Uint8Array {
  const padLen = overrides.prefixPaddingLen ?? 0;
  const buf = new Uint8Array(KIND2_MIN_CONFIG_LEN + padLen);
  const view = new DataView(buf.buffer);
  const end = buf.length;

  if (overrides.polymarketConditionId) {
    buf.set(overrides.polymarketConditionId, end - 1600);
  }
  if (overrides.oracleSource !== undefined) {
    view.setUint8(end - 1568, overrides.oracleSource);
  }
  if (overrides.pythThresholdE6 !== undefined) {
    view.setBigUint64(end - 112, overrides.pythThresholdE6, true);
  }
  if (overrides.pythScaleBpsPerPct !== undefined) {
    view.setInt32(end - 104, overrides.pythScaleBpsPerPct, true);
  }
  if (overrides.valueDeviationBps !== undefined) {
    view.setUint16(end - 100, overrides.valueDeviationBps, true);
  }
  if (overrides.forceCloseUnixTimestamp !== undefined) {
    view.setBigInt64(end - 96, overrides.forceCloseUnixTimestamp, true);
  }
  if (overrides.forcedClosePriceE6 !== undefined) {
    view.setBigUint64(end - 88, overrides.forcedClosePriceE6, true);
  }
  if (overrides.councilAuthority) {
    buf.set(overrides.councilAuthority, end - 80);
  }
  if (overrides.metadataUriHash) {
    buf.set(overrides.metadataUriHash, end - 48);
  }
  if (overrides.linkedAtSlot !== undefined) {
    view.setBigUint64(end - 16, overrides.linkedAtSlot, true);
  }
  return buf;
}

const seq = (start: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);

describe("kind2-decoder", () => {
  it("returns null when buffer is shorter than the kind=2 extension", () => {
    expect(decodeKind2Fields(new Uint8Array(0))).toBeNull();
    expect(decodeKind2Fields(new Uint8Array(KIND2_MIN_CONFIG_LEN - 1))).toBeNull();
  });

  it("decodes a fully-populated kind=2 config buffer", () => {
    const cond = seq(0x10);
    const council = seq(0x20);
    const meta = seq(0x30);
    const buf = buildFixture({
      polymarketConditionId: cond,
      oracleSource: 0,
      pythThresholdE6: 150_000_000_000n,
      pythScaleBpsPerPct: -2500,
      valueDeviationBps: 750,
      forceCloseUnixTimestamp: 1_780_000_000n,
      forcedClosePriceE6: 0n,
      councilAuthority: council,
      metadataUriHash: meta,
      linkedAtSlot: 123_456_789n,
    });
    const fields = decodeKind2Fields(buf);
    expect(fields).not.toBeNull();
    expect(fields!.polymarketConditionId).toEqual(cond);
    expect(fields!.oracleSource).toBe(0);
    expect(fields!.pythThresholdE6).toBe(150_000_000_000n);
    expect(fields!.pythScaleBpsPerPct).toBe(-2500);
    expect(fields!.valueDeviationBps).toBe(750);
    expect(fields!.forceCloseUnixTimestamp).toBe(1_780_000_000n);
    expect(fields!.forcedClosePriceE6).toBe(0n);
    expect(fields!.councilAuthority).toEqual(council);
    expect(fields!.metadataUriHash).toEqual(meta);
    expect(fields!.linkedAtSlot).toBe(123_456_789n);
  });

  it("offsets are end-relative and survive prefix padding", () => {
    const cond = seq(0x40);
    const buf = buildFixture({
      polymarketConditionId: cond,
      pythThresholdE6: 999n,
      linkedAtSlot: 42n,
      prefixPaddingLen: 256, // simulate a MarketConfig that grew before the kind=2 extension
    });
    const fields = decodeKind2Fields(buf)!;
    expect(fields.polymarketConditionId).toEqual(cond);
    expect(fields.pythThresholdE6).toBe(999n);
    expect(fields.linkedAtSlot).toBe(42n);
  });

  it("returns copied byte slices that the caller cannot mutate back into source", () => {
    const cond = seq(0x50);
    const buf = buildFixture({ polymarketConditionId: cond });
    const fields = decodeKind2Fields(buf)!;
    fields.polymarketConditionId[0] = 0xff;
    expect(buf[buf.length - 1600]).toBe(cond[0]); // source untouched
  });

  it("handles signed-int boundaries cleanly", () => {
    const buf = buildFixture({
      pythScaleBpsPerPct: -2_147_483_648, // i32::MIN
      forceCloseUnixTimestamp: -9_223_372_036_854_775_808n, // i64::MIN
    });
    const fields = decodeKind2Fields(buf)!;
    expect(fields.pythScaleBpsPerPct).toBe(-2_147_483_648);
    expect(fields.forceCloseUnixTimestamp).toBe(-9_223_372_036_854_775_808n);
  });
});

describe("classifyKind2", () => {
  const baseFields = () => ({
    polymarketConditionId: seq(0x11),
    oracleSource: 0,
    pythThresholdE6: 100n,
    pythScaleBpsPerPct: 1000,
    valueDeviationBps: 500,
    forceCloseUnixTimestamp: 1_780_000_000n,
    forcedClosePriceE6: 0n,
    councilAuthority: seq(0x22),
    metadataUriHash: seq(0x33),
    linkedAtSlot: 100n,
  });

  it("classifies a fully-populated unresolved Pyth-bound slab as actionable", () => {
    expect(classifyKind2(baseFields())).toBe("actionable");
  });

  it("classifies all-zero condition_id as unlinked (pre-Link or kind=0/1)", () => {
    expect(
      classifyKind2({
        ...baseFields(),
        polymarketConditionId: new Uint8Array(32),
      }),
    ).toBe("unlinked");
  });

  it("classifies a non-zero forced_close_price_e6 as resolved", () => {
    expect(
      classifyKind2({
        ...baseFields(),
        forcedClosePriceE6: 500_000n,
      }),
    ).toBe("resolved");
  });

  it("classifies oracle_source != 0 as unsupported (V1 fail-closed to Pyth)", () => {
    expect(
      classifyKind2({
        ...baseFields(),
        oracleSource: 1,
      }),
    ).toBe("unsupported-source");
    expect(
      classifyKind2({
        ...baseFields(),
        oracleSource: 2,
      }),
    ).toBe("unsupported-source");
  });

  it("resolved takes precedence over other conditions", () => {
    expect(
      classifyKind2({
        ...baseFields(),
        forcedClosePriceE6: 1n,
        polymarketConditionId: new Uint8Array(32),
      }),
    ).toBe("resolved");
  });
});

describe("isAllZero", () => {
  it("returns true for empty and all-zero buffers", () => {
    expect(isAllZero(new Uint8Array(0))).toBe(true);
    expect(isAllZero(new Uint8Array(32))).toBe(true);
  });

  it("returns false on any non-zero byte", () => {
    const b = new Uint8Array(32);
    b[17] = 1;
    expect(isAllZero(b)).toBe(false);
  });
});
