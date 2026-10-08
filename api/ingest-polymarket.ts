/**
 * Vercel Cron + admin-triggered Polymarket tick ingest.
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 *
 * Vercel: Web Standard `default { fetch }` (GET/POST).
 * Vite: imports named `ingestPolymarketTick` for the dev middleware.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const BINANCE_PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const COINBASE_PRICE_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const DEFAULT_ASSET = "btc";
const DEFAULT_SYMBOL = "BTC";
/** BTC 4-hour up/down windows only (slug: btc-updown-4h-{unix}). */
const WINDOW_MINUTES = [240] as const;
const BOOK_DEPTH_LEVELS = 5;

export type IngestPolymarketEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CRON_SECRET?: string;
  POLYMARKET_ASSET?: string;
  POLYMARKET_SYMBOL?: string;
};

export type PolymarketTick = {
  asset: string;
  symbol: string;
  event_id: string;
  event_slug: string;
  market_id: string | null;
  question: string | null;
  condition_id: string | null;
  up_token_id: string;
  down_token_id: string;
  up_price: number | null;
  down_price: number | null;
  up_bid: number | null;
  up_ask: number | null;
  down_bid: number | null;
  down_ask: number | null;
  price_to_beat: number | null;
  spot_price: number | null;
  seconds_remaining: number | null;
  bid_depth_top5: number | null;
  ask_depth_top5: number | null;
  order_book_imbalance: number | null;
  market_start_at: string | null;
  market_end_at: string | null;
  recorded_at: string;
};

type BookLevel = { price?: string | number; size?: string | number };

type GammaMarket = {
  id?: string;
  question?: string;
  description?: string;
  conditionId?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  outcomePrices?: string | string[] | null;
  bestBid?: number | string | null;
  bestAsk?: number | string | null;
  endDate?: string;
  eventStartTime?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
};

type GammaEvent = {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  startDate?: string;
  startTime?: string;
  endDate?: string;
  eventMetadata?: { priceToBeat?: number | string | null } | null;
  markets?: GammaMarket[];
};

type IngestResult =
  | { success: true; tick: PolymarketTick; eventUpserted: boolean }
  | { success: false; message: string; status?: number };

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function bearerToken(authHeader: string | null | undefined) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [];
    }
  }
  return [];
}

function windowSlugs(asset: string, nowSec = Math.floor(Date.now() / 1000)): string[] {
  const slugs: string[] = [];
  for (const minutes of WINDOW_MINUTES) {
    const windowSec = minutes * 60;
    const start = Math.floor(nowSec / windowSec) * windowSec;
    // Polymarket 4h BTC markets use "4h", not "240m".
    const label = minutes === 240 ? "4h" : `${minutes}m`;
    slugs.push(`${asset}-updown-${label}-${start}`);
    slugs.push(`${asset}-updown-${label}-${start - windowSec}`);
  }
  return slugs;
}

function isShortWindowSlug(slug: string) {
  const s = slug.toLowerCase();
  return (
    s.includes("updown-5m") ||
    s.includes("updown-15m") ||
    s.includes("-5m-") ||
    s.includes("-15m-") ||
    /(^|-)5m($|-)/.test(s) ||
    /(^|-)15m($|-)/.test(s)
  );
}

function isBtcFourHourEvent(event: GammaEvent, asset: string) {
  const slug = (event.slug || "").toLowerCase();
  const title = (event.title || "").toLowerCase();

  // Never ingest ultra-short windows.
  if (isShortWindowSlug(slug) || isShortWindowSlug(title)) return false;

  // Canonical Polymarket BTC 4h slug: btc-updown-4h-{unix}
  if (slug.startsWith(`${asset}-updown-4h-`)) return true;

  const isAsset =
    slug.startsWith(`${asset}-updown-`) ||
    slug.startsWith(`${asset}-up-or-down-`) ||
    (asset === "btc" && title.includes("bitcoin") && title.includes("up or down"));

  const is4Hour =
    slug.includes("updown-4h") ||
    slug.includes("-4h-") ||
    title.includes("4 hour") ||
    title.includes("4-hour") ||
    /(^|[^0-9])4h([^a-z]|$)/i.test(slug) ||
    /(^|[^0-9])4h([^a-z]|$)/i.test(title);

  return isAsset && is4Hour;
}

function pickActiveMarket(event: GammaEvent): GammaMarket | null {
  const markets = event.markets || [];
  for (const market of markets) {
    const closed = market.closed === true;
    const inactive = market.active === false;
    if (closed || inactive) continue;
    if (parseJsonArray(market.clobTokenIds).length >= 2) return market;
  }
  // Fallback: first market with token ids (some Gamma payloads omit active flags).
  return markets.find((market) => parseJsonArray(market.clobTokenIds).length >= 2) ?? null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}: ${text.slice(0, 200)}`);
  }
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const data = (await fetchJson(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`)) as {
      mid?: string | number;
    } | null;
    return parseNumber(data?.mid);
  } catch {
    return null;
  }
}

async function fetchSidePrice(tokenId: string, side: "buy" | "sell"): Promise<number | null> {
  try {
    const data = (await fetchJson(
      `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`,
    )) as { price?: string | number } | null;
    return parseNumber(data?.price);
  } catch {
    return null;
  }
}

function parseStrikeFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const patterns = [
    /price to beat[^$0-9]{0,40}\$?([0-9,]+\.?\d*)/i,
    /(?:above|over|greater than)\s*\$?([0-9,]+\.?\d*)/i,
    /\$([0-9]{2,}(?:,[0-9]{3})*(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = parseFloat(match[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function extractPriceToBeat(event: GammaEvent, market: GammaMarket): number | null {
  const fromMetadata = parseNumber(event.eventMetadata?.priceToBeat);
  if (fromMetadata !== null) return fromMetadata;
  return (
    parseStrikeFromText(market.description) ??
    parseStrikeFromText(event.description) ??
    parseStrikeFromText(market.question) ??
    parseStrikeFromText(event.title)
  );
}

function topDepth(levels: BookLevel[] | undefined, side: "bid" | "ask", n = BOOK_DEPTH_LEVELS) {
  if (!levels?.length) return 0;
  const sorted = [...levels].sort((a, b) => {
    const pa = Number(a.price);
    const pb = Number(b.price);
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return 0;
    return side === "bid" ? pb - pa : pa - pb;
  });
  return sorted.slice(0, n).reduce((sum, level) => {
    const size = Number(level.size);
    return sum + (Number.isFinite(size) ? size : 0);
  }, 0);
}

async function fetchUpBookDepth(tokenId: string): Promise<{
  bidDepthTop5: number | null;
  askDepthTop5: number | null;
  orderBookImbalance: number | null;
}> {
  try {
    const book = (await fetchJson(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`)) as {
      bids?: BookLevel[];
      asks?: BookLevel[];
    } | null;
    const bidDepthTop5 = topDepth(book?.bids, "bid");
    const askDepthTop5 = topDepth(book?.asks, "ask");
    const total = bidDepthTop5 + askDepthTop5;
    const orderBookImbalance = total > 0 ? Number(((bidDepthTop5 - askDepthTop5) / total).toFixed(6)) : null;
    return {
      bidDepthTop5: Number(bidDepthTop5.toFixed(6)),
      askDepthTop5: Number(askDepthTop5.toFixed(6)),
      orderBookImbalance,
    };
  } catch {
    return { bidDepthTop5: null, askDepthTop5: null, orderBookImbalance: null };
  }
}

async function fetchBtcSpotPrice(): Promise<number | null> {
  try {
    const data = (await fetchJson(BINANCE_PRICE_URL)) as { price?: string | number } | null;
    const binance = parseNumber(data?.price);
    if (binance !== null) return binance;
  } catch {
    // fall through to Coinbase
  }
  try {
    const data = (await fetchJson(COINBASE_PRICE_URL)) as {
      data?: { amount?: string | number };
    } | null;
    return parseNumber(data?.data?.amount);
  } catch {
    return null;
  }
}

function secondsRemaining(endAt: string | null | undefined, nowMs = Date.now()): number | null {
  if (!endAt) return null;
  const endMs = new Date(endAt).getTime();
  if (Number.isNaN(endMs)) return null;
  return Math.max(0, Math.floor((endMs - nowMs) / 1000));
}

export class PolymarketSupabaseIngestor {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly symbol: string;
  private readonly asset: string;

  constructor(supabaseUrl: string, serviceRoleKey: string, symbol = DEFAULT_SYMBOL, asset = DEFAULT_ASSET) {
    this.supabaseUrl = supabaseUrl.replace(/\/$/, "");
    this.serviceRoleKey = serviceRoleKey;
    this.symbol = symbol;
    this.asset = asset.toLowerCase();
  }

  private restHeaders(extra: Record<string, string> = {}) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extra,
    };
  }

  async findActiveEvent(): Promise<GammaEvent | null> {
    // Prefer exact current/previous 4h window slugs: btc-updown-4h-{unix}
    for (const slug of windowSlugs(this.asset)) {
      const data = (await fetchJson(
        `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&limit=1`,
      )) as GammaEvent[] | null;
      const event = Array.isArray(data) ? data[0] : null;
      if (event && isBtcFourHourEvent(event, this.asset) && pickActiveMarket(event)) {
        return event;
      }
    }

    // Fallback: scan recent active events, keep only BTC 4h (never 5m/15m).
    const recent = (await fetchJson(
      `${GAMMA_BASE}/events?limit=80&active=true&closed=false&order=id&ascending=false`,
    )) as GammaEvent[] | null;
    if (!Array.isArray(recent)) return null;

    for (const event of recent) {
      if (!isBtcFourHourEvent(event, this.asset)) continue;
      if (pickActiveMarket(event)) return event;
    }
    return null;
  }

  async fetchTick(): Promise<PolymarketTick | null> {
    const event = await this.findActiveEvent();
    if (!event?.id || !event.slug) return null;

    const market = pickActiveMarket(event);
    if (!market) return null;

    // clobTokenIds: [UP/YES token, DOWN/NO token]
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (tokenIds.length < 2) return null;

    const [upTokenId, downTokenId] = tokenIds;
    const outcomePrices = parseJsonArray(market.outcomePrices);
    const recordedAt = new Date();
    const marketEndAt = market.endDate ?? event.endDate ?? null;
    const marketStartAt = market.eventStartTime ?? event.startTime ?? event.startDate ?? null;

    const [upMid, downMid, upBid, upAsk, downBid, downAsk, book, spotPrice] = await Promise.all([
      fetchMidpoint(upTokenId),
      fetchMidpoint(downTokenId),
      fetchSidePrice(upTokenId, "buy"),
      fetchSidePrice(upTokenId, "sell"),
      fetchSidePrice(downTokenId, "buy"),
      fetchSidePrice(downTokenId, "sell"),
      fetchUpBookDepth(upTokenId),
      fetchBtcSpotPrice(),
    ]);

    const upPrice = upMid ?? parseNumber(outcomePrices[0]);
    // Binary market: DOWN ≈ 1 - UP when the DOWN midpoint is unavailable.
    const downPrice =
      downMid ?? parseNumber(outcomePrices[1]) ?? (upPrice === null ? null : Number((1 - upPrice).toFixed(6)));

    return {
      asset: this.asset,
      symbol: this.symbol,
      event_id: String(event.id),
      event_slug: event.slug,
      market_id: market.id ? String(market.id) : null,
      question: market.question ?? event.title ?? null,
      condition_id: market.conditionId ?? null,
      up_token_id: upTokenId,
      down_token_id: downTokenId,
      up_price: upPrice,
      down_price: downPrice,
      up_bid: upBid ?? parseNumber(market.bestBid),
      up_ask: upAsk ?? parseNumber(market.bestAsk),
      down_bid: downBid,
      down_ask: downAsk,
      price_to_beat: extractPriceToBeat(event, market),
      spot_price: spotPrice,
      seconds_remaining: secondsRemaining(marketEndAt, recordedAt.getTime()),
      bid_depth_top5: book.bidDepthTop5,
      ask_depth_top5: book.askDepthTop5,
      order_book_imbalance: book.orderBookImbalance,
      market_start_at: marketStartAt,
      market_end_at: marketEndAt,
      recorded_at: recordedAt.toISOString(),
    };
  }

  async upsertEventFromTick(tick: PolymarketTick): Promise<boolean> {
    const row = {
      id: tick.event_id,
      asset: tick.asset,
      slug: tick.event_slug,
      title: tick.question,
      market_id: tick.market_id,
      condition_id: tick.condition_id,
      up_token_id: tick.up_token_id,
      down_token_id: tick.down_token_id,
      price_to_beat: tick.price_to_beat,
      start_at: tick.market_start_at,
      end_at: tick.market_end_at,
      updated_at: new Date().toISOString(),
    };

    const res = await fetch(`${this.supabaseUrl}/rest/v1/polymarket_events?on_conflict=id`, {
      method: "POST",
      headers: this.restHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to upsert polymarket_events: ${text.slice(0, 300)}`);
    }
    return true;
  }

  async insertTick(tick: PolymarketTick): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}/rest/v1/polymarket_ticks`, {
      method: "POST",
      headers: this.restHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(tick),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to insert polymarket_ticks: ${text.slice(0, 300)}`);
    }
  }
}

async function assertAdminAccess(
  env: IngestPolymarketEnv,
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

async function authorizeIngest(
  env: IngestPolymarketEnv,
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

export async function ingestPolymarketTick(
  env: IngestPolymarketEnv,
  authHeader: string | null,
): Promise<IngestResult> {
  const auth = await authorizeIngest(env, authHeader);
  if (!auth.ok) {
    return { success: false, message: auth.message, status: auth.status };
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return {
      success: false,
      message: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
      status: 500,
    };
  }

  const asset = (env.POLYMARKET_ASSET || DEFAULT_ASSET).toLowerCase();
  const symbol = (env.POLYMARKET_SYMBOL || DEFAULT_SYMBOL).toUpperCase();
  const ingestor = new PolymarketSupabaseIngestor(supabaseUrl, serviceKey, symbol, asset);

  try {
    const tick = await ingestor.fetchTick();
    if (!tick) {
      return { success: false, message: "No active market or tick found", status: 404 };
    }

    const eventUpserted = await ingestor.upsertEventFromTick(tick);
    await ingestor.insertTick(tick);
    return { success: true, tick, eventUpserted };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ingest failed";
    return { success: false, message, status: 500 };
  }
}

export const config = {
  maxDuration: 10,
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

      const env: IngestPolymarketEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        CRON_SECRET: process.env.CRON_SECRET,
        POLYMARKET_ASSET: process.env.POLYMARKET_ASSET,
        POLYMARKET_SYMBOL: process.env.POLYMARKET_SYMBOL,
      };

      const result = await ingestPolymarketTick(env, request.headers.get("authorization"));
      if (result.success) {
        return Response.json(
          { success: true, tick: result.tick, eventUpserted: result.eventUpserted },
          { status: 200, headers: jsonHeaders() },
        );
      }
      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      return Response.json({ success: false, message: msg }, { status: 500, headers: jsonHeaders() });
    }
  },
};
