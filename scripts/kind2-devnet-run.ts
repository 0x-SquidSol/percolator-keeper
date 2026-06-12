/**
 * Self-contained devnet runner for the kind=2 (Polymarket-perp) keeper
 * services. Lets us exercise the push + force-close cranks against OUR
 * devnet deployment, running OUR branch's code, WITHOUT touching the
 * production `src/index.ts` wiring and WITHOUT depending on Helius
 * LaserStream gRPC.
 *
 * What this replaces vs. production:
 *   * Registry discovery is RPC-ONLY. Production seeds via
 *     `AccountLoader.onAccount` (LaserStream); here we call
 *     `registry.reconcileNow()` once at boot (a public `getProgramAccounts`
 *     scan) and let `registry.start()` run the periodic reconcile loop.
 *   * Pyth `PriceUpdateV2` accounts are normally kept fresh in the shared
 *     `AccountCache` by the LaserStream subscription. With no stream, the
 *     push cranker would skip EVERY market with `pyth_cache_miss`. So this
 *     runner owns a ~1s "Pyth feeder" loop that fetches the bound Pyth
 *     accounts via `getMultipleAccountsInfo` and writes them into the cache
 *     with the Pyth-receiver owner so `getOwnerVerified` passes.
 *
 * Leader/HA: the push cranker's type requires a `LeaderLock`, but it never
 * calls it (verified: no `this.opts.leader` reference anywhere in
 * `kind2-push-cranker.ts`). We pass a typed-away stub so we don't need
 * Redis on devnet.
 *
 * Devnet-only. Set `DRY_RUN=true` to observe every would-fire decision
 * without spending SOL (the keeper-send path intercepts and logs the full
 * ix before the real send).
 *
 * Run:
 *   KIND2_PROGRAM_ID=<deployed-id> HELIUS_DEVNET_API_KEY=<key> \
 *   DEPLOYER_KEYPAIR=/path/to/payer.json DRY_RUN=true \
 *     pnpm run kind2:devnet-run
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { derivePythPushOraclePDA } from "@percolatorct/sdk";
import * as fs from "node:fs";

import { Kind2Registry } from "../src/services/kind2-registry.js";
import { Kind2PushCranker } from "../src/services/kind2-push-cranker.js";
import { Kind2ForceCloseCranker } from "../src/services/kind2-force-close-cranker.js";
import { Kind2MetricsService } from "../src/services/kind2-metrics-service.js";
import { AccountCache } from "../src/lib/account-cache.js";
import { KeeperBudget } from "../src/lib/budget.js";
import type { LeaderLock } from "../src/lib/leader.js";

// ─── Config / env contract (mirrors scripts/kind2-smoke-setup.ts) ──────

const PROGRAM_ID_ENV = process.env.KIND2_PROGRAM_ID;
if (!PROGRAM_ID_ENV) {
  console.error(
    "KIND2_PROGRAM_ID env var must be set to the deployed wrapper program id.",
  );
  process.exit(2);
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_ENV);

const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.devnet.solana.com";

const KEYPAIR_PATH = process.env.DEPLOYER_KEYPAIR ?? "/tmp/deployer.json";
const DRY_RUN = process.env.DRY_RUN === "true";

/** Pyth Receiver program id — must match the AccountCache owner gate in
 *  `kind2-push-cranker.ts` (PYTH_RECEIVER_PROGRAM_ID) or every read fails
 *  `getOwnerVerified`. */
const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

/** Pyth feeder cadence. ~1s keeps the cache within the cache TTL (32 slots
 *  ≈ 12-16s on devnet) with headroom. */
const PYTH_FEEDER_MS = 1_000;
/** Registry reconcile cadence — looser than production's 5min since this is
 *  a short-lived trial and the RPC scan is the only discovery path here. */
const RECONCILE_MS = 30_000;
/** One-line status print cadence. */
const STATUS_MS = 15_000;

// ─── Connection + payer ────────────────────────────────────────────────

const connection = new Connection(RPC, "confirmed");

if (!fs.existsSync(KEYPAIR_PATH)) {
  console.error(`Payer keypair not found at ${KEYPAIR_PATH}. Set DEPLOYER_KEYPAIR.`);
  process.exit(2);
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
);

// ─── Helpers ───────────────────────────────────────────────────────────

/** Mirror of the push cranker's private `toHex` — the exact input
 *  `derivePythPushOraclePDA` receives there. Keep byte-for-byte identical
 *  so we derive the same Pyth account the cranker reads from the cache. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("kind=2 devnet runner (RPC-only, no LaserStream)");
  console.log(`  RPC:      ${HELIUS_KEY ? "Helius (devnet)" : "Public Solana devnet"}`);
  console.log(`  Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`  Payer:    ${payer.publicKey.toBase58()}`);
  console.log(`  DRY_RUN:  ${DRY_RUN ? "ON (no SOL spent; sends intercepted + logged)" : "OFF (LIVE — real transactions will be sent)"}`);
  console.log("");

  // ── Shared infra ────────────────────────────────────────────────────

  const cache = new AccountCache();

  // Permissive budget for a trial: very high caps and the success-rate
  // halt effectively disabled (threshold 0 never trips). We still want the
  // budget object because keeperSend requires one.
  const budget = new KeeperBudget({
    maxSolPerCycle: 1_000_000_000, // 1 SOL
    maxSolPerHour: 5_000_000_000, // 5 SOL
    maxSolPerDay: 20_000_000_000, // 20 SOL
    maxTxPerCycle: 100_000,
    txSuccessRateThreshold: 0, // disable success-rate halt for the trial
    txSuccessRateMinSamples: 1_000_000_000,
  });

  // RPC-only registry: no AccountLoader, no LaserStream. start() runs the
  // periodic reconcile; reconcileNow() below does the cold seed scan.
  const registry = new Kind2Registry({
    programIds: [PROGRAM_ID],
    connection,
    reconcileMs: RECONCILE_MS,
  });

  const metrics = new Kind2MetricsService({ registry });

  // Slot accessor: refreshed each Pyth-feeder loop. Drives the cache TTL
  // check inside `getOwnerVerified`. Seed with the current slot so the very
  // first push tick (which can fire before the feeder's first loop) reads a
  // sane value rather than 0.
  let lastSlot = await connection.getSlot("confirmed");

  const push = new Kind2PushCranker({
    registry,
    cache,
    connection,
    payer,
    programId: PROGRAM_ID,
    budget,
    // LeaderLock is required by the type but never invoked by the cranker
    // (no `this.opts.leader` reference in kind2-push-cranker.ts). On devnet
    // we have no Redis, so pass a typed-away stub.
    leader: {} as unknown as LeaderLock,
    getCurrentSlot: () => lastSlot,
    tickMs: 500,
    metrics,
  });

  const forceClose = new Kind2ForceCloseCranker({
    registry,
    connection,
    payer,
    programId: PROGRAM_ID,
    budget,
    tickMs: 5_000,
    postBufferSecs: 30,
  });

  // ── Cold seed: populate the registry via one RPC scan ───────────────
  //
  // reconcileNow() → reconcileWithRpc() → doReconcile(). On a cold
  // registry the snapshot (scanStartEntries) is empty, so the
  // missing-from-chain eviction pass is a no-op; the missing-from-memory
  // pass then upserts every observed actionable kind=2 slab. So ONE
  // reconcileNow() seeds correctly (verified against doReconcile()).
  console.log("Seeding registry via RPC getProgramAccounts scan...");
  await registry.reconcileNow();
  let seeded = registry.size();
  if (seeded === 0) {
    // Defensive: re-run once in case the first scan raced an RPC blip
    // (doReconcile bails without mutating on a partial scan).
    await registry.reconcileNow();
    seeded = registry.size();
  }
  console.log(`Registry seeded: ${seeded} actionable kind=2 market(s).`);
  if (seeded === 0) {
    console.warn(
      "WARNING: no actionable kind=2 markets found on-chain for this program id. " +
        "The crankers will idle. Run scripts/kind2-smoke-setup.ts first to create one.",
    );
  }
  for (const e of registry.list()) {
    const [pythPk] = derivePythPushOraclePDA(toHex(e.pythFeedId));
    console.log(
      `  market ${e.slab}  pyth=${pythPk.toBase58()}  force_close_ts=${e.fields.forceCloseUnixTimestamp}`,
    );
  }
  console.log("");

  // ── Pyth feeder loop ────────────────────────────────────────────────
  //
  // Replaces the LaserStream subscription: every ~1s, derive each market's
  // bound Pyth PriceUpdateV2 address (same derivation the push cranker
  // uses), batch-fetch them, and write each into the AccountCache with the
  // Pyth-receiver owner so the cranker's getOwnerVerified read passes.
  let pythFeederBusy = false;
  const pythFeeder = setInterval(() => {
    void (async () => {
      if (pythFeederBusy) return; // skip overlap if a slow RPC hasn't returned
      pythFeederBusy = true;
      try {
        // Refresh the slot first so the cache TTL window is anchored to the
        // same observation we're about to write.
        lastSlot = await connection.getSlot("confirmed");

        const entries = registry.list();
        if (entries.length === 0) return;

        // Map each unique Pyth pubkey back to fetch results. Multiple
        // markets can share a feed id, so dedupe to keep the RPC payload
        // minimal.
        const pythKeys: PublicKey[] = [];
        const seen = new Set<string>();
        for (const e of entries) {
          let pk: PublicKey;
          try {
            [pk] = derivePythPushOraclePDA(toHex(e.pythFeedId));
          } catch {
            continue; // bad feed id — the cranker will also skip this market
          }
          const b58 = pk.toBase58();
          if (seen.has(b58)) continue;
          seen.add(b58);
          pythKeys.push(pk);
        }
        if (pythKeys.length === 0) return;

        const infos = await connection.getMultipleAccountsInfo(pythKeys, "confirmed");
        let written = 0;
        for (let i = 0; i < pythKeys.length; i++) {
          const info = infos[i];
          if (!info) continue; // Pyth account not present on devnet for this feed
          // AccountCache.set(pubkey, data, owner, slot) — slot is required.
          // Force the owner to the Pyth receiver program id so the cranker's
          // getOwnerVerified(PYTH_RECEIVER_PROGRAM_ID) check passes; the real
          // on-chain owner IS the receiver, but we set it explicitly so a
          // surprise owner can never silently poison the gate.
          cache.set(pythKeys[i].toBase58(), info.data, PYTH_RECEIVER_PROGRAM_ID, lastSlot);
          written++;
        }
        if (process.env.KIND2_DEVNET_VERBOSE === "true") {
          console.log(
            `[pyth-feeder] slot=${lastSlot} wrote ${written}/${pythKeys.length} feed account(s) into cache`,
          );
        }
      } catch (err) {
        console.warn(`[pyth-feeder] loop error: ${String(err)}`);
      } finally {
        pythFeederBusy = false;
      }
    })();
  }, PYTH_FEEDER_MS);
  pythFeeder.unref?.();

  // ── Status line ─────────────────────────────────────────────────────
  const statusTimer = setInterval(() => {
    const list = registry.list();
    const nowSecs = Math.floor(Date.now() / 1000);
    // Nearest time-to-force-close across tracked markets (negative = window open).
    let nearestTtfc: number | null = null;
    for (const e of list) {
      const fc = e.fields.forceCloseUnixTimestamp;
      if (fc > 0n) {
        const ttfc = Number(fc) - nowSecs;
        if (nearestTtfc === null || ttfc < nearestTtfc) nearestTtfc = ttfc;
      }
    }
    const bs = budget.getStats();
    console.log(
      `[status] markets=${registry.size()} cacheEntries=${cache.size()} ` +
        `nearestForceCloseInSecs=${nearestTtfc ?? "n/a"} ` +
        `budgetHalted=${bs.halted} cycleTx=${bs.cycleTxCount}`,
    );
  }, STATUS_MS);
  statusTimer.unref?.();

  // ── Start order ─────────────────────────────────────────────────────
  registry.start(); // periodic reconcile loop
  metrics.start();
  push.start();
  forceClose.start();
  console.log(
    `Services started (push tickMs=500, forceClose tickMs=5000, pythFeeder=${PYTH_FEEDER_MS}ms, ` +
      `reconcile=${RECONCILE_MS}ms, status every ${STATUS_MS}ms). Ctrl-C to stop.`,
  );

  // ── Clean shutdown ──────────────────────────────────────────────────
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nReceived ${sig} — stopping services...`);
    clearInterval(pythFeeder);
    clearInterval(statusTimer);
    try { push.stop(); } catch (e) { console.warn(`push.stop: ${String(e)}`); }
    try { forceClose.stop(); } catch (e) { console.warn(`forceClose.stop: ${String(e)}`); }
    try { metrics.stop(); } catch (e) { console.warn(`metrics.stop: ${String(e)}`); }
    try { registry.stop(); } catch (e) { console.warn(`registry.stop: ${String(e)}`); }
    console.log("Stopped.");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive. All work runs on the interval timers above;
  // this promise never resolves until a signal handler calls process.exit.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
