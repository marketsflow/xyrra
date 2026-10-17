/**
 * Always-on Polymarket trading account (server-side private key).
 * Used by admin Live Account UI and (later) the live trading bot.
 *
 * Env:
 *   POLYMARKET_PRIVATE_KEY     — signer private key (0x…)
 *   POLYMARKET_WALLET_ADDRESS  — optional funder / deposit / Safe address
 *
 * Vite: named `fetchLiveTradingAccount`
 * Vercel: Web Standard `default { fetch }`
 */

import { AssetType, WalletType } from "@polymarket/client";
import {
  fetchBalanceAllowance,
  updateBalanceAllowance,
} from "@polymarket/client/actions";
import {
  getServerPolymarketClient,
  type ServerPolymarketEnv,
} from "../lib/server-polymarket-client";

export type LiveTradingAccountEnv = ServerPolymarketEnv & {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
};

export type LiveTradingAccountSnapshot = {
  configured: boolean;
  connected: boolean;
  signer: string | null;
  wallet: string | null;
  walletType: string | null;
  walletTypeLabel: string | null;
  collateralUsd: number | null;
  portfolioUsd: number | null;
  positionSizePct: number;
  nextTradeStakeUsd: number | null;
  automationEnabled: boolean;
  refreshedAt: string;
  message: string;
};

type FetchResult =
  | { success: true; account: LiveTradingAccountSnapshot }
  | { success: false; message: string; status?: number };

const DEFAULT_POSITION_SIZE_PCT = 10;
const COLLATERAL_SCALE = 10n ** 6n;

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8" };
}

function bearerToken(authHeader: string | null | undefined) {
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function walletTypeLabel(type: WalletType): string {
  switch (type) {
    case WalletType.EOA:
      return "EOA";
    case WalletType.POLY_PROXY:
      return "Polymarket proxy";
    case WalletType.GNOSIS_SAFE:
      return "Gnosis Safe";
    case WalletType.DEPOSIT_WALLET:
      return "Deposit wallet";
    default:
      return `Wallet type ${String(type)}`;
  }
}

function baseUnitsToNumber(balance: bigint | number | string): number {
  const raw = typeof balance === "bigint" ? balance : BigInt(String(balance));
  const whole = raw / COLLATERAL_SCALE;
  const frac = raw % COLLATERAL_SCALE;
  return Number(whole) + Number(frac) / Number(COLLATERAL_SCALE);
}

function decimalToNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

async function assertAdminAccess(
  env: LiveTradingAccountEnv,
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

async function loadLiveSettings(
  env: LiveTradingAccountEnv,
  accessToken: string,
): Promise<{
  positionSizePct: number;
  automationEnabled: boolean;
}> {
  const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !anonKey) {
    return { positionSizePct: DEFAULT_POSITION_SIZE_PCT, automationEnabled: false };
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/live_trade_settings?select=position_size_pct,automation_enabled&id=eq.1&limit=1`,
      {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    if (!res.ok) {
      return { positionSizePct: DEFAULT_POSITION_SIZE_PCT, automationEnabled: false };
    }
    const rows = (await res.json()) as Array<{
      position_size_pct?: number | string | null;
      automation_enabled?: boolean | null;
    }>;
    const row = rows[0];
    const pct = decimalToNumber(row?.position_size_pct ?? null);
    return {
      positionSizePct:
        pct !== null && pct > 0 && pct <= 100 ? pct : DEFAULT_POSITION_SIZE_PCT,
      automationEnabled: Boolean(row?.automation_enabled),
    };
  } catch {
    return { positionSizePct: DEFAULT_POSITION_SIZE_PCT, automationEnabled: false };
  }
}

function notConfiguredAccount(message: string): LiveTradingAccountSnapshot {
  return {
    configured: false,
    connected: false,
    signer: null,
    wallet: null,
    walletType: null,
    walletTypeLabel: null,
    collateralUsd: null,
    portfolioUsd: null,
    positionSizePct: DEFAULT_POSITION_SIZE_PCT,
    nextTradeStakeUsd: null,
    automationEnabled: false,
    refreshedAt: new Date().toISOString(),
    message,
  };
}

export async function fetchLiveTradingAccount(
  env: LiveTradingAccountEnv,
  authHeader: string | null,
): Promise<FetchResult> {
  const token = bearerToken(authHeader);
  if (!token) {
    return { success: false, message: "Unauthorized", status: 401 };
  }

  const auth = await assertAdminAccess(env, token);
  if (!auth.ok) {
    return { success: false, message: auth.message, status: auth.status };
  }

  if (!env.POLYMARKET_PRIVATE_KEY?.trim()) {
    return {
      success: true,
      account: notConfiguredAccount(
        "Server bot wallet is not configured. Set POLYMARKET_PRIVATE_KEY (and optionally POLYMARKET_WALLET_ADDRESS) in the environment, then refresh.",
      ),
    };
  }

  const settings = await loadLiveSettings(env, token);

  try {
    const client = await getServerPolymarketClient(env);
    const account = client.account;

    await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
    const collateral = await fetchBalanceAllowance(client, {
      assetType: AssetType.COLLATERAL,
    });
    const collateralUsd = baseUnitsToNumber(collateral.balance);

    let portfolioUsd: number | null = null;
    try {
      const portfolio = await client.fetchPortfolioValue();
      portfolioUsd = decimalToNumber(portfolio.value);
    } catch {
      portfolioUsd = null;
    }

    const nextTradeStakeUsd =
      collateralUsd > 0
        ? roundUsd(collateralUsd * (settings.positionSizePct / 100))
        : null;

    return {
      success: true,
      account: {
        configured: true,
        connected: true,
        signer: account.signer,
        wallet: account.wallet,
        walletType: String(account.walletType),
        walletTypeLabel: walletTypeLabel(account.walletType),
        collateralUsd,
        portfolioUsd,
        positionSizePct: settings.positionSizePct,
        nextTradeStakeUsd,
        automationEnabled: settings.automationEnabled,
        refreshedAt: new Date().toISOString(),
        message: settings.automationEnabled
          ? "Always-on bot wallet connected. Automation is ON in Settings."
          : "Always-on bot wallet connected. Automation is OFF in Settings — no live orders until you enable it.",
      },
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to connect the server Polymarket wallet.";
    return {
      success: true,
      account: {
        ...notConfiguredAccount(message),
        configured: true,
        connected: false,
        positionSizePct: settings.positionSizePct,
        automationEnabled: settings.automationEnabled,
      },
    };
  }
}

export const config = {
  maxDuration: 30,
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

      const env: LiveTradingAccountEnv = {
        SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
        SUPABASE_ANON_KEY:
          process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
        POLYMARKET_PRIVATE_KEY: process.env.POLYMARKET_PRIVATE_KEY,
        POLYMARKET_WALLET_ADDRESS: process.env.POLYMARKET_WALLET_ADDRESS,
      };

      const result = await fetchLiveTradingAccount(
        env,
        request.headers.get("authorization"),
      );

      if (result.success) {
        return Response.json(
          { success: true, account: result.account },
          { status: 200, headers: jsonHeaders() },
        );
      }

      return Response.json(
        { success: false, message: result.message },
        { status: result.status ?? 500, headers: jsonHeaders() },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Live trading account failed";
      return Response.json(
        { success: false, message },
        { status: 500, headers: jsonHeaders() },
      );
    }
  },
};
