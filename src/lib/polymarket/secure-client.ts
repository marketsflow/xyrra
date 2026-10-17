import {
  createPublicClient,
  createSecureClient,
  type AccountIdentity,
  type SecureClient,
} from "@polymarket/client";
import { signerFrom } from "@polymarket/client/viem";
import { getAddress, type Address, type WalletClient } from "viem";
import { formatUnknownError } from "./errors";

const WALLET_OVERRIDE_KEY = "xyrra-live-polymarket-wallet";

export function loadWalletOverride(): string {
  try {
    return localStorage.getItem(WALLET_OVERRIDE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveWalletOverride(value: string) {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(WALLET_OVERRIDE_KEY, getAddress(trimmed));
    } else {
      localStorage.removeItem(WALLET_OVERRIDE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode, etc.).
  }
}

/**
 * Prefer an explicit funder address (Polymarket profile / Safe / Deposit Wallet).
 * Otherwise look up the public profile proxy for this MetaMask EOA.
 */
export async function resolveAccountWallet(
  signerAddress: Address,
  override?: string | null,
): Promise<Address | undefined> {
  const manual = override?.trim();
  if (manual) {
    return getAddress(manual);
  }

  const publicClient = createPublicClient();
  try {
    const profile = await publicClient.fetchPublicProfile({ address: signerAddress });
    const proxy = profile?.wallet?.trim();
    if (proxy) return getAddress(proxy);
  } catch {
    // Fall through — SecureClient will use the deterministic Deposit Wallet.
  }

  return undefined;
}

export async function createBrowserSecureClient(options: {
  walletClient: WalletClient;
  /** Polymarket account/funder wallet. Omit to let the SDK resolve. */
  wallet?: string | null;
}): Promise<{
  client: SecureClient;
  account: AccountIdentity;
}> {
  const signerAddress = options.walletClient.account?.address;
  if (!signerAddress) {
    throw new Error("MetaMask wallet client has no account.");
  }

  const wallet = await resolveAccountWallet(signerAddress, options.wallet);

  try {
    const client = await createSecureClient({
      signer: signerFrom(options.walletClient),
      ...(wallet ? { wallet } : {}),
    });
    return { client, account: client.account };
  } catch (error) {
    throw new Error(
      formatUnknownError(
        error,
        wallet
          ? `Polymarket auth failed for wallet ${wallet}.`
          : "Polymarket auth failed. Approve the MetaMask signature, or set your Polymarket profile wallet below.",
      ),
    );
  }
}
