/**
 * Devnet smoke test for the kind=2 (Polymarket-perp) lifecycle — Phase 2 (close).
 *
 * Reads the state file written by `kind2-smoke-setup.ts`, waits until the
 * recorded `force_close_unix_timestamp` has elapsed (refusing to fire
 * early), then submits the permissionless `ForceCloseKind2` crank.
 *
 * On success the slab transitions to `MarketMode::Resolved` and
 * `MarketConfig.forced_close_price_e6` becomes non-zero (the captured
 * ring TWAP). Both can be verified off-chain via `getAccountInfo` +
 * `parseConfig`.
 *
 * Run:
 *   KIND2_PROGRAM_ID=<deployed-id> HELIUS_DEVNET_API_KEY=<key> \
 *     pnpm tsx scripts/kind2-smoke-close.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { decodeKind2Fields } from "../src/services/kind2-decoder.js";
import * as fs from "node:fs";

// `MarketConfig` lives at byte 136 onward inside the slab buffer.
// Matches `SLAB_HEADER_LEN` in `src/services/kind2-registry.ts`.
const SLAB_HEADER_LEN = 136;

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

const TAG_FORCE_CLOSE_KIND2 = 88;

function encodeForceCloseKind2(): Uint8Array {
  return new Uint8Array([TAG_FORCE_CLOSE_KIND2]);
}

interface SmokeState {
  programId: string;
  slab: string;
  forceCloseUnixTs: number;
}

async function main(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`State file not found: ${STATE_FILE}. Run kind2-smoke-setup.ts first.`);
    process.exit(2);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as SmokeState;

  if (state.programId !== PROGRAM_ID.toBase58()) {
    console.error(
      `Program id mismatch: state=${state.programId} env=${PROGRAM_ID.toBase58()}. ` +
        `Re-run setup or correct KIND2_PROGRAM_ID.`,
    );
    process.exit(2);
  }

  const conn = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
  );
  const slab = new PublicKey(state.slab);

  console.log("🔒 kind=2 devnet smoke — Phase 2 (force-close)");
  console.log(`   RPC:     ${HELIUS_KEY ? "Helius (devnet)" : "Public Solana devnet"}`);
  console.log(`   Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`   Slab:    ${slab.toBase58()}`);
  console.log(`   Payer:   ${payer.publicKey.toBase58()}`);
  console.log("");

  const nowSecs = Math.floor(Date.now() / 1000);
  if (nowSecs < state.forceCloseUnixTs) {
    const waitSecs = state.forceCloseUnixTs - nowSecs;
    const waitHrs = (waitSecs / 3600).toFixed(2);
    console.error(
      `force_close_unix_timestamp (${state.forceCloseUnixTs}) not yet reached. ` +
        `Wait ${waitSecs}s (${waitHrs}h) and re-run.`,
    );
    process.exit(3);
  }

  const balance = await conn.getBalance(payer.publicKey);
  if (balance < 10_000_000) {
    throw new Error(`Payer balance too low: ${balance / LAMPORTS_PER_SOL} SOL`);
  }

  // Sanity-check that the slab the state file points at is still the
  // kind=2 market we set up. A stale state file (slab closed and reused
  // for something else, or ts changed via a future governance path)
  // would otherwise produce a cryptic on-chain reject. The SDK does
  // not yet expose kind=2 fields on its `MarketConfig` accessor, so we
  // reuse the keeper's own hand-rolled decoder.
  const slabInfo = await conn.getAccountInfo(slab, "confirmed");
  if (!slabInfo) throw new Error(`Slab ${slab.toBase58()} not found on-chain.`);
  const configRegion = new Uint8Array(
    slabInfo.data.buffer,
    slabInfo.data.byteOffset + SLAB_HEADER_LEN,
    slabInfo.data.byteLength - SLAB_HEADER_LEN,
  );
  const fields = decodeKind2Fields(configRegion);
  if (!fields) {
    throw new Error(
      `Slab does not parse as kind=2 (config region too short or wrong layout). ` +
        `State file is stale or slab was reused.`,
    );
  }
  const onChainTs = Number(fields.forceCloseUnixTimestamp);
  if (onChainTs !== state.forceCloseUnixTs) {
    throw new Error(
      `force_close_unix_timestamp mismatch: state=${state.forceCloseUnixTs}, on-chain=${onChainTs}.`,
    );
  }
  if (fields.forcedClosePriceE6 !== 0n) {
    console.log(
      `  ⚠ Slab already force-closed (forcedClosePriceE6=${fields.forcedClosePriceE6}). Nothing to do.`,
    );
    return;
  }

  console.log("Submitting ForceCloseKind2…");
  const data = encodeForceCloseKind2();
  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: slab, isSigner: false, isWritable: true },
  ];
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    { programId: PROGRAM_ID, keys, data: Buffer.from(data) },
  );
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  console.log(`  ✅ ForceCloseKind2 → ${sig}`);
  console.log("");
  console.log(
    `Smoke close complete. Verify on-chain: getAccountInfo on ${slab.toBase58()} → ` +
      `parseConfig(data).forcedClosePriceE6 should be non-zero, and the engine's ` +
      `market_mode should read Resolved.`,
  );
}

main().catch((e) => {
  const logs = (e as { logs?: string[] }).logs;
  if (logs) console.error("Logs:", logs);
  console.error(e);
  process.exit(1);
});
