import {
  AssetType,
  WalletType,
  type AccountIdentity,
  type SecureClient,
} from "@polymarket/client";
import {
  fetchBalanceAllowance,
  updateBalanceAllowance,
} from "@polymarket/client/actions";

/** Collateral (pUSD / USDC.e-era) uses 6 decimals on Polymarket CLOB. */
const COLLATERAL_DECIMALS = 6n;
const COLLATERAL_SCALE = 10n ** COLLATERAL_DECIMALS;

export type LiveAccountSnapshot = {
  signer: string;
  wallet: string;
  walletType: WalletType;
  walletTypeLabel: string;
  /** Spendable CLOB collateral, human units. */
  collateralUsd: number;
  /** Marked value of open positions from the Data API, USDC. */
  portfolioUsd: number | null;
  refreshedAt: string;
};

export function walletTypeLabel(type: WalletType): string {
  switch (type) {
    case WalletType.EOA:
      return "EOA (MetaMask)";
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

/**
 * Refresh CLOB collateral cache, then read balance + portfolio mark.
 * Uses the unified `@polymarket/client` SecureClient + actions API.
 */
export async function loadLiveAccountSnapshot(
  client: SecureClient,
  account: AccountIdentity,
): Promise<LiveAccountSnapshot> {
  await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
  const collateral = await fetchBalanceAllowance(client, {
    assetType: AssetType.COLLATERAL,
  });

  let portfolioUsd: number | null = null;
  try {
    const portfolio = await client.fetchPortfolioValue();
    portfolioUsd = decimalToNumber(portfolio.value);
  } catch {
    portfolioUsd = null;
  }

  return {
    signer: account.signer,
    wallet: account.wallet,
    walletType: account.walletType,
    walletTypeLabel: walletTypeLabel(account.walletType),
    collateralUsd: baseUnitsToNumber(collateral.balance),
    portfolioUsd,
    refreshedAt: new Date().toISOString(),
  };
}
