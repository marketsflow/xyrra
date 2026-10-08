/**
 * Vercel Cron + admin-triggered Polymarket tick ingest.
 * Self-contained (no ./lib imports) so Vercel Node ESM can resolve the route.
 *
 * Vercel: Web Standard `default { fetch }` (GET/POST).
 * Vite: imports named `ingestPolymarketTick` for the dev middleware.
 */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const DEFAULT_ASSET = "btc";
const DEFAULT_SYMBOL = "BTC";
const WINDOW_MINUTES = [5, 15] as const;

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
  market_end_at: string | null;
  recorded_at: string;
};

type GammaMarket = {
  id?: string;
  question?: string;
  conditionId?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
  outcomePrices?: string | string[] | null;
  bestBid?: number | string | null;
  bestAsk?: number | string | null;
  endDate?: string;
  slug?: string;
};

type GammaEvent = {
  id?: string;
  slug?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
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
    slugs.push(`${asset}-updown-${minutes}m-${start}`);
    slugs.push(`${asset}-updown-${minutes}m-${start - windowSec}`);
  }
  return slugs;
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
    for (const slug of windowSlugs(this.asset)) {
      const data = (await fetchJson(
        `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&limit=1`,
      )) as GammaEvent[] | null;
      const event = Array.isArray(data) ? data[0] : null;
      if (event?.markets?.length) return event;
    }

    // Fallback: newest active events, pick first matching asset updown slug.
    const recent = (await fetchJson(
      `${GAMMA_BASE}/events?limit=40&active=true&closed=false&order=id&ascending=false`,
    )) as GammaEvent[] | null;
    if (!Array.isArray(recent)) return null;
    const prefix = `${this.asset}-updown-`;
    return recent.find((event) => (event.slug || "").startsWith(prefix) && (event.markets?.length ?? 0) > 0) ?? null;
  }

  async fetchTick(): Promise<PolymarketTick | null> {
    const event = await this.findActiveEvent();
    if (!event?.id || !event.slug) return null;

    const market = event.markets?.[0];
    if (!market) return null;

    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (tokenIds.length < 2) return null;

    const [upTokenId, downTokenId] = tokenIds;
    const outcomePrices = parseJsonArray(market.outcomePrices);

    const [upMid, downMid, upBid, upAsk, downBid, downAsk] = await Promise.all([
      fetchMidpoint(upTokenId),
      fetchMidpoint(downTokenId),
      fetchSidePrice(upTokenId, "buy"),
      fetchSidePrice(upTokenId, "sell"),
      fetchSidePrice(downTokenId, "buy"),
      fetchSidePrice(downTokenId, "sell"),
    ]);

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
      up_price: upMid ?? parseNumber(outcomePrices[0]),
      down_price: downMid ?? parseNumber(outcomePrices[1]),
      up_bid: upBid ?? parseNumber(market.bestBid),
      up_ask: upAsk ?? parseNumber(market.bestAsk),
      down_bid: downBid,
      down_ask: downAsk,
      market_end_at: market.endDate ?? event.endDate ?? null,
      recorded_at: new Date().toISOString(),
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
