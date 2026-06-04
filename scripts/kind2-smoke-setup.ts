/**
 * Devnet smoke test for the kind=2 (Polymarket-perp) lifecycle — Phase 1 (setup).
 *
 * Drives an end-to-end on-chain bring-up of a kind=2 market against a freshly
 * deployed wrapper binary. Exercises every governance setter the V1 launch
 * runbook calls in production order:
 *
 *   1. Create SPL mint + slab account + vault ATA + seed deposit.
 *   2. `InitMarket` with a real Pyth `index_feed_id` (BTC/USD on devnet by
 *      default) so the kind=2 binding has something to validate against.
 *   3. `SetCouncilAuthority` — admin + incoming-council co-sign. Per the
 *      2026-06-04 wrapper fix this is also the kind=0 → kind=2 lift, so a
 *      single call binds the council pubkey AND promotes the slab.
 *   4. `LinkPolymarketMarket` — admin + council co-sign + real Pyth account.
 *   5. `SetPythPriceMapping` — admin + council co-sign. Threshold is pinned
 *      to the live Pyth price at run time so the formula evaluates to
 *      `POLY_MID_E6 = 500_000` at push time and the deviation guard always
 *      passes for a `p_yes_e6 = 500_000` push.
 *   6. `SetForceCloseTimestamp` — admin + council co-sign. Set 48h+5min in
 *      the future to satisfy the wrapper's `MIN_FUTURE_SECS = 172_800` floor.
 *   7. `PushOracleSnapshot` — one permissionless ring write to confirm the
 *      Pyth read + monotonic-publish gate + ring write all wire correctly.
 *
 * Writes `kind2-smoke-state.json` containing every pubkey + the force-close
 * timestamp so the companion `kind2-smoke-close.ts` can resume after the
 * 48-hour wait without re-deriving anything.
 *
 * Devnet-only. Council is a locally-generated keypair persisted to
 * `kind2-smoke-council.json`. Mainnet bring-up substitutes a Squads multisig
 * — see the operations runbook.
 *
 * Run:
 *   KIND2_PROGRAM_ID=<deployed-id> HELIUS_DEVNET_API_KEY=<key> \
 *     pnpm tsx scripts/kind2-smoke-setup.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  ACCOUNTS_INIT_MARKET,
  buildAccountMetas,
  WELL_KNOWN,
  deriveVaultAuthority,
  derivePythPushOraclePDA,
  SLAB_TIERS,
} from "@percolatorct/sdk";
import * as fs from "node:fs";

// ─── Config ───────────────────────────────────────────────────────────

const PROGRAM_ID_ENV = process.env.KIND2_PROGRAM_ID;
if (!PROGRAM_ID_ENV) {
  console.error("KIND2_PROGRAM_ID env var must be set to the deployed wrapper program id.");
  process.exit(2);
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_ENV);

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.devnet.solana.com";

const KEYPAIR_PATH = process.env.DEPLOYER_KEYPAIR ?? "/tmp/deployer.json";
const STATE_FILE = process.env.KIND2_SMOKE_STATE ?? "./kind2-smoke-state.json";
const COUNCIL_KEYPAIR_PATH = process.env.COUNCIL_KEYPAIR ?? "./kind2-smoke-council.json";

const TIER_NAME = (process.env.KIND2_SLAB_TIER ?? "large") as keyof typeof SLAB_TIERS;
const TIER = SLAB_TIERS[TIER_NAME];

// Canonical Pyth feed id for BTC/USD (Pyth Pull format). Same id on devnet
// and mainnet — the Push Oracle program writes deterministic PDAs keyed
// off the 32-byte feed id.
const BTC_USD_FEED_ID_HEX =
  process.env.KIND2_SMOKE_FEED_ID ??
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// Wrapper enforces `force_close_unix_timestamp >= now + 172_800` (48h).
// Pad by 30 minutes to absorb (a) the gap between local Date.now() at
// encode time and the on-chain Clock::get() at handler execution, (b)
// the time the rest of the setup script takes, and (c) ~minutes of
// devnet validator clock drift seen in practice.
const FORCE_CLOSE_DELAY_SECS = 48 * 3600 + 30 * 60;

// Pyth `PriceUpdateV2` layout — verification level byte at offset 40
// (must be 1 = Full; wrapper's `read_pyth_price_e6` rejects Partial),
// price at offset 73, exponent at offset 89. Same offsets as
// `src/services/kind2-pyth-parse.ts`.
const PYTH_VERIFICATION_LEVEL_OFFSET = 40;
const PYTH_PRICE_OFFSET = 73;
const PYTH_EXPONENT_OFFSET = 89;
const PYTH_MIN_LEN = 134;

// ─── Connection + keypairs ────────────────────────────────────────────

const conn = new Connection(RPC, "confirmed");

if (!fs.existsSync(KEYPAIR_PATH)) {
  console.error(`Payer keypair not found at ${KEYPAIR_PATH}. Set DEPLOYER_KEYPAIR.`);
  process.exit(2);
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
);

let council: Keypair;
if (fs.existsSync(COUNCIL_KEYPAIR_PATH)) {
  council = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(COUNCIL_KEYPAIR_PATH, "utf-8"))),
  );
  console.log(`Reusing council keypair from ${COUNCIL_KEYPAIR_PATH}`);
} else {
  council = Keypair.generate();
  // mode: 0o600 on POSIX keeps the secret readable only by the owner.
  // Windows ignores the mode flag (ACL-inherited). Devnet-only secret;
  // the runbook still recommends deleting after the smoke completes.
  fs.writeFileSync(COUNCIL_KEYPAIR_PATH, JSON.stringify(Array.from(council.secretKey)), {
    mode: 0o600,
  });
  console.log(`Generated council keypair → ${COUNCIL_KEYPAIR_PATH}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────

function ok(label: string): void {
  console.log(`  ✅ ${label}`);
}
function fail(label: string, err: unknown): void {
  const msg = (err as { logs?: string[]; message?: string })?.logs
    ?? (err as Error)?.message
    ?? String(err);
  console.error(`  ❌ ${label}:`, msg);
}

/** Sentinel thrown by `send()` after `fail()` has already logged. The
 *  outer `main().catch` recognises it and skips a duplicate log. */
class HandledSendError extends Error {
  constructor() {
    super("send failed (already logged)");
  }
}

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
    ok(`${label} → ${sig.slice(0, 12)}...`);
    return sig;
  } catch (e) {
    fail(label, e);
    throw new HandledSendError();
  }
}

function buildIx(programId: PublicKey, keys: ReturnType<typeof buildAccountMetas>, data: Uint8Array) {
  return {
    programId,
    keys,
    data: Buffer.from(data),
  };
}

function randomBytes32(seed: string): Uint8Array {
  // Deterministic-ish 32 bytes from a seed string — keeps repeat runs
  // identifiable in logs without pulling in a crypto dep. NOT secure;
  // smoke-only.
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = seed.charCodeAt(i % seed.length) ^ (i * 17 + 31);
  }
  return out;
}

// ─── Hand-rolled kind=2 encoders ──────────────────────────────────────
// SDK 2.0.9 does not yet ship tag-84/86/87/89 builders. Inline here so
// the smoke setup is self-contained; swap for SDK calls once shipped.

const TAG_LINK_POLYMARKET = 84;
const TAG_PUSH_ORACLE_SNAPSHOT = 85;
const TAG_SET_PYTH_PRICE_MAPPING = 86;
const TAG_SET_FORCE_CLOSE_TIMESTAMP = 87;
const TAG_SET_COUNCIL_AUTHORITY = 89;

function encodeSetCouncilAuthority(councilPk: PublicKey): Uint8Array {
  const buf = new Uint8Array(33);
  buf[0] = TAG_SET_COUNCIL_AUTHORITY;
  buf.set(councilPk.toBytes(), 1);
  return buf;
}

function encodeLinkPolymarketMarket(
  conditionId: Uint8Array,
  oracleSource: number,
  metadataUriHash: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(66);
  buf[0] = TAG_LINK_POLYMARKET;
  buf.set(conditionId, 1);
  buf[33] = oracleSource;
  buf.set(metadataUriHash, 34);
  return buf;
}

function encodeSetPythPriceMapping(
  thresholdE6: bigint,
  scaleBpsPerPct: number,
  deviationBps: number,
): Uint8Array {
  const buf = new Uint8Array(15);
  const view = new DataView(buf.buffer);
  buf[0] = TAG_SET_PYTH_PRICE_MAPPING;
  view.setBigUint64(1, thresholdE6, true);
  view.setInt32(9, scaleBpsPerPct, true);
  view.setUint16(13, deviationBps, true);
  return buf;
}

function encodeSetForceCloseTimestamp(unixTs: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  buf[0] = TAG_SET_FORCE_CLOSE_TIMESTAMP;
  view.setBigInt64(1, unixTs, true);
  return buf;
}

function encodePushOracleSnapshot(pYesE6: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  buf[0] = TAG_PUSH_ORACLE_SNAPSHOT;
  view.setBigUint64(1, pYesE6, true);
  return buf;
}

// ─── Pyth live-price read ─────────────────────────────────────────────

async function readPythPriceE6(pythAccount: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(pythAccount, "confirmed");
  if (!info) throw new Error(`Pyth account ${pythAccount.toBase58()} not found on devnet`);
  if (info.data.length < PYTH_MIN_LEN) {
    throw new Error(`Pyth account too short: ${info.data.length} bytes (need ${PYTH_MIN_LEN})`);
  }
  // Wrapper's `read_pyth_price_e6` rejects any PriceUpdateV2 whose
  // verification_level != Full (= 1). Match it here so the smoke test
  // surfaces a clean local error instead of pinning the mapping to a
  // partially-verified price and letting PushOracleSnapshot reject
  // on-chain with a confusing log.
  if (info.data[PYTH_VERIFICATION_LEVEL_OFFSET] !== 1) {
    throw new Error(
      `Pyth account verification_level=${info.data[PYTH_VERIFICATION_LEVEL_OFFSET]} (need 1=Full). ` +
        `Wait for a Full publish or switch feed ids.`,
    );
  }
  const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const price = view.getBigInt64(PYTH_PRICE_OFFSET, true);
  const expo = view.getInt32(PYTH_EXPONENT_OFFSET, true);
  // Normalise to e6: e6_price = price * 10^(6 + expo). Pyth expo is
  // typically negative (e.g. -8 for BTC), so 6 + expo is negative and
  // we divide.
  const shift = 6 + expo;
  let priceE6: bigint;
  if (shift >= 0) {
    priceE6 = price * (10n ** BigInt(shift));
  } else {
    priceE6 = price / (10n ** BigInt(-shift));
  }
  if (priceE6 <= 0n) throw new Error(`Pyth price non-positive after e6 normalisation: ${priceE6}`);
  return priceE6;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🧪 kind=2 devnet smoke — Phase 1 (setup)");
  console.log(`   RPC:      ${HELIUS_KEY ? "Helius (devnet)" : "Public Solana devnet"}`);
  console.log(`   Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`   Payer:    ${payer.publicKey.toBase58()}`);
  console.log(`   Council:  ${council.publicKey.toBase58()}`);
  console.log(`   Tier:     ${TIER_NAME} (${TIER.dataSize} bytes)`);
  console.log(`   Feed id:  ${BTC_USD_FEED_ID_HEX}`);
  const balance = await conn.getBalance(payer.publicKey);
  console.log(`   Balance:  ${balance / LAMPORTS_PER_SOL} SOL`);
  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    throw new Error("Payer balance too low; airdrop first.");
  }
  console.log("");

  // Council also needs a tiny SOL balance to sign — fund it if empty.
  const councilBalance = await conn.getBalance(council.publicKey);
  if (councilBalance < 10_000_000) {
    console.log("Step 0: Fund council");
    await send(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: council.publicKey,
          lamports: 100_000_000,
        }),
      ),
      [payer],
      "Fund council 0.1 SOL",
    );
  }

  // ─── Phase A — scaffolding ────────────────────────────────────────

  console.log("Step 1: Create SPL mint");
  const mintKp = Keypair.generate();
  const mintRent = await getMinimumBalanceForRentExemptMint(conn);
  await send(
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mintKp.publicKey, 6, payer.publicKey, payer.publicKey),
    ),
    [payer, mintKp],
    `Mint ${mintKp.publicKey.toBase58().slice(0, 12)}...`,
  );

  console.log("Step 2: Payer ATA + mint tokens");
  const payerAta = await getAssociatedTokenAddress(mintKp.publicKey, payer.publicKey);
  await send(
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerAta,
        payer.publicKey,
        mintKp.publicKey,
      ),
      createMintToInstruction(mintKp.publicKey, payerAta, payer.publicKey, 1_000_000_000_000n),
    ),
    [payer],
    "Mint 1M tokens",
  );

  console.log("Step 3: Create slab account");
  const slabKp = Keypair.generate();
  const slabRent = await conn.getMinimumBalanceForRentExemption(TIER.dataSize);
  console.log(`   Slab rent: ${slabRent / LAMPORTS_PER_SOL} SOL`);
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: slabKp.publicKey,
        lamports: slabRent,
        space: TIER.dataSize,
        programId: PROGRAM_ID,
      }),
    ),
    [payer, slabKp],
    `Slab ${slabKp.publicKey.toBase58().slice(0, 12)}...`,
  );

  console.log("Step 4: Create vault ATA");
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);
  const vaultAta = await getAssociatedTokenAddress(mintKp.publicKey, vaultPda, true);
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vaultAta,
        vaultPda,
        mintKp.publicKey,
      ),
    ),
    [payer],
    `Vault ATA ${vaultAta.toBase58().slice(0, 12)}...`,
  );

  console.log("Step 5: Seed deposit to vault");
  const SEED_AMOUNT = 1_000_000_000n; // 1000 tokens at 6 decimals
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      createTransferInstruction(payerAta, vaultAta, payer.publicKey, SEED_AMOUNT),
    ),
    [payer],
    `Seed ${SEED_AMOUNT}`,
  );

  // ─── Phase B — InitMarket + governance setters ───────────────────

  console.log("Step 6: InitMarket (kind=0 default, BTC/USD feed_id)");
  const initMarketData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mintKp.publicKey,
    indexFeedId: BTC_USD_FEED_ID_HEX,
    maxStalenessSecs: "60",
    confFilterBps: 500,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: "0",
    warmupPeriodSlots: "1",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "30",
    maxAccounts: TIER.maxAccounts.toString(),
    newAccountFee: "1000000",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "100",
    liquidationFeeBps: "100",
    liquidationFeeCap: "0",
    liquidationBufferBps: "50",
    minLiquidationAbs: "0",
    // Required SDK fields — non-zero values force the wrapper's
    // min-margin gates to fire on dust positions; 0 disables both.
    // The smoke test never opens a position, so the disabled values
    // are correct.
    minNonzeroMmReq: "0",
    minNonzeroImReq: "0",
  });
  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey,
    slabKp.publicKey,
    mintKp.publicKey,
    vaultAta,
    WELL_KNOWN.tokenProgram,
    WELL_KNOWN.clock,
    WELL_KNOWN.rent,
    vaultPda,
    WELL_KNOWN.systemProgram,
  ]);
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      buildIx(PROGRAM_ID, initMarketKeys, initMarketData),
    ),
    [payer],
    "InitMarket",
  );

  console.log("Step 7: SetCouncilAuthority (admin + council co-sign, lifts kind 0→2)");
  const setCouncilData = encodeSetCouncilAuthority(council.publicKey);
  const setCouncilKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: council.publicKey, isSigner: true, isWritable: false },
    { pubkey: slabKp.publicKey, isSigner: false, isWritable: true },
  ];
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx(PROGRAM_ID, setCouncilKeys, setCouncilData),
    ),
    [payer, council],
    "SetCouncilAuthority",
  );

  console.log("Step 8: LinkPolymarketMarket (admin + council + Pyth feed)");
  const [pythAccount] = derivePythPushOraclePDA(BTC_USD_FEED_ID_HEX);
  console.log(`   Pyth account: ${pythAccount.toBase58()}`);
  const conditionId = randomBytes32(`smoke-${slabKp.publicKey.toBase58()}`);
  const metadataUriHash = randomBytes32(`meta-${slabKp.publicKey.toBase58()}`);
  const linkData = encodeLinkPolymarketMarket(conditionId, 0, metadataUriHash);
  const linkKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: council.publicKey, isSigner: true, isWritable: false },
    { pubkey: slabKp.publicKey, isSigner: false, isWritable: true },
    { pubkey: pythAccount, isSigner: false, isWritable: false },
  ];
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      buildIx(PROGRAM_ID, linkKeys, linkData),
    ),
    [payer, council],
    "LinkPolymarketMarket",
  );

  console.log("Step 9: SetPythPriceMapping (admin + council)");
  const livePriceE6 = await readPythPriceE6(pythAccount);
  console.log(`   Live Pyth BTC price (e6): ${livePriceE6}`);
  // Pin threshold to current price so the formula evaluates to
  // POLY_MID_E6 = 500_000 at push time. scale=1 keeps the curve flat
  // enough that small price drift doesn't blow the 1000-bps tolerance.
  const setPythData = encodeSetPythPriceMapping(livePriceE6, 1, 1000);
  const setPythKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: council.publicKey, isSigner: true, isWritable: false },
    { pubkey: slabKp.publicKey, isSigner: false, isWritable: true },
  ];
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx(PROGRAM_ID, setPythKeys, setPythData),
    ),
    [payer, council],
    "SetPythPriceMapping",
  );

  console.log("Step 10: SetForceCloseTimestamp (admin + council)");
  const nowSecs = Math.floor(Date.now() / 1000);
  const forceCloseTs = BigInt(nowSecs + FORCE_CLOSE_DELAY_SECS);
  console.log(
    `   force_close_unix_timestamp: ${forceCloseTs} (${new Date(Number(forceCloseTs) * 1000).toISOString()})`,
  );
  const setForceCloseData = encodeSetForceCloseTimestamp(forceCloseTs);
  const setForceCloseKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: council.publicKey, isSigner: true, isWritable: false },
    { pubkey: slabKp.publicKey, isSigner: false, isWritable: true },
  ];
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx(PROGRAM_ID, setForceCloseKeys, setForceCloseData),
    ),
    [payer, council],
    "SetForceCloseTimestamp",
  );

  // ─── Phase C — populate the ring with one oracle push ────────────

  console.log("Step 11: PushOracleSnapshot (permissionless, p_yes_e6 = 500_000)");
  const pushData = encodePushOracleSnapshot(500_000n);
  const pushKeys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: slabKp.publicKey, isSigner: false, isWritable: true },
    { pubkey: pythAccount, isSigner: false, isWritable: false },
  ];
  await send(
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      buildIx(PROGRAM_ID, pushKeys, pushData),
    ),
    [payer],
    "PushOracleSnapshot",
  );

  // ─── State file ──────────────────────────────────────────────────

  const state = {
    programId: PROGRAM_ID.toBase58(),
    rpc: RPC,
    tier: TIER_NAME,
    mint: mintKp.publicKey.toBase58(),
    slab: slabKp.publicKey.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    payerAta: payerAta.toBase58(),
    payer: payer.publicKey.toBase58(),
    council: council.publicKey.toBase58(),
    councilKeypairPath: COUNCIL_KEYPAIR_PATH,
    pythAccount: pythAccount.toBase58(),
    feedIdHex: BTC_USD_FEED_ID_HEX,
    conditionIdHex: Buffer.from(conditionId).toString("hex"),
    metadataUriHashHex: Buffer.from(metadataUriHash).toString("hex"),
    forceCloseUnixTs: Number(forceCloseTs),
    thresholdE6: livePriceE6.toString(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("");
  console.log(`State written to ${STATE_FILE}`);
  console.log(`Force-close eligible at ${new Date(state.forceCloseUnixTs * 1000).toISOString()}`);
  console.log("");
  console.log("Smoke setup complete. Run kind2-smoke-close.ts after the timestamp above to fire ForceCloseKind2.");
}

main().catch((e) => {
  if (!(e instanceof HandledSendError)) {
    console.error(e);
  }
  process.exit(1);
});
