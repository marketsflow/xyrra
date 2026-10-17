import {
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type EIP1193Provider,
  type WalletClient,
} from "viem";
import { polygon } from "viem/chains";

const POLYGON_CHAIN_ID_HEX = `0x${polygon.id.toString(16)}`;

export type EthereumProvider = EIP1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function getEthereumProvider(): EthereumProvider | null {
  return typeof window !== "undefined" && window.ethereum ? window.ethereum : null;
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
    if (code !== 4902) throw error;

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
  }
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

  await ensurePolygon(provider);

  const requested = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  const raw = requested[0];
  if (!raw) {
    throw new Error("No MetaMask account was selected.");
  }

  const address = getAddress(raw);
  const walletClient = createWalletClient({
    account: address,
    chain: polygon,
    transport: custom(provider),
  });

  return { address, walletClient, provider };
}
