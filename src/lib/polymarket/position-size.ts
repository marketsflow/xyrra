export type PositionSizingMode = "fixed_usd" | "percent_collateral";

export type PositionSizeSettings = {
  position_sizing_mode: PositionSizingMode;
  position_size_usd: number;
  position_size_pct: number;
};

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Resolve the USD stake for a live order from settings + current CLOB collateral.
 * Percent mode uses live collateral at order time (e.g. 10% of $4.71 → $0.47).
 */
export function resolveLiveStakeUsd(
  settings: PositionSizeSettings,
  collateralUsd: number,
): number {
  if (settings.position_sizing_mode === "percent_collateral") {
    if (!(collateralUsd > 0) || !(settings.position_size_pct > 0)) {
      throw new Error("Percent sizing needs a positive CLOB collateral balance and percent.");
    }
    const stake = roundUsd(collateralUsd * (settings.position_size_pct / 100));
    if (!(stake > 0)) {
      throw new Error("Resolved stake is too small. Increase percent or deposit more collateral.");
    }
    return stake;
  }

  if (!(settings.position_size_usd > 0)) {
    throw new Error("Fixed position size must be a positive dollar amount.");
  }
  return roundUsd(settings.position_size_usd);
}
