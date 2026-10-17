import type { AccountIdentity, SecureClient } from "@polymarket/client";
import { isAddress, type Address, type WalletClient } from "viem";
import { connectMetaMask, isMetaMaskAvailable } from "../lib/polymarket/browser-wallet";
import { loadLiveAccountSnapshot } from "../lib/polymarket/balance";
import { formatDateTime, formatUsd, shortenAddress } from "../lib/polymarket/format";
import {
  createBrowserSecureClient,
  loadWalletOverride,
  saveWalletOverride,
} from "../lib/polymarket/secure-client";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type SessionState = {
  walletClient: WalletClient;
  address: Address;
  client: SecureClient | null;
  account: AccountIdentity | null;
};

let state: SessionState | null = null;

function $(id: string) {
  return document.getElementById(id);
}

function setText(id: string, value: string) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setStatus(message: string, isError = false) {
  const el = $("xa-live-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("xa-users__status--error", isError);
}

function setConnectedUi(connected: boolean) {
  $("xa-live-disconnected")?.toggleAttribute("hidden", connected);
  $("xa-live-connected")?.toggleAttribute("hidden", !connected);
  const connectBtn = $("xa-live-connect") as HTMLButtonElement | null;
  const refreshBtn = $("xa-live-refresh") as HTMLButtonElement | null;
  const disconnectBtn = $("xa-live-disconnect") as HTMLButtonElement | null;
  if (connectBtn) connectBtn.disabled = connected;
  if (refreshBtn) refreshBtn.disabled = !connected;
  if (disconnectBtn) disconnectBtn.disabled = !connected;
}

function walletInputValue() {
  const input = $("xa-live-wallet-override") as HTMLInputElement | null;
  return input?.value.trim() ?? "";
}

async function refreshBalances() {
  if (!state?.client || !state.account) {
    setStatus("Connect MetaMask first.", true);
    return;
  }

  setStatus("Loading Polymarket balances…");
  const refreshBtn = $("xa-live-refresh") as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const snap = await loadLiveAccountSnapshot(state.client, state.account);
    setText("xa-live-signer", shortenAddress(snap.signer));
    setText("xa-live-wallet", shortenAddress(snap.wallet));
    const signerEl = $("xa-live-signer");
    const walletEl = $("xa-live-wallet");
    if (signerEl) signerEl.setAttribute("title", snap.signer);
    if (walletEl) walletEl.setAttribute("title", snap.wallet);
    setText("xa-live-wallet-type", snap.walletTypeLabel);
    setText("xa-live-collateral", formatUsd(snap.collateralUsd));
    setText("xa-live-portfolio", formatUsd(snap.portfolioUsd));
    setText("xa-live-updated", formatDateTime(snap.refreshedAt));
    setStatus("Balances updated from Polymarket CLOB.");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unable to load balances.";
    setStatus(msg, true);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

async function authenticateAndLoad() {
  if (!state) return;

  const override = walletInputValue();
  if (override && !isAddress(override)) {
    setStatus("Polymarket wallet address is not a valid Ethereum address.", true);
    return;
  }

  saveWalletOverride(override);
  setStatus("Authenticating with Polymarket (approve the MetaMask signature)…");

  const { client, account } = await createBrowserSecureClient({
    walletClient: state.walletClient,
    wallet: override || null,
  });

  state.client = client;
  state.account = account;
  setConnectedUi(true);
  await refreshBalances();
}

async function onConnect() {
  const connectBtn = $("xa-live-connect") as HTMLButtonElement | null;
  if (connectBtn) connectBtn.disabled = true;

  try {
    if (!isMetaMaskAvailable()) {
      throw new Error("MetaMask was not found. Install the extension, then reload this page.");
    }

    const { address, walletClient } = await connectMetaMask();
    state = {
      address,
      walletClient,
      client: null,
      account: null,
    };
    setText("xa-live-metamask", shortenAddress(address));
    const mm = $("xa-live-metamask");
    if (mm) mm.setAttribute("title", address);

    await authenticateAndLoad();
  } catch (error) {
    state = null;
    setConnectedUi(false);
    const msg = error instanceof Error ? error.message : "Unable to connect MetaMask.";
    setStatus(msg, true);
  } finally {
    if (connectBtn && !state?.client) connectBtn.disabled = false;
  }
}

function onDisconnect() {
  state = null;
  setConnectedUi(false);
  setText("xa-live-metamask", "—");
  setText("xa-live-signer", "—");
  setText("xa-live-wallet", "—");
  setText("xa-live-wallet-type", "—");
  setText("xa-live-collateral", "—");
  setText("xa-live-portfolio", "—");
  setText("xa-live-updated", "—");
  setStatus("Disconnected.");
}

async function onApplyWallet() {
  if (!state) {
    setStatus("Connect MetaMask first, then apply the Polymarket wallet.", true);
    return;
  }
  try {
    await authenticateAndLoad();
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unable to re-authenticate.";
    setStatus(msg, true);
  }
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "live-trades-account");

  const overrideInput = $("xa-live-wallet-override") as HTMLInputElement | null;
  if (overrideInput) {
    overrideInput.value = loadWalletOverride();
  }

  if (!isMetaMaskAvailable()) {
    setStatus("MetaMask not detected in this browser.", true);
  } else {
    setStatus("Connect MetaMask to load your Polymarket trading balance.");
  }

  $("xa-live-connect")?.addEventListener("click", () => {
    void onConnect();
  });
  $("xa-live-disconnect")?.addEventListener("click", () => {
    onDisconnect();
  });
  $("xa-live-refresh")?.addEventListener("click", () => {
    void refreshBalances();
  });
  $("xa-live-apply-wallet")?.addEventListener("click", () => {
    void onApplyWallet();
  });

  setConnectedUi(false);
  setAdminLoading(false);
}

void init();
