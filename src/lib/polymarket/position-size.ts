/** Default stake: always 10% of CLOB — never full balance unless the user overrides in Settings. */
export const DEFAULT_POSITION_SIZE_PCT = 10;

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
 * Example: 10% of $4.71 → $0.47.
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

  const stake = roundUsd(collateralUsd * (positionSizePct / 100));
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
  const stake = resolveLiveStakeUsd(pct, collateralUsd);
  return `Next trade will be placed for ${formatUsd(stake)} (${pct}% of ${formatUsd(collateralUsd)} CLOB collateral).`;
}
