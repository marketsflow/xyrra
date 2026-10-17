import {
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from "viem";
import { polygon } from "viem/chains";
import { formatUnknownError } from "./errors";

const POLYGON_CHAIN_ID_HEX = `0x${polygon.id.toString(16)}`;

type ProviderCandidate = EIP1193Provider & {
  isMetaMask?: boolean;
  providers?: ProviderCandidate[];
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type EthereumProvider = ProviderCandidate;

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function asProvider(value: unknown): ProviderCandidate | null {
  if (!value || typeof value !== "object") return null;
  if (!("request" in value) || typeof (value as { request: unknown }).request !== "function") {
    return null;
  }
  return value as ProviderCandidate;
}

/** Prefer MetaMask when multiple injected wallets share `window.ethereum`. */
export function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const ethereum = asProvider(window.ethereum);
  if (!ethereum) return null;

  const nested = Array.isArray(ethereum.providers)
    ? ethereum.providers.map(asProvider).filter((p): p is ProviderCandidate => Boolean(p))
    : [];

  const metamask = nested.find((p) => p.isMetaMask) ?? (ethereum.isMetaMask ? ethereum : null);
  return metamask ?? nested[0] ?? ethereum;
}

export function isMetaMaskAvailable() {
  return Boolean(getEthereumProvider());
}

async function ensurePolygon(provider: EthereumProvider) {
  const chainId = await provider.request({ method: "eth_chainId" });
  if (typeof chainId === "string" && chainId.toLowerCase() === POLYGON_CHAIN_ID_HEX) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? Number((error as { code: unknown }).code)
        : null;
    // 4902 = chain not added in MetaMask
    if (code !== 4902) {
      throw new Error(
        formatUnknownError(error, "Unable to switch MetaMask to Polygon (chain 137)."),
      );
    }

    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: POLYGON_CHAIN_ID_HEX,
            chainName: "Polygon",
            nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
            rpcUrls: ["https://polygon-rpc.com"],
            blockExplorerUrls: ["https://polygonscan.com"],
          },
        ],
      });
    } catch (addError) {
      throw new Error(
        formatUnknownError(addError, "Unable to add Polygon to MetaMask."),
      );
    }
  }
}

async function walletFromProvider(
  provider: EthereumProvider,
  rawAddress: string,
): Promise<{
  address: Address;
  walletClient: WalletClient;
  provider: EthereumProvider;
}> {
  try {
    await ensurePolygon(provider);
  } catch (error) {
    throw new Error(formatUnknownError(error, "Unable to switch MetaMask to Polygon."));
  }

  const address = getAddress(rawAddress);
  const walletClient = createWalletClient({
    account: address,
    chain: polygon,
    transport: custom(provider),
  });

  return { address, walletClient, provider };
}

/**
 * Resume an already-authorized MetaMask session without a permission popup.
 * Returns null if MetaMask is locked or this site has no accounts yet.
 */
export async function tryResumeMetaMask(): Promise<{
  address: Address;
  walletClient: WalletClient;
  provider: EthereumProvider;
} | null> {
  const provider = getEthereumProvider();
  if (!provider) return null;

  let accounts: string[];
  try {
    accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  } catch {
    return null;
  }

  const raw = accounts[0];
  if (!raw) return null;

  return walletFromProvider(provider, raw);
}

export async function connectMetaMask(): Promise<{
  address: Address;
  walletClient: WalletClient;
  provider: EthereumProvider;
}> {
  const provider = getEthereumProvider();
  if (!provider) {
    throw new Error("MetaMask was not found. Install the extension, then reload this page.");
  }

  // Request accounts first — some MetaMask builds reject chain switches before unlock.
  let requested: string[];
  try {
    requested = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
  } catch (error) {
    throw new Error(formatUnknownError(error, "MetaMask account request was rejected."));
  }

  const raw = requested[0];
  if (!raw) {
    throw new Error("No MetaMask account was selected.");
  }

  return walletFromProvider(provider, raw);
}
