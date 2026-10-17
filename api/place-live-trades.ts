/**
 * Live trading bot: when Price Levels (crypto_price tf=4h) has a Signal for the
 * current open BTC window, place the equivalent Polymarket 4h Up/Down order —
 * same mapping as Virtual Trades (Above→LONG_UP, Below→LONG_DOWN).
 *
 * Gated by live_trade_settings: automation_enabled + allowed_signal_rules.
 *
 * Auth: CRON_SECRET or admin Bearer.
 * Env: SUPABASE_*, POLYMARKET_PRIVATE_KEY, optional POLYMARKET_WALLET_ADDRESS.
 *
 * Runs in Vercel dub1 (Ireland) — required so CLOB orders are not geoblocked.
 * Pref lights geoblock + ask-book depth; thin books / geoblock skip without FAILED rows.
 */

import { AssetType, createSecureClient, OrderSide } from "@polymarket/client";
import {
  fetchBalanceAllowance,
  updateBalanceAllowance,
} from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";

const WINDOW_SEC = 4 * 60 * 60;
const ANALYSIS_TIMEFRAME = 240;
const BTC_SYMBOL = "BTC";
const DEFAULT_POSITION_SIZE_PCT = 10;
const COLLATERAL_SCALE = 10n ** 6n;
const MIN_STAKE_USD = 0.1;
const CLOB_BASE = "https://clob.polymarket.com";
const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";
/** Require ask notional ≥ stake × buffer before attempting a FAK buy. */
const ASK_LIQUIDITY_BUFFER = 1.05;

export type PlaceLiveTradesEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
  POLYMARKET_PRIVATE_KEY?: string;
  POLYMARKET_WALLET_ADDRESS?: string;
};

type SecureClientInstance = Awaited<ReturnType<typeof createSecureClient>>;

let cachedClient: SecureClientInstance | null = null;
let cachedFingerprint: string | null = null;

/** Self-contained — no relative imports (Vercel ESM + type:module). */
function normalizePrivateKey(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\s+/g, "");
  if (!value) return "";
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 12) {
    throw new Error(
      "POLYMARKET_PRIVATE_KEY looks like a seed phrase. Use the MetaMask account private key, not the recovery phrase.",
    );
  }
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("POLYMARKET_PRIVATE_KEY must be hex (0-9, a-f).");
  }
  if (hex.length !== 64) {
    if (hex.length === 40) {
      throw new Error(
        "POLYMARKET_PRIVATE_KEY looks like a wallet address. Use Show private key (64 hex), and put the address in POLYMARKET_WALLET_ADDRESS.",
      );
    }
    throw new Error(
      `POLYMARKET_PRIVATE_KEY must be 64 hex chars. Got ${hex.length}.`,
    );
  }
  return `0x${hex.toLowerCase()}`;
}

async function getServerPolymarketClient(
  env: PlaceLiveTradesEnv,
): Promise<SecureClientInstance> {
  const keyRaw = env.POLYMARKET_PRIVATE_KEY?.trim() || "";
  if (!keyRaw) {
    throw new Error("POLYMARKET_PRIVATE_KEY is not set.");
  }
  const key = normalizePrivateKey(keyRaw);
  const wallet = env.POLYMARKET_WALLET_ADDRESS?.trim() || "";
  const fingerprint = `${key.slice(0, 10)}:${key.length}:${wallet.toLowerCase()}`;
  if (cachedClient && cachedFingerprint === fingerprint) {
    return cachedClient;
  }
  const client = await createSecureClient({
    signer: privateKey(key),
    ...(wallet ? { wallet } : {}),
  });
  cachedClient = client;
  cachedFingerprint = fingerprint;
  return client;
}

type LiveSettings = {
  automationEnabled: boolean;
  positionSizePct: number;
  maxOpenTrades: number;
  dailyLossLimitUsd: number | null;
  allowedSignalRules: number[];
};

type CryptoPriceSignal = {
  bucket_start: string;
  signal: string;
  signal_rule: number | null;
  price_level: number | null;
  price_1m: number | null;
  ema: number | null;
};

type PolymarketTick = {
  event_slug: string | null;
  question: string | null;
  up_token_id: string | null;
  down_token_id: string | null;
  up_price: number | null;
  down_price: number | null;
  price_to_beat: number | null;
  spot_price: number | null;
  recorded_at: string;
};

export type PlaceLiveTradesResult =
  | {
      success: true;
      action:
        | "skipped"
        | "placed"
        | "already_exists"
        | "no_signal"
        | "rule_blocked"
        | "risk_blocked"
        | "failed";
      message: string;
      tradeId?: number;
      marketSlug?: string;
      orderId?: string;
    }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function bearerToken(authHeader: string | null | undefined) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function restHeaders(serviceKey: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

function isRetryableLiquidityError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no resting liquidity") ||
    m.includes("insufficient liquidity") ||
    m.includes("not enough liquidity")
  );
}

function isGeoblockError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("trading restricted in your region") ||
    m.includes("geoblock") ||
    m.includes("/geoblock")
  );
}

/** Liquidity / geoblock: drop the provisional row so cron can retry cleanly. */
function isRetryableOrderError(message: string): boolean {
  return isRetryableLiquidityError(message) || isGeoblockError(message);
}

type GeoblockStatus =
  | { blocked: false; ip?: string; country?: string; region?: string }
  | { blocked: true; ip?: string; country?: string; region?: string; detail: string };

async function checkGeoblock(): Promise<GeoblockStatus> {
  try {
    const res = await fetch(GEOBLOCK_URL, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      // Fail open on geoblock probe errors — order placement will still surface blocks.
      return { blocked: false };
    }
    const data = (await res.json()) as {
      blocked?: unknown;
      ip?: unknown;
      country?: unknown;
      region?: unknown;
    };
    const ip = asString(data.ip) ?? undefined;
    const country = asString(data.country) ?? undefined;
    const region = asString(data.region) ?? undefined;
    if (data.blocked === true) {
      const where = [country, region].filter(Boolean).join("/") || "unknown region";
      return {
        blocked: true,
        ip,
        country,
        region,
        detail: `Polymarket geoblock active for ${where} (ip ${ip || "unknown"}). Live orders must run from an allowed region (Vercel dub1 / eu-west-1).`,
      };
    }
    return { blocked: false, ip, country, region };
  } catch {
    return { blocked: false };
  }
}

type BookLevel = { price?: string | number; size?: string | number };

/** USD notional available on the ask side (price × size), best levels first. */
async function fetchAskNotionalUsd(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const book = (await res.json()) as { asks?: BookLevel[] } | null;
    const asks = book?.asks;
    if (!asks?.length) return 0;
    const sorted = [...asks].sort((a, b) => {
      const pa = Number(a.price);
      const pb = Number(b.price);
      if (!Number.isFinite(pa) || !Number.isFinite(pb)) return 0;
      return pa - pb;
    });
    let notional = 0;
    for (const level of sorted) {
      const price = Number(level.price);
      const size = Number(level.size);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
        continue;
      }
      notional += price * size;
    }
    return Number(notional.toFixed(6));
  } catch {
    return null;
  }
}

async function deleteTrade(
  supabaseUrl: string,
  serviceKey: string,
  id: number,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/live_trades?id=eq.${id}`, {
    method: "DELETE",
    headers: restHeaders(serviceKey),
  });
}

function baseUnitsToNumber(balance: bigint | number | string): number {
  const raw = typeof balance === "bigint" ? balance : BigInt(String(balance));
  const whole = raw / COLLATERAL_SCALE;
  const frac = raw % COLLATERAL_SCALE;
  return Number(whole) + Number(frac) / Number(COLLATERAL_SCALE);
}

function marketSlugForStart(startSec: number) {
  return `btc-updown-4h-${startSec}`;
}

function currentOpenWindowStartSec(nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
}

function directionFromSignal(signal: string): "LONG_UP" | "LONG_DOWN" | null {
  const s = signal.trim().toLowerCase();
  if (s === "above") return "LONG_UP";
  if (s === "below") return "LONG_DOWN";
  return null;
}

function confidenceFromEma(ema: number | null): number {
  if (ema === null) return 0.5;
  return Math.min(1, Math.max(0, Number((ema / 50).toFixed(4))));
}

function formatEtClock(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return `${hour}:${minute}${period}`;
}

function formatPolymarketTitle(startSec: number, endSec: number) {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
  }).format(start);
  return `Bitcoin Up or Down - ${monthDay}, ${formatEtClock(start)}-${formatEtClock(end)} ET`;
}

async function assertAdminAccess(
  env: PlaceLiveTradesEnv,
  accessToken: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) {
    return { ok: false, message: "Supabase env is not configured.", status: 500 };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!userRes.ok) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }
  const user = (await userRes.json()) as { id?: string };
  if (!user.id) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}&limit=1`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!profileRes.ok) {
    return { ok: false, message: "Unable to verify admin role.", status: 500 };
  }
  const profiles = (await profileRes.json()) as Array<{ role?: string }>;
  const role = profiles[0]?.role;
  if (role !== "admin" && role !== "editor") {
    return { ok: false, message: "Forbidden", status: 403 };
  }
  return { ok: true };
}

async function authorize(
  env: PlaceLiveTradesEnv,
  authHeader: string | null,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const token = bearerToken(authHeader);
  if (!token) {
    return { ok: false, message: "Unauthorized", status: 401 };
  }
  if (env.CRON_SECRET && token === env.CRON_SECRET) {
    return { ok: true };
  }
  return assertAdminAccess(env, token);
}

async function loadSettings(
  supabaseUrl: string,
  serviceKey: string,
): Promise<LiveSettings> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/live_trade_settings?select=automation_enabled,position_size_pct,max_open_trades,daily_loss_limit_usd,allowed_signal_rules&id=eq.1&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to load live_trade_settings: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  const pct = asNumber(row.position_size_pct);
  const rulesRaw = row.allowed_signal_rules;
  const rules = Array.isArray(rulesRaw)
    ? rulesRaw
        .map((r) => asNumber(r))
        .filter((n): n is number => n !== null && n >= 1 && n <= 21)
    : [];

  return {
    automationEnabled: Boolean(row.automation_enabled),
    positionSizePct:
      pct !== null && pct > 0 && pct <= 100 ? pct : DEFAULT_POSITION_SIZE_PCT,
    maxOpenTrades: Math.max(1, Math.min(50, asNumber(row.max_open_trades) ?? 1)),
    dailyLossLimitUsd: asNumber(row.daily_loss_limit_usd),
    allowedSignalRules: rules,
  };
}

async function loadBtcAssetId(
  supabaseUrl: string,
  serviceKey: string,
): Promise<number> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/crypto_assets?select=id&symbol=eq.${encodeURIComponent(BTC_SYMBOL)}&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to load BTC asset: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ id?: unknown }>;
  const id = asNumber(rows[0]?.id);
  if (id === null) throw new Error("BTC asset not found in crypto_assets.");
  return id;
}

async function loadOpenWindowSignal(
  supabaseUrl: string,
  serviceKey: string,
  assetId: number,
  bucketStartIso: string,
): Promise<CryptoPriceSignal | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/crypto_price?select=bucket_start,signal,signal_rule,price_level,price_1m,ema&asset_id=eq.${assetId}&timeframe=eq.${ANALYSIS_TIMEFRAME}&bucket_start=eq.${encodeURIComponent(bucketStartIso)}&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to load crypto_price: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const signal = asString(row.signal);
  const bucketStart = asString(row.bucket_start);
  if (!signal || !bucketStart) return null;
  return {
    bucket_start: bucketStart,
    signal,
    signal_rule: asNumber(row.signal_rule),
    price_level: asNumber(row.price_level),
    price_1m: asNumber(row.price_1m),
    ema: asNumber(row.ema),
  };
}

async function loadExistingTrade(
  supabaseUrl: string,
  serviceKey: string,
  marketSlug: string,
): Promise<{ id: number; status: string } | null> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/live_trades?select=id,status&market_slug=eq.${encodeURIComponent(marketSlug)}&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to check live_trades: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ id?: unknown; status?: unknown }>;
  const id = asNumber(rows[0]?.id);
  const status = asString(rows[0]?.status);
  if (id === null || !status) return null;
  return { id, status };
}

function windowStartSecFromSlug(slug: string): number | null {
  const match = /^btc-updown-4h-(\d+)$/.exec(slug);
  if (!match) return null;
  const sec = Number(match[1]);
  return Number.isFinite(sec) ? sec : null;
}

/** True while the Polymarket 4h window is still running (not past end). */
function isMarketWindowActive(marketSlug: string, nowMs = Date.now()): boolean {
  const start = windowStartSecFromSlug(marketSlug);
  if (start === null) return true; // unknown slug — treat as active for safety
  return (start + WINDOW_SEC) * 1000 > nowMs;
}

/**
 * Count OPEN trades whose 4h window is still active.
 * Prior-period OPEN rows (settlement lag) must NOT block the next window's signal.
 * One trade per market_slug is still enforced by unique index / already_exists.
 */
async function countActiveOpenTrades(
  supabaseUrl: string,
  serviceKey: string,
): Promise<number> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/live_trades?select=id,market_slug&status=eq.OPEN&order=timestamp.desc&limit=50`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to load open live_trades: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ market_slug?: unknown }>;
  let count = 0;
  for (const row of rows) {
    const slug = asString(row.market_slug);
    if (!slug) continue;
    if (isMarketWindowActive(slug)) count += 1;
  }
  return count;
}

async function sumTodayRealizedLossUsd(
  supabaseUrl: string,
  serviceKey: string,
): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/live_trades?select=pnl_usd&status=eq.LOSS&closed_at=gte.${encodeURIComponent(dayStart.toISOString())}`,
    { headers: restHeaders(serviceKey) },
  );
  if (!res.ok) {
    throw new Error(`Failed to load daily losses: ${(await res.text()).slice(0, 300)}`);
  }
  const rows = (await res.json()) as Array<{ pnl_usd?: unknown }>;
  let loss = 0;
  for (const row of rows) {
    const pnl = asNumber(row.pnl_usd);
    if (pnl !== null && pnl < 0) loss += Math.abs(pnl);
  }
  return roundUsd(loss);
}

async function loadEntryTick(
  supabaseUrl: string,
  serviceKey: string,
  startSec: number,
): Promise<PolymarketTick | null> {
  const slug = marketSlugForStart(startSec);
  const startIso = new Date(startSec * 1000).toISOString();
  const endIso = new Date((startSec + WINDOW_SEC) * 1000).toISOString();

  const bySlug = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_ticks?select=event_slug,question,up_token_id,down_token_id,up_price,down_price,price_to_beat,spot_price,recorded_at&event_slug=eq.${encodeURIComponent(slug)}&recorded_at=gte.${encodeURIComponent(startIso)}&recorded_at=lt.${encodeURIComponent(endIso)}&order=recorded_at.asc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!bySlug.ok) {
    throw new Error(`Failed to load polymarket_ticks: ${(await bySlug.text()).slice(0, 300)}`);
  }
  const slugRows = (await bySlug.json()) as Array<Record<string, unknown>>;
  if (slugRows[0]) return mapTick(slugRows[0]);

  // Latest tick for this slug (market may have started slightly before bucket).
  const latest = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_ticks?select=event_slug,question,up_token_id,down_token_id,up_price,down_price,price_to_beat,spot_price,recorded_at&event_slug=eq.${encodeURIComponent(slug)}&order=recorded_at.desc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!latest.ok) {
    throw new Error(`Failed to load latest tick: ${(await latest.text()).slice(0, 300)}`);
  }
  const latestRows = (await latest.json()) as Array<Record<string, unknown>>;
  return latestRows[0] ? mapTick(latestRows[0]) : null;
}

function mapTick(row: Record<string, unknown>): PolymarketTick {
  return {
    event_slug: asString(row.event_slug),
    question: asString(row.question),
    up_token_id: asString(row.up_token_id),
    down_token_id: asString(row.down_token_id),
    up_price: asNumber(row.up_price),
    down_price: asNumber(row.down_price),
    price_to_beat: asNumber(row.price_to_beat),
    spot_price: asNumber(row.spot_price),
    recorded_at: asString(row.recorded_at) || new Date().toISOString(),
  };
}

async function loadPriceToBeat(
  supabaseUrl: string,
  serviceKey: string,
  startSec: number,
  tick: PolymarketTick | null,
): Promise<number | null> {
  const slug = marketSlugForStart(startSec);
  const eventRes = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_events?select=price_to_beat&slug=eq.${encodeURIComponent(slug)}&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (eventRes.ok) {
    const rows = (await eventRes.json()) as Array<{ price_to_beat?: unknown }>;
    const fromEvent = asNumber(rows[0]?.price_to_beat);
    if (fromEvent !== null) return fromEvent;
  }
  if (tick?.price_to_beat != null) return tick.price_to_beat;

  const tickRes = await fetch(
    `${supabaseUrl}/rest/v1/polymarket_ticks?select=price_to_beat&event_slug=eq.${encodeURIComponent(slug)}&price_to_beat=not.is.null&order=recorded_at.asc&limit=1`,
    { headers: restHeaders(serviceKey) },
  );
  if (!tickRes.ok) return null;
  const rows = (await tickRes.json()) as Array<{ price_to_beat?: unknown }>;
  return asNumber(rows[0]?.price_to_beat);
}

async function insertPendingTrade(
  supabaseUrl: string,
  serviceKey: string,
  payload: Record<string, unknown>,
): Promise<{ id: number } | null> {
  const res = await fetch(`${supabaseUrl}/rest/v1/live_trades`, {
    method: "POST",
    headers: {
      ...restHeaders(serviceKey),
      Prefer: "return=representation,resolution=ignore-duplicates",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    // Unique violation — another worker reserved this market.
    if (text.includes("23505") || text.toLowerCase().includes("duplicate")) {
      return null;
    }
    throw new Error(`Failed to insert live_trades: ${text.slice(0, 400)}`);
  }
  const rows = (await res.json()) as Array<{ id?: unknown }>;
  const id = asNumber(rows[0]?.id);
  return id === null ? null : { id };
}

async function updateTrade(
  supabaseUrl: string,
  serviceKey: string,
  id: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/live_trades?id=eq.${id}`,
    {
      method: "PATCH",
      headers: restHeaders(serviceKey),
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to update live_trades #${id}: ${(await res.text()).slice(0, 400)}`);
  }
}

function entryPriceFromFill(
  makingAmount: string | null | undefined,
  takingAmount: string | null | undefined,
  fallback: number,
): number {
  const making = asNumber(makingAmount);
  const taking = asNumber(takingAmount);
  if (making !== null && taking !== null && taking > 0) {
    return Number((making / taking).toFixed(4));
  }
  return Number(fallback.toFixed(4));
}

export async function placeLiveTrades(
  env: PlaceLiveTradesEnv,
  authHeader: string | null,
): Promise<PlaceLiveTradesResult> {
  const auth = await authorize(env, authHeader);
  if (!auth.ok) {
    return { success: false, message: auth.message, status: auth.status };
  }

  const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceKey) {
    return {
      success: false,
      message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
      status: 500,
    };
  }

  if (!env.POLYMARKET_PRIVATE_KEY?.trim()) {
    return {
      success: true,
      action: "skipped",
      message: "POLYMARKET_PRIVATE_KEY is not set — live bot idle.",
    };
  }

  try {
    const settings = await loadSettings(supabaseUrl, serviceKey);
    if (!settings.automationEnabled) {
      return {
        success: true,
        action: "skipped",
        message: "Automation is OFF in Live Trades Settings.",
      };
    }
    if (settings.allowedSignalRules.length === 0) {
      return {
        success: true,
        action: "skipped",
        message: "No allowed signal rules configured — live bot idle.",
      };
    }

    const startSec = currentOpenWindowStartSec();
    const endSec = startSec + WINDOW_SEC;
    const bucketStartIso = new Date(startSec * 1000).toISOString();
    const marketSlug = marketSlugForStart(startSec);

    const existing = await loadExistingTrade(supabaseUrl, serviceKey, marketSlug);
    if (existing && existing.status !== "FAILED" && existing.status !== "PENDING") {
      return {
        success: true,
        action: "already_exists",
        message: `Live trade already exists for ${marketSlug} (#${existing.id}, ${existing.status}).`,
        tradeId: existing.id,
        marketSlug,
      };
    }
    // Retry FAILED, or PENDING stuck >5m (crashed worker). Fresh PENDING = in flight.
    if (existing?.status === "FAILED") {
      await fetch(
        `${supabaseUrl}/rest/v1/live_trades?id=eq.${existing.id}`,
        { method: "DELETE", headers: restHeaders(serviceKey) },
      );
    } else if (existing?.status === "PENDING") {
      const staleRes = await fetch(
        `${supabaseUrl}/rest/v1/live_trades?select=timestamp&id=eq.${existing.id}&limit=1`,
        { headers: restHeaders(serviceKey) },
      );
      let stale = false;
      if (staleRes.ok) {
        const rows = (await staleRes.json()) as Array<{ timestamp?: unknown }>;
        const ts = asString(rows[0]?.timestamp);
        const ageMs = ts ? Date.now() - Date.parse(ts) : 0;
        stale = Number.isFinite(ageMs) && ageMs > 5 * 60_000;
      }
      if (stale) {
        await fetch(
          `${supabaseUrl}/rest/v1/live_trades?id=eq.${existing.id}`,
          { method: "DELETE", headers: restHeaders(serviceKey) },
        );
      } else {
        return {
          success: true,
          action: "already_exists",
          message: `Live trade placement already in progress for ${marketSlug}.`,
          tradeId: existing.id,
          marketSlug,
        };
      }
    }

    const assetId = await loadBtcAssetId(supabaseUrl, serviceKey);
    const signalRow = await loadOpenWindowSignal(
      supabaseUrl,
      serviceKey,
      assetId,
      bucketStartIso,
    );
    if (!signalRow) {
      return {
        success: true,
        action: "no_signal",
        message: `No Price Levels signal for current 4h window ${bucketStartIso}.`,
        marketSlug,
      };
    }

    const rule = signalRow.signal_rule;
    if (rule === null || !settings.allowedSignalRules.includes(rule)) {
      return {
        success: true,
        action: "rule_blocked",
        message:
          rule === null
            ? `Signal "${signalRow.signal}" has no rule id — not in allowed_signal_rules.`
            : `Signal rule ${rule} is not in allowed_signal_rules [${settings.allowedSignalRules.join(", ")}].`,
        marketSlug,
      };
    }

    const direction = directionFromSignal(signalRow.signal);
    if (!direction) {
      return {
        success: true,
        action: "skipped",
        message: `Unsupported signal "${signalRow.signal}" (expected Above/Below).`,
        marketSlug,
      };
    }

    // Only count OPEN trades in still-active windows. A previous 4h trade that
    // hasn't settled yet (lag) must not block placing the current window.
    const openCount = await countActiveOpenTrades(supabaseUrl, serviceKey);
    if (openCount >= settings.maxOpenTrades) {
      return {
        success: true,
        action: "risk_blocked",
        message: `Max active open trades reached (${openCount}/${settings.maxOpenTrades}).`,
        marketSlug,
      };
    }

    if (settings.dailyLossLimitUsd !== null) {
      const todayLoss = await sumTodayRealizedLossUsd(supabaseUrl, serviceKey);
      if (todayLoss >= settings.dailyLossLimitUsd) {
        return {
          success: true,
          action: "risk_blocked",
          message: `Daily loss limit hit ($${todayLoss} / $${settings.dailyLossLimitUsd}).`,
          marketSlug,
        };
      }
    }

    const tick = await loadEntryTick(supabaseUrl, serviceKey, startSec);
    if (!tick) {
      return {
        success: true,
        action: "skipped",
        message: `No Polymarket tick yet for ${marketSlug} — will retry next cron.`,
        marketSlug,
      };
    }

    const tokenId =
      direction === "LONG_UP" ? tick.up_token_id : tick.down_token_id;
    const bookPrice = direction === "LONG_UP" ? tick.up_price : tick.down_price;
    if (!tokenId || bookPrice === null || !(bookPrice > 0)) {
      return {
        success: true,
        action: "skipped",
        message: `Missing token/price on tick for ${direction} — will retry.`,
        marketSlug,
      };
    }

    const priceToBeat = await loadPriceToBeat(
      supabaseUrl,
      serviceKey,
      startSec,
      tick,
    );
    const marketTitle = formatPolymarketTitle(startSec, endSec);

    const geo = await checkGeoblock();
    if (geo.blocked) {
      return {
        success: true,
        action: "skipped",
        message: geo.detail,
        marketSlug,
      };
    }

    const client = await getServerPolymarketClient(env);
    await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
    const collateral = await fetchBalanceAllowance(client, {
      assetType: AssetType.COLLATERAL,
    });
    const collateralUsd = baseUnitsToNumber(collateral.balance);
    if (!(collateralUsd > 0)) {
      return {
        success: true,
        action: "risk_blocked",
        message: "CLOB collateral balance is zero — deposit before live trades.",
        marketSlug,
      };
    }

    const stakeUsd = roundUsd(collateralUsd * (settings.positionSizePct / 100));
    if (!(stakeUsd >= MIN_STAKE_USD)) {
      return {
        success: true,
        action: "risk_blocked",
        message: `Resolved stake $${stakeUsd} is below minimum $${MIN_STAKE_USD}.`,
        marketSlug,
      };
    }

    const askNotional = await fetchAskNotionalUsd(tokenId);
    const minAskUsd = roundUsd(stakeUsd * ASK_LIQUIDITY_BUFFER);
    if (askNotional === null) {
      return {
        success: true,
        action: "skipped",
        message: `Could not load order book for ${marketSlug} — will retry next cron.`,
        marketSlug,
      };
    }
    if (askNotional < minAskUsd) {
      return {
        success: true,
        action: "skipped",
        message: `No resting ask liquidity for ${direction} ($${askNotional.toFixed(2)} available, need ~$${minAskUsd}) — will retry next cron.`,
        marketSlug,
      };
    }

    const pending = await insertPendingTrade(supabaseUrl, serviceKey, {
      timestamp: new Date().toISOString(),
      market_slug: marketSlug,
      market_title: marketTitle,
      token_id: tokenId,
      direction,
      entry_poly_price: Number(bookPrice.toFixed(4)),
      entry_spot_price:
        tick.spot_price !== null ? Number(tick.spot_price.toFixed(2)) : null,
      strike_price:
        priceToBeat !== null ? Number(priceToBeat.toFixed(2)) : null,
      price_to_beat:
        priceToBeat !== null ? Number(priceToBeat.toFixed(6)) : null,
      price_level: signalRow.price_level,
      crypto_price_at: signalRow.bucket_start,
      xyrra_confidence: confidenceFromEma(signalRow.ema),
      signal_state: signalRow.signal,
      signal_rule: rule,
      position_size_usd: stakeUsd,
      position_size_pct: settings.positionSizePct,
      status: "PENDING",
    });

    if (!pending) {
      return {
        success: true,
        action: "already_exists",
        message: `Could not reserve ${marketSlug} (already claimed).`,
        marketSlug,
      };
    }

    try {
      // Default orderType is FAK (fill-and-kill) — partial fills OK on thin books.
      const response = await client.placeMarketOrder({
        assetId: tokenId,
        amount: stakeUsd,
        side: OrderSide.BUY,
      });

      if (!response.ok) {
        const rejectMsg = `${response.code}: ${response.message}`;
        if (isRetryableOrderError(rejectMsg)) {
          await deleteTrade(supabaseUrl, serviceKey, pending.id);
          const why = isGeoblockError(rejectMsg)
            ? `Geoblock rejected order for ${marketSlug} — check function region is dub1.`
            : `No resting liquidity for ${marketSlug} — will retry next cron.`;
          return {
            success: true,
            action: "skipped",
            message: why,
            marketSlug,
          };
        }
        await updateTrade(supabaseUrl, serviceKey, pending.id, {
          status: "FAILED",
          error_message: rejectMsg.slice(0, 500),
          order_status: "rejected",
        });
        return {
          success: true,
          action: "failed",
          message: `Order rejected for ${marketSlug}: ${response.code} — ${response.message}`,
          tradeId: pending.id,
          marketSlug,
        };
      }

      const entryPoly = entryPriceFromFill(
        response.makingAmount,
        response.takingAmount,
        bookPrice,
      );
      const actualStake =
        asNumber(response.makingAmount) !== null
          ? roundUsd(asNumber(response.makingAmount)!)
          : stakeUsd;

      await updateTrade(supabaseUrl, serviceKey, pending.id, {
        status: "OPEN",
        order_id: String(response.orderId),
        order_status: String(response.status),
        making_amount: response.makingAmount,
        taking_amount: response.takingAmount,
        trade_ids: response.tradeIds ?? [],
        entry_poly_price: entryPoly,
        position_size_usd: actualStake,
        error_message: null,
      });

      return {
        success: true,
        action: "placed",
        message: `Placed live ${direction} on ${marketSlug} (rule ${rule}, $${actualStake}, order ${response.orderId}).`,
        tradeId: pending.id,
        marketSlug,
        orderId: String(response.orderId),
      };
    } catch (orderError) {
      const msg =
        orderError instanceof Error ? orderError.message : "placeMarketOrder failed";
      if (isRetryableOrderError(msg)) {
        await deleteTrade(supabaseUrl, serviceKey, pending.id);
        const why = isGeoblockError(msg)
          ? `Geoblock rejected order for ${marketSlug} — check function region is dub1.`
          : `No resting liquidity for ${marketSlug} — will retry next cron.`;
        return {
          success: true,
          action: "skipped",
          message: why,
          marketSlug,
        };
      }
      await updateTrade(supabaseUrl, serviceKey, pending.id, {
        status: "FAILED",
        error_message: msg.slice(0, 500),
      });
      return {
        success: true,
        action: "failed",
        message: `Order error for ${marketSlug}: ${msg}`,
        tradeId: pending.id,
        marketSlug,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "place-live-trades failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 60,
  // Literal only — Vercel config parser rejects spreads (Unhandled type: SpreadElement).
  regions: ["dub1"],
};

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "POST") {
        return Response.json(
          { success: false, message: "Method not allowed" },
          { status: 405, headers: jsonHeaders() },
        );
      }

      const env: PlaceLiveTradesEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY:
          process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
        POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
        POLYMARKET_WALLET_ADDRESS: process.env.POLYMARKET_WALLET_ADDRESS,
      };

      const result = await placeLiveTrades(env, request.headers.get("authorization"));

      if (result.success) {
        return Response.json(result, { status: 200, headers: jsonHeaders() });
      }

      console.error("[place-live-trades] failed", result.status, result.message);
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "place-live-trades failed";
      return Response.json(
        { success: false, message },
        { status: 500, headers: jsonHeaders() },
      );
    }
  },
};
