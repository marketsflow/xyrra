/**
 * Backfill Polymarket BTC 4h up/down events + entry ticks from Gamma + CLOB history
 * + Binance spot klines.
 *
 * Usage:
 *   npx tsx scripts/backfill-polymarket.mjs
 *   FROM=2026-10-01T00:00:00Z TO=2026-10-16T00:00:00Z npx tsx scripts/backfill-polymarket.mjs
 *   SUPABASE_URL=https://….supabase.co npx tsx scripts/backfill-polymarket.mjs
 *
 * Optional:
 *   FROM=ISO   (default 2026-10-01T00:00:00Z)
 *   TO=ISO     (default now, snapped to closed 4h end)
 *   FIDELITY=1 history bucket minutes for new ticks (default 5)
 *   DRY_RUN=1
 *   PATCH_ONLY=1  only fill null spot_price / price_to_beat on existing ticks
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const WINDOW_SEC = 4 * 60 * 60;
const ASSET = "btc";
const SYMBOL = "BTC";

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    env[trimmed.slice(0, i)] = trimmed.slice(i + 1);
  }
  return env;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fileEnv = {
  ...loadEnvFile(resolve(root, ".env.production.local")),
  ...loadEnvFile(resolve(root, ".env.local")),
  ...loadEnvFile(resolve(root, ".env")),
};

function resolveSupabase() {
  const url = (
    process.env.SUPABASE_URL ||
    fileEnv.SUPABASE_URL ||
    fileEnv.VITE_SUPABASE_URL ||
    ""
  ).replace(/\/$/, "");
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY || "";
  // Local URL in .env.local — prefer linked remote when SRK looks like local JWT or URL is localhost.
  if (!url || url.includes("127.0.0.1") || url.includes("localhost")) {
    return { url: "", key: "" };
  }
  return { url, key };
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
      }
      if (!text) return null;
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

function alignWindowStart(sec) {
  return Math.floor(sec / WINDOW_SEC) * WINDOW_SEC;
}

function windowStarts(fromMs, toMs) {
  const first = alignWindowStart(Math.floor(fromMs / 1000));
  const lastExclusive = alignWindowStart(Math.floor(toMs / 1000));
  const starts = [];
  for (let s = first; s < lastExclusive; s += WINDOW_SEC) starts.push(s);
  return starts;
}

function pickMarket(event) {
  const markets = event.markets || [];
  return (
    markets.find((m) => parseJsonArray(m.clobTokenIds).length >= 2) ?? null
  );
}

function extractPriceToBeat(event, market) {
  const fromMeta = parseNumber(event.eventMetadata?.priceToBeat);
  if (fromMeta !== null) return fromMeta;
  const text = [market?.description, event.description, market?.question, event.title]
    .filter(Boolean)
    .join("\n");
  const match = text.match(/price to beat[^$0-9]{0,40}\$?([0-9,]+\.?\d*)/i);
  if (!match?.[1]) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

async function fetchGammaEvent(slug) {
  const data = await fetchJson(
    `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&closed=true&limit=1`,
  );
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function fetchPriceHistory(tokenId, startTs, endTs, fidelity) {
  const url =
    `${CLOB_BASE}/prices-history` +
    `?market=${encodeURIComponent(tokenId)}` +
    `&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
  const data = await fetchJson(url);
  const history = data?.history;
  return Array.isArray(history) ? history : [];
}

/** BTCUSDT open at/after timestamp (1m kline). */
async function fetchBtcSpotAt(ms) {
  const url =
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m` +
    `&startTime=${ms}&limit=1`;
  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data[0]) return null;
  return parseNumber(data[0][1]);
}

/** Map minute-start ms → open price for a 4h window. */
async function fetchBtcSpotMap(startSec, endSec) {
  const map = new Map();
  let cursor = startSec * 1000;
  const endMs = endSec * 1000;
  while (cursor < endMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const data = await fetchJson(url);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      const t = Number(row[0]);
      const open = parseNumber(row[1]);
      if (Number.isFinite(t) && open !== null) map.set(t, open);
    }
    const last = Number(data[data.length - 1][0]);
    if (!Number.isFinite(last) || last <= cursor) break;
    cursor = last + 60_000;
    await sleep(50);
  }
  return map;
}

function spotFromMap(map, tsSec) {
  const minuteMs = Math.floor(tsSec / 60) * 60 * 1000;
  if (map.has(minuteMs)) return map.get(minuteMs);
  // nearest previous minute within 5m
  for (let i = 1; i <= 5; i++) {
    const t = minuteMs - i * 60_000;
    if (map.has(t)) return map.get(t);
  }
  return null;
}

function restHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...extra,
  };
}

async function supabase(url, key, path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: restHeaders(key, prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 300)}`);
  }
  return data;
}

async function upsertEvent(url, key, tickLike) {
  const row = {
    id: tickLike.event_id,
    asset: ASSET,
    slug: tickLike.event_slug,
    title: tickLike.question,
    market_id: tickLike.market_id,
    condition_id: tickLike.condition_id,
    up_token_id: tickLike.up_token_id,
    down_token_id: tickLike.down_token_id,
    price_to_beat: tickLike.price_to_beat,
    start_at: tickLike.market_start_at,
    end_at: tickLike.market_end_at,
    updated_at: new Date().toISOString(),
  };
  await supabase(url, key, "polymarket_events?on_conflict=id", {
    method: "POST",
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

async function insertTicks(url, key, ticks) {
  if (!ticks.length) return;
  // Chunk to avoid payload limits.
  for (let i = 0; i < ticks.length; i += 100) {
    const chunk = ticks.slice(i, i + 100);
    await supabase(url, key, "polymarket_ticks", {
      method: "POST",
      body: chunk,
      prefer: "return=minimal",
    });
  }
}

async function patchTick(url, key, id, patch) {
  await supabase(url, key, `polymarket_ticks?id=eq.${id}`, {
    method: "PATCH",
    body: patch,
    prefer: "return=minimal",
  });
}

async function listNullSpotTicks(url, key) {
  const rows = [];
  let offset = 0;
  const page = 500;
  for (;;) {
    const batch = await supabase(
      url,
      key,
      `polymarket_ticks?select=id,recorded_at,event_slug,spot_price,price_to_beat,market_start_at,market_end_at` +
        `&or=(spot_price.is.null,price_to_beat.is.null,market_start_at.is.null)` +
        `&order=id.asc&limit=${page}&offset=${offset}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < page) break;
    offset += page;
  }
  return rows;
}

async function loadEventMap(url, key) {
  const rows = await supabase(
    url,
    key,
    "polymarket_events?select=slug,price_to_beat,start_at,end_at&asset=eq.btc",
  );
  const map = new Map();
  for (const row of rows || []) map.set(row.slug, row);
  return map;
}

async function hasEntryTick(url, key, slug, startIso, endIso) {
  const rows = await supabase(
    url,
    key,
    `polymarket_ticks?select=id,spot_price,recorded_at` +
      `&event_slug=eq.${encodeURIComponent(slug)}` +
      `&recorded_at=gte.${encodeURIComponent(startIso)}` +
      `&recorded_at=lt.${encodeURIComponent(endIso)}` +
      `&order=recorded_at.asc&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function patchExistingNulls(url, key, dryRun) {
  const events = await loadEventMap(url, key);
  const rows = await listNullSpotTicks(url, key);
  console.log(`Patching ${rows.length} ticks with missing spot/price_to_beat/start…`);
  let patched = 0;
  for (const row of rows) {
    const patch = {};
    if (row.spot_price == null && row.recorded_at) {
      const spot = await fetchBtcSpotAt(Date.parse(row.recorded_at));
      if (spot !== null) patch.spot_price = Number(spot.toFixed(6));
      await sleep(40);
    }
    const event = row.event_slug ? events.get(row.event_slug) : null;
    if (row.price_to_beat == null && event?.price_to_beat != null) {
      patch.price_to_beat = event.price_to_beat;
    }
    if (row.market_start_at == null && event?.start_at) patch.market_start_at = event.start_at;
    if (row.market_end_at == null && event?.end_at) patch.market_end_at = event.end_at;
    if (Object.keys(patch).length === 0) continue;
    if (!dryRun) await patchTick(url, key, row.id, patch);
    patched += 1;
    if (patched % 25 === 0) console.log(`  patched ${patched}/${rows.length}`);
  }
  console.log(`Patched ${patched} ticks.`);
}

async function backfillWindow(url, key, startSec, fidelity, dryRun) {
  const slug = `${ASSET}-updown-4h-${startSec}`;
  const endSec = startSec + WINDOW_SEC;
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date(endSec * 1000).toISOString();

  const event = await fetchGammaEvent(slug);
  if (!event?.id) {
    return { slug, status: "missing_event" };
  }
  const market = pickMarket(event);
  if (!market) return { slug, status: "missing_market" };

  const tokenIds = parseJsonArray(market.clobTokenIds);
  if (tokenIds.length < 2) return { slug, status: "missing_tokens" };
  const [upTokenId, downTokenId] = tokenIds;
  const priceToBeat = extractPriceToBeat(event, market);
  const marketStartAt = market.eventStartTime ?? startIso;
  const marketEndAt = market.endDate ?? event.endDate ?? endIso;
  const question = market.question ?? event.title ?? null;

  const eventRow = {
    event_id: String(event.id),
    event_slug: event.slug || slug,
    market_id: market.id ? String(market.id) : null,
    condition_id: market.conditionId ?? null,
    up_token_id: upTokenId,
    down_token_id: downTokenId,
    price_to_beat: priceToBeat,
    market_start_at: marketStartAt,
    market_end_at: marketEndAt,
    question,
  };

  if (!dryRun) await upsertEvent(url, key, eventRow);

  const existing = dryRun ? null : await hasEntryTick(url, key, slug, startIso, endIso);
  const needsInsert = !existing || existing.spot_price == null;

  const [upHistory, downHistory, spotMap] = await Promise.all([
    fetchPriceHistory(upTokenId, startSec, endSec, fidelity),
    fetchPriceHistory(downTokenId, startSec, endSec, fidelity),
    fetchBtcSpotMap(startSec, endSec),
  ]);

  if (upHistory.length === 0) {
    // Still upserted event; no prices available.
    if (existing && existing.spot_price == null && !dryRun) {
      const spot =
        spotFromMap(spotMap, Math.floor(Date.parse(existing.recorded_at) / 1000)) ??
        (await fetchBtcSpotAt(Date.parse(existing.recorded_at)));
      if (spot !== null) {
        await patchTick(url, key, existing.id, {
          spot_price: Number(spot.toFixed(6)),
          price_to_beat: priceToBeat,
          market_start_at: marketStartAt,
          market_end_at: marketEndAt,
        });
        return { slug, status: "patched_existing", ticks: 0 };
      }
    }
    return { slug, status: "no_history", event: true };
  }

  const downByT = new Map(downHistory.map((p) => [p.t, parseNumber(p.p)]));
  const ticks = [];

  for (const point of upHistory) {
    const t = Number(point.t);
    if (!Number.isFinite(t)) continue;
    const upPrice = parseNumber(point.p);
    if (upPrice === null) continue;
    const downPrice = downByT.get(t) ?? Number((1 - upPrice).toFixed(6));
    const recordedAt = new Date(t * 1000).toISOString();
    const spot = spotFromMap(spotMap, t);
    ticks.push({
      asset: ASSET,
      symbol: SYMBOL,
      event_id: String(event.id),
      event_slug: event.slug || slug,
      market_id: market.id ? String(market.id) : null,
      question,
      condition_id: market.conditionId ?? null,
      up_token_id: upTokenId,
      down_token_id: downTokenId,
      up_price: upPrice,
      down_price: downPrice,
      up_bid: null,
      up_ask: null,
      down_bid: null,
      down_ask: null,
      price_to_beat: priceToBeat,
      spot_price: spot === null || spot === undefined ? null : Number(Number(spot).toFixed(6)),
      seconds_remaining: Math.max(0, endSec - t),
      bid_depth_top5: null,
      ask_depth_top5: null,
      order_book_imbalance: null,
      market_start_at: marketStartAt,
      market_end_at: marketEndAt,
      recorded_at: recordedAt,
    });
  }

  // If we already have ticks, only ensure a good entry tick (first history point).
  if (existing && needsInsert) {
    const entry = ticks[0];
    if (entry) {
      if (!dryRun) {
        await patchTick(url, key, existing.id, {
          spot_price: entry.spot_price,
          price_to_beat: entry.price_to_beat,
          market_start_at: entry.market_start_at,
          market_end_at: entry.market_end_at,
          up_price: entry.up_price,
          down_price: entry.down_price,
        });
        // Also insert earlier history point if it is before the existing first tick.
        if (Date.parse(entry.recorded_at) < Date.parse(existing.recorded_at)) {
          await insertTicks(url, key, [entry]);
        }
      }
      return { slug, status: "patched_entry", ticks: 1 };
    }
  }

  if (!existing && ticks.length) {
    if (!dryRun) await insertTicks(url, key, ticks);
    return { slug, status: "inserted", ticks: ticks.length };
  }

  return { slug, status: existing ? "already_ok" : "skipped", ticks: 0 };
}

async function main() {
  let { url, key } = resolveSupabase();

  // Fall back to linked remote project when local env points at localhost.
  if (!url || !key) {
    const { execSync } = await import("node:child_process");
    try {
      const ref = readFileSync(resolve(root, "supabase/.temp/project-ref"), "utf8").trim();
      url = `https://${ref}.supabase.co`;
      const raw = execSync(`supabase projects api-keys --project-ref ${ref} -o json`, {
        encoding: "utf8",
      });
      const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
      key = arr.find((k) => k.name === "service_role")?.api_key || "";
      console.log(`Using linked Supabase project ${ref}`);
    } catch (err) {
      console.error("Unable to resolve Supabase URL/key:", err.message || err);
      process.exit(1);
    }
  }

  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const fromIso = process.env.FROM || "2026-10-01T00:00:00Z";
  const toIso = process.env.TO || new Date().toISOString();
  const fidelity = Math.max(1, Number(process.env.FIDELITY || 5) || 5);
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const patchOnly =
    process.env.PATCH_ONLY === "1" || process.env.PATCH_ONLY === "true";

  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    console.error("Invalid FROM/TO");
    process.exit(1);
  }

  console.log(
    `Polymarket backfill ${fromIso} → ${toIso}` +
      ` fidelity=${fidelity}m dryRun=${dryRun} @ ${url}`,
  );

  await patchExistingNulls(url, key, dryRun);
  if (patchOnly) return;

  const starts = windowStarts(fromMs, toMs);
  console.log(`Windows to process: ${starts.length}`);

  const summary = {
    missing_event: 0,
    missing_market: 0,
    missing_tokens: 0,
    no_history: 0,
    inserted: 0,
    patched_entry: 0,
    patched_existing: 0,
    already_ok: 0,
    skipped: 0,
    ticks: 0,
  };

  for (const startSec of starts) {
    try {
      const result = await backfillWindow(url, key, startSec, fidelity, dryRun);
      summary[result.status] = (summary[result.status] || 0) + 1;
      summary.ticks += result.ticks || 0;
      console.log(
        `${new Date(startSec * 1000).toISOString()} ${result.slug} → ${result.status}` +
          (result.ticks ? ` (+${result.ticks} ticks)` : ""),
      );
      await sleep(120);
    } catch (err) {
      console.error(
        `${new Date(startSec * 1000).toISOString()} ERROR`,
        err instanceof Error ? err.message : err,
      );
      await sleep(500);
    }
  }

  console.log("Done.", summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
