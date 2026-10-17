/**
 * Shared always-on Polymarket SecureClient for serverless handlers.
 * Keep this out of `api/*.ts` route files so Vercel does not cross-bundle routes.
 */

import { createSecureClient } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";

export type ServerPolymarketEnv = {
  POLYMARKET_PRIVATE_KEY?: string;
  POLYMARKET_WALLET_ADDRESS?: string;
};

type SecureClientInstance = Awaited<ReturnType<typeof createSecureClient>>;

let cachedClient: SecureClientInstance | null = null;
let cachedFingerprint: string | null = null;

/**
 * Normalize MetaMask / .env private keys into `0x` + 64 hex chars.
 * Common failures: wrapping quotes, spaces, missing 0x, pasting a seed phrase.
 */
export function normalizePrivateKey(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\s+/g, "");
  if (!value) return "";

  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 12) {
    throw new Error(
      "POLYMARKET_PRIVATE_KEY looks like a seed phrase. Export the account private key from MetaMask (Account details → Show private key), not the Secret Recovery Phrase.",
    );
  }

  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      "POLYMARKET_PRIVATE_KEY must be hex (0-9, a-f). Remove quotes/spaces from .env.local and use the MetaMask private key, not an address.",
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `POLYMARKET_PRIVATE_KEY must be 32 bytes (64 hex chars). Got ${hex.length} hex chars after cleanup — re-copy Show private key from MetaMask.`,
    );
  }
  return `0x${hex.toLowerCase()}`;
}

function configFingerprint(privateKeyValue: string, wallet: string) {
  return `${privateKeyValue.slice(0, 10)}:${privateKeyValue.length}:${wallet.toLowerCase()}`;
}

/**
 * Cached SecureClient for the always-on bot signer.
 * Safe to call from cron / place-order handlers.
 */
export async function getServerPolymarketClient(
  env: ServerPolymarketEnv,
): Promise<SecureClientInstance> {
  const keyRaw = env.POLYMARKET_PRIVATE_KEY?.trim() || "";
  if (!keyRaw) {
    throw new Error(
      "POLYMARKET_PRIVATE_KEY is not set. Add the bot signer private key to the server env.",
    );
  }
  const key = normalizePrivateKey(keyRaw);
  const wallet = env.POLYMARKET_WALLET_ADDRESS?.trim() || "";
  const fingerprint = configFingerprint(key, wallet);

  if (cachedClient && cachedFingerprint === fingerprint) {
    return cachedClient;
  }

  const client = await createSecureClient({
    signer: privateKey(key),
    ...(wallet ? { wallet } : {}),
  });

  cachedClient = client;
  cachedFingerprint = fingerprint;
  return client;
}
