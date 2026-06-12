/**
 * Self-contained live status dashboard for a devnet kind=2 (Polymarket-perp)
 * market. Reads the slab account, decodes the kind=2 config + oracle ring +
 * the bound live Pyth price, and serves an auto-refreshing HTML page (plus a
 * /json endpoint) on an HTTP port — open it from any device on the LAN.
 *
 * No framework: Node's built-in http + @solana/web3.js + the keeper's
 * decodeKind2Fields. Read-only — it never sends a transaction.
 *
 * Market addresses come from kind2-smoke-state.json (written by the smoke
 * setup) or env (KIND2_SLAB / KIND2_PROGRAM_ID). RPC is Helius devnet if
 * HELIUS_DEVNET_API_KEY is set, else public devnet.
 *
 * Run:
 *   HELIUS_DEVNET_API_KEY=<key> pnpm run kind2:status
 *   # then open http://localhost:8787  (or http://<your-LAN-IP>:8787 on a phone)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import * as fs from "node:fs";
import { decodeKind2Fields } from "../src/services/kind2-decoder.js";

// ─── Config ────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787);
const HELIUS_KEY = process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY;
const RPC = HELIUS_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : "https://api.devnet.solana.com";

// Slab layout constants (verified against a live devnet slab, 2026-06).
const HEADER_LEN = 136;
const CONFIG_LEN = 2176;
const CONFIG_END = HEADER_LEN + CONFIG_LEN; // 2312
const RING_OFFSET = CONFIG_END - 1560; // 752 — oracle_ring_buf[60] (end-relative -1560)
const RING_ENTRIES = 60;
const RING_ENTRY_LEN = 24; // p_yes_e6 u64 | source_timestamp i64 | on_chain_slot u64
const INDEX_FEED_ID_OFFSET = HEADER_LEN + 64; // 200
const MIN_RING_FILLS = 10;
const MAX_STALENESS_SLOTS = 720; // trade-time TWAP window
const MIN_ACTIVATION_DELAY_SLOTS = 216_000; // ~24h @ 0.4s/slot
const SLOT_SECS = 0.4;
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

function loadMarket(): { slab: string; programId: string; rpcFromState?: string } {
  // Prefer the smoke-setup state file; fall back to env.
  try {
    const st = JSON.parse(fs.readFileSync("./kind2-smoke-state.json", "utf-8"));
    if (st.slab && st.programId) {
      return { slab: st.slab, programId: st.programId, rpcFromState: st.rpc };
    }
  } catch {
    /* fall through to env */
  }
  const slab = process.env.KIND2_SLAB;
  const programId = process.env.KIND2_PROGRAM_ID;
  if (!slab || !programId) {
    throw new Error(
      "No market found. Run smoke setup (writes kind2-smoke-state.json) or set KIND2_SLAB + KIND2_PROGRAM_ID.",
    );
  }
  return { slab, programId };
}

const MARKET = loadMarket();
const connection = new Connection(RPC, "confirmed");

// ─── Pyth PDA derivation (mirror of the push cranker) ───────────────────

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// Inline the SDK's push-oracle PDA derivation lazily (avoid a hard import path).
let derivePythPushOraclePDA: ((feedHex: string) => [PublicKey, number]) | null = null;
async function pythAccountFor(feedId: Uint8Array): Promise<PublicKey | null> {
  try {
    if (!derivePythPushOraclePDA) {
      const sdk = await import("@percolatorct/sdk");
      derivePythPushOraclePDA = sdk.derivePythPushOraclePDA;
    }
    return derivePythPushOraclePDA(toHex(feedId))[0];
  } catch {
    return null;
  }
}

// ─── Snapshot model ─────────────────────────────────────────────────────

interface RingEntry {
  idx: number;
  pYesE6: number;
  ts: number;
  slot: number;
}
interface Snapshot {
  ok: boolean;
  error?: string;
  fetchedAt: string;
  nowSecs: number;
  currentSlot: number;
  slab: string;
  programId: string;
  rpc: string;
  // kind=2 config
  linked: boolean;
  resolved: boolean;
  oracleSource: number;
  thresholdE6: number;
  scaleBpsPerPct: number;
  deviationBps: number;
  forceCloseTs: number;
  forcedClosePriceE6: number;
  linkedAtSlot: number;
  conditionIdHex: string;
  // ring
  ringFilled: number;
  ringTwapE6: number | null;
  latest: RingEntry | null;
  ring: RingEntry[];
  // live pyth
  pythAccount: string | null;
  btcPriceUsd: number | null;
  pythPublishAgeSecs: number | null;
  formulaPYesE6: number | null;
}

function pyFormula(priceE6: number, thresholdE6: number, scaleBpsPerPct: number): number | null {
  if (thresholdE6 <= 0) return 500_000;
  // p_change = scale * delta * 10_000 / threshold ; p = clamp(500000 + p_change)
  const delta = priceE6 - thresholdE6;
  const pChange = Math.trunc((scaleBpsPerPct * delta * 10_000) / thresholdE6);
  const p = 500_000 + pChange;
  return Math.max(10_000, Math.min(990_000, p));
}

async function snapshot(): Promise<Snapshot> {
  const base: Snapshot = {
    ok: false,
    fetchedAt: new Date().toISOString(),
    nowSecs: Math.floor(Date.now() / 1000),
    currentSlot: 0,
    slab: MARKET.slab,
    programId: MARKET.programId,
    rpc: HELIUS_KEY ? "Helius (devnet)" : "Public devnet",
    linked: false,
    resolved: false,
    oracleSource: -1,
    thresholdE6: 0,
    scaleBpsPerPct: 0,
    deviationBps: 0,
    forceCloseTs: 0,
    forcedClosePriceE6: 0,
    linkedAtSlot: 0,
    conditionIdHex: "",
    ringFilled: 0,
    ringTwapE6: null,
    latest: null,
    ring: [],
    pythAccount: null,
    btcPriceUsd: null,
    pythPublishAgeSecs: null,
    formulaPYesE6: null,
  };
  try {
    const slabPk = new PublicKey(MARKET.slab);
    const [ai, slot] = await Promise.all([
      connection.getAccountInfo(slabPk),
      connection.getSlot("confirmed"),
    ]);
    base.currentSlot = slot;
    if (!ai) {
      base.error = "slab account not found";
      return base;
    }
    const d = Buffer.from(ai.data);

    // kind=2 config fields (decoder slice ends at the real config tail)
    const cfgSlice = d.subarray(HEADER_LEN, CONFIG_END);
    const f = decodeKind2Fields(cfgSlice);
    if (f) {
      base.linked = !f.polymarketConditionId.every((b) => b === 0);
      base.resolved = f.forcedClosePriceE6 !== 0n;
      base.oracleSource = f.oracleSource;
      base.thresholdE6 = Number(f.pythThresholdE6);
      base.scaleBpsPerPct = f.pythScaleBpsPerPct;
      base.deviationBps = f.valueDeviationBps;
      base.forceCloseTs = Number(f.forceCloseUnixTimestamp);
      base.forcedClosePriceE6 = Number(f.forcedClosePriceE6);
      base.linkedAtSlot = Number(f.linkedAtSlot);
      base.conditionIdHex = toHex(f.polymarketConditionId);
    }

    // oracle ring
    const ring: RingEntry[] = [];
    let sum = 0;
    for (let i = 0; i < RING_ENTRIES; i++) {
      const o = RING_OFFSET + i * RING_ENTRY_LEN;
      const ts = Number(d.readBigInt64LE(o + 8));
      if (ts === 0) continue;
      const pYesE6 = Number(d.readBigUInt64LE(o));
      const eslot = Number(d.readBigUInt64LE(o + 16));
      ring.push({ idx: i, pYesE6, ts, slot: eslot });
      sum += pYesE6;
    }
    ring.sort((a, b) => a.ts - b.ts);
    base.ring = ring;
    base.ringFilled = ring.length;
    base.ringTwapE6 = ring.length ? Math.round(sum / ring.length) : null;
    base.latest = ring.length ? ring[ring.length - 1] : null;

    // live pyth (index_feed_id at config offset 64)
    const feedId = new Uint8Array(d.subarray(INDEX_FEED_ID_OFFSET, INDEX_FEED_ID_OFFSET + 32));
    if (!feedId.every((b) => b === 0)) {
      const pythPk = await pythAccountFor(feedId);
      if (pythPk) {
        base.pythAccount = pythPk.toBase58();
        const pai = await connection.getAccountInfo(pythPk);
        if (pai && pai.owner.toBase58() === PYTH_RECEIVER) {
          const pd = Buffer.from(pai.data);
          const rawPrice = Number(pd.readBigInt64LE(73));
          const expo = pd.readInt32LE(89);
          const pub = Number(pd.readBigInt64LE(93));
          base.btcPriceUsd = rawPrice * Math.pow(10, expo);
          base.pythPublishAgeSecs = base.nowSecs - pub;
          const priceE6 = Math.trunc(rawPrice * Math.pow(10, expo + 6));
          base.formulaPYesE6 = pyFormula(priceE6, base.thresholdE6, base.scaleBpsPerPct);
        }
      }
    }

    base.ok = true;
    return base;
  } catch (e) {
    base.error = String((e as Error).message ?? e);
    return base;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────

const pct = (e6: number | null): string => (e6 == null ? "—" : (e6 / 10_000).toFixed(2) + "%");
const usd = (n: number | null): string =>
  n == null ? "—" : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
function dur(secs: number): string {
  if (secs <= 0) return "elapsed";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function renderHtml(s: Snapshot): string {
  const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
  const ttfc = s.forceCloseTs - s.nowSecs;
  const activationSlot = s.linkedAtSlot + MIN_ACTIVATION_DELAY_SLOTS;
  const activationSecs = (activationSlot - s.currentSlot) * SLOT_SECS;
  const lastPushAge = s.latest ? s.nowSecs - s.latest.ts : null;
  const stateLabel = s.resolved ? "RESOLVED" : s.linked ? "LIVE" : "UNLINKED";
  const stateColor = s.resolved ? "#a78bfa" : s.linked ? "#34d399" : "#fbbf24";
  const settleable = s.ringFilled >= MIN_RING_FILLS;

  const card = (title: string, body: string) =>
    `<div class="card"><div class="t">${title}</div>${body}</div>`;
  const row = (k: string, v: string, sub = "") =>
    `<div class="row"><span class="k">${k}</span><span class="v">${v}${sub ? `<span class="sub">${sub}</span>` : ""}</span></div>`;

  // sparkline of last ~30 p_yes values
  const spark = (() => {
    const pts = s.ring.slice(-30).map((e) => e.pYesE6);
    if (pts.length < 2) return "";
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const w = 280, h = 40;
    const path = pts
      .map((p, i) => {
        const x = (i / (pts.length - 1)) * w;
        const y = h - ((p - min) / span) * h;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="spark"><path d="${path}"/></svg>`;
  })();

  const ringRows = s.ring
    .slice(-12)
    .reverse()
    .map(
      (e) =>
        `<tr><td>${e.idx}</td><td>${pct(e.pYesE6)}</td><td>${e.slot}</td><td>${dur(s.nowSecs - e.ts)} ago</td></tr>`,
    )
    .join("");

  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="5"/>
<title>kind=2 devnet · ${esc(stateLabel)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0f17;color:#e5e7eb;font:15px/1.5 -apple-system,Segoe UI,Roboto,system-ui,sans-serif}
  .wrap{max-width:680px;margin:0 auto;padding:18px}
  h1{font-size:18px;margin:0 0 2px;display:flex;align-items:center;gap:10px}
  .badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:${stateColor}22;color:${stateColor};border:1px solid ${stateColor}55}
  .meta{color:#6b7280;font-size:12px;margin-bottom:14px;word-break:break-all}
  .meta a{color:#60a5fa;text-decoration:none}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.grid{grid-template-columns:1fr}}
  .card{background:#121826;border:1px solid #1f2937;border-radius:14px;padding:14px}
  .card.full{grid-column:1/-1}
  .t{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#9ca3af;margin-bottom:10px}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0}
  .k{color:#9ca3af;font-size:13px}
  .v{font-weight:600;font-variant-numeric:tabular-nums}
  .v .sub{color:#6b7280;font-weight:400;font-size:12px;margin-left:6px}
  .big{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
  .spark path{fill:none;stroke:#34d399;stroke-width:2}
  table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
  th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #1f2937}
  th{color:#6b7280;font-weight:500}
  .err{background:#3f1d1d;border:1px solid #7f1d1d;color:#fca5a5;padding:10px;border-radius:10px;margin-bottom:12px}
  .ok{color:#34d399}.warn{color:#fbbf24}
</style></head><body><div class="wrap">
<h1>Polymarket-perp · devnet <span class="badge">${esc(stateLabel)}</span></h1>
<div class="meta">market <a href="${explorer(s.slab)}" target="_blank">${esc(s.slab.slice(0, 8))}…${esc(s.slab.slice(-6))}</a> · ${esc(s.rpc)} · updated ${esc(s.fetchedAt.slice(11, 19))}Z · auto-refresh 5s</div>
${s.error ? `<div class="err">⚠ ${esc(s.error)}</div>` : ""}
<div class="grid">
  ${card(
    "Oracle ring",
    `<div class="big ${settleable ? "ok" : "warn"}">${s.ringFilled}<span class="sub" style="font-size:14px">/ ${RING_ENTRIES} filled</span></div>
     ${spark}
     ${row("Latest p_yes", pct(s.latest?.pYesE6 ?? null))}
     ${row("Ring avg (TWAP)", pct(s.ringTwapE6))}
     ${row("Last push", lastPushAge == null ? "—" : dur(lastPushAge) + " ago")}
     ${row("Settleable", settleable ? '<span class="ok">yes (≥10)</span>' : `<span class="warn">no (${s.ringFilled}/10)</span>`)}`,
  )}
  ${card(
    "Live oracle (Pyth BTC/USD)",
    `<div class="big">${usd(s.btcPriceUsd)}</div>
     ${row("Threshold", usd(s.thresholdE6 / 1e6))}
     ${row("Implied p_yes", pct(s.formulaPYesE6), "from price")}
     ${row("Deviation cap", (s.deviationBps / 100).toFixed(0) + "%")}
     ${row("Pyth age", s.pythPublishAgeSecs == null ? "—" : s.pythPublishAgeSecs + "s")}`,
  )}
  ${card(
    "Force-close",
    `${row("Countdown", ttfc > 0 ? dur(ttfc) : '<span class="warn">ELIGIBLE</span>')}
     ${row("At (UTC)", s.forceCloseTs ? new Date(s.forceCloseTs * 1000).toISOString().slice(0, 16).replace("T", " ") : "—")}
     ${row("Settled price", s.resolved ? pct(s.forcedClosePriceE6) : "not yet")}`,
  )}
  ${card(
    "Activation timelock",
    `${row("Trading opens in", activationSecs > 0 ? dur(activationSecs) : '<span class="ok">OPEN</span>')}
     ${row("Linked at slot", s.linkedAtSlot ? String(s.linkedAtSlot) : "—")}
     ${row("Current slot", String(s.currentSlot))}`,
  )}
  ${card(
    "Recent ring entries",
    `<table><thead><tr><th>idx</th><th>p_yes</th><th>slot</th><th>age</th></tr></thead><tbody>${ringRows || '<tr><td colspan="4" style="color:#6b7280">no entries yet</td></tr>'}</tbody></table>`,
  ).replace('class="card"', 'class="card full"')}
</div>
<div class="meta" style="margin-top:14px">condition_id ${esc(s.conditionIdHex.slice(0, 16))}… · program <a href="${explorer(s.programId)}" target="_blank">${esc(s.programId.slice(0, 8))}…</a></div>
</div></body></html>`;
}

// ─── Server (with a short cache so a refresh storm can't hammer the RPC) ──

let cache: { at: number; snap: Snapshot } | null = null;
const CACHE_MS = 3000;
async function getSnap(): Promise<Snapshot> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.snap;
  const snap = await snapshot();
  cache = { at: now, snap };
  return snap;
}

const server = createServer(async (req, res) => {
  try {
    const snap = await getSnap();
    if (req.url?.startsWith("/json")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(snap, null, 2));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml(snap));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("error: " + String((e as Error).message ?? e));
  }
});

function lanUrls(port: number): string[] {
  const out: string[] = [`http://localhost:${port}`];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(`http://${ni.address}:${port}`);
    }
  }
  return out;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("kind=2 devnet status dashboard");
  console.log(`  market: ${MARKET.slab}`);
  console.log(`  RPC:    ${HELIUS_KEY ? "Helius (devnet)" : "Public devnet"}`);
  console.log("  open:");
  for (const u of lanUrls(PORT)) console.log(`    ${u}`);
  console.log(`    ${"/json"} for raw data`);
  console.log("  (phone on the same Wi-Fi: use the LAN URL; Ctrl-C to stop)");
});
