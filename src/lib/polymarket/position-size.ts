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

  const stake = Math.round(collateralUsd * (positionSizePct / 100) * 100) / 100;
  if (!(stake > 0)) {
    throw new Error("Resolved stake is too small. Increase percent or deposit more collateral.");
  }
  return stake;
}
