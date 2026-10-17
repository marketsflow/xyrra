/** Default stake: always 10% of CLOB — never full balance unless the user overrides in Settings. */
export const DEFAULT_POSITION_SIZE_PCT = 10;

/** Polymarket CLOB marketable BUY minimum (USD). */
export const MIN_MARKET_BUY_USD = 1;

const COLLATERAL_CACHE_KEY = "xyrra-live-clob-collateral-usd";

export function cacheClobCollateralUsd(collateralUsd: number) {
  try {
    if (Number.isFinite(collateralUsd) && collateralUsd >= 0) {
      sessionStorage.setItem(COLLATERAL_CACHE_KEY, String(collateralUsd));
    }
  } catch {
    // ignore
  }
}

export function readCachedClobCollateralUsd(): number | null {
  try {
    const raw = sessionStorage.getItem(COLLATERAL_CACHE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Resolve the USD stake for a live order from percent settings + current CLOB collateral.
 * Floors to Polymarket's $1 market-buy minimum when collateral allows
 * (e.g. 10% of $4.71 → $1.00, not $0.47).
 */
export function resolveLiveStakeUsd(
  positionSizePct: number,
  collateralUsd: number,
): number {
  if (!(collateralUsd > 0) || !(positionSizePct > 0)) {
    throw new Error("Percent sizing needs a positive CLOB collateral balance and percent.");
  }
  if (positionSizePct > 100) {
    throw new Error("Position size percent cannot exceed 100.");
  }
  if (collateralUsd < MIN_MARKET_BUY_USD) {
    throw new Error(
      `CLOB needs at least $${MIN_MARKET_BUY_USD} for a market buy (have $${roundUsd(collateralUsd)}).`,
    );
  }

  let stake = roundUsd(collateralUsd * (positionSizePct / 100));
  if (stake < MIN_MARKET_BUY_USD) {
    stake = MIN_MARKET_BUY_USD;
  }
  if (stake > collateralUsd) {
    stake = roundUsd(collateralUsd);
  }
  if (!(stake > 0)) {
    throw new Error("Resolved stake is too small. Increase percent or deposit more collateral.");
  }
  return stake;
}

/** Human confirmation for the next live trade stake. */
export function formatNextTradeConfirmation(
  positionSizePct: number,
  collateralUsd: number | null,
): string {
  const pct = Number.isFinite(positionSizePct) ? positionSizePct : DEFAULT_POSITION_SIZE_PCT;
  if (collateralUsd === null || !(collateralUsd > 0)) {
    return `Next trade will be placed for ${pct}% of current CLOB collateral (connect Account to preview the dollar amount).`;
  }
  const raw = roundUsd(collateralUsd * (pct / 100));
  const stake = resolveLiveStakeUsd(pct, collateralUsd);
  if (raw < MIN_MARKET_BUY_USD && stake === MIN_MARKET_BUY_USD) {
    return `Next trade will be placed for ${formatUsd(stake)} (Polymarket $1 market-buy minimum; ${pct}% of ${formatUsd(collateralUsd)} would be ${formatUsd(raw)}).`;
  }
  return `Next trade will be placed for ${formatUsd(stake)} (${pct}% of ${formatUsd(collateralUsd)} CLOB collateral).`;
}
