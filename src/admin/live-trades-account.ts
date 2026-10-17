import type { AccountIdentity, SecureClient } from "@polymarket/client";
import { isAddress, type Address, type WalletClient } from "viem";
import type { AdminSession } from "./auth-guard";
import {
  connectMetaMask,
  isMetaMaskAvailable,
  tryResumeMetaMask,
} from "../lib/polymarket/browser-wallet";
import { loadLiveAccountSnapshot } from "../lib/polymarket/balance";
import { formatUnknownError } from "../lib/polymarket/errors";
import { formatDateTime, formatUsd, shortenAddress } from "../lib/polymarket/format";
import {
  cacheClobCollateralUsd,
  formatNextTradeConfirmation,
} from "../lib/polymarket/position-size";
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

type BotAccountPayload = {
  configured: boolean;
  connected: boolean;
  signer: string | null;
  wallet: string | null;
  walletTypeLabel: string | null;
  collateralUsd: number | null;
  portfolioUsd: number | null;
  positionSizePct: number;
  nextTradeStakeUsd: number | null;
  automationEnabled: boolean;
  refreshedAt: string;
  message: string;
};

let state: SessionState | null = null;
let adminSession: AdminSession | null = null;

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

function setBotStatus(message: string, isError = false) {
  const el = $("xa-bot-status");
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

function updateBotBadge(account: BotAccountPayload) {
  const badge = $("xa-bot-badge");
  if (!badge) return;
  if (!account.configured) {
    badge.textContent = "Not configured";
    badge.classList.add("xa-live-settings__badge--off");
    badge.classList.remove("xa-live-settings__badge--on");
    return;
  }
  if (account.connected) {
    badge.textContent = account.automationEnabled ? "Connected · Automation ON" : "Connected · Automation OFF";
    badge.classList.add("xa-live-settings__badge--on");
    badge.classList.remove("xa-live-settings__badge--off");
    return;
  }
  badge.textContent = "Configured · offline";
  badge.classList.add("xa-live-settings__badge--off");
  badge.classList.remove("xa-live-settings__badge--on");
}

function renderBotAccount(account: BotAccountPayload) {
  updateBotBadge(account);
  setText("xa-bot-signer", account.signer ? shortenAddress(account.signer) : "—");
  setText("xa-bot-wallet", account.wallet ? shortenAddress(account.wallet) : "—");
  setText("xa-bot-wallet-type", account.walletTypeLabel ?? "—");
  setText("xa-bot-collateral", formatUsd(account.collateralUsd));
  setText("xa-bot-portfolio", formatUsd(account.portfolioUsd));
  setText(
    "xa-bot-next-stake",
    account.nextTradeStakeUsd !== null
      ? `${formatUsd(account.nextTradeStakeUsd)} (${account.positionSizePct}%)`
      : "—",
  );
  setText("xa-bot-updated", formatDateTime(account.refreshedAt));

  const signerEl = $("xa-bot-signer");
  const walletEl = $("xa-bot-wallet");
  if (signerEl && account.signer) signerEl.setAttribute("title", account.signer);
  if (walletEl && account.wallet) walletEl.setAttribute("title", account.wallet);

  const confirmEl = $("xa-bot-next-confirm");
  if (confirmEl) {
    confirmEl.textContent = formatNextTradeConfirmation(
      account.positionSizePct,
      account.collateralUsd,
    );
  }

  if (account.collateralUsd !== null) {
    cacheClobCollateralUsd(account.collateralUsd);
  }

  setBotStatus(account.message, account.configured && !account.connected);
}

async function refreshBotWallet() {
  if (!adminSession) return;

  const refreshBtn = $("xa-bot-refresh") as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;
  setBotStatus("Loading always-on bot wallet…");

  try {
    const auth = await adminSession.supabase.auth.getSession();
    const accessToken = auth.data.session?.access_token;
    if (!accessToken) {
      throw new Error("Admin session expired. Sign in again.");
    }

    const response = await fetch("/api/live-trading-account", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = (await response.json()) as {
      success?: boolean;
      message?: string;
      account?: BotAccountPayload;
    };

    if (!response.ok || !payload.success || !payload.account) {
      throw new Error(payload.message || `Request failed (${response.status})`);
    }

    renderBotAccount(payload.account);
  } catch (error) {
    console.error("[live-trades] bot wallet refresh failed", error);
    setBotStatus(formatUnknownError(error, "Unable to load bot wallet."), true);
    const badge = $("xa-bot-badge");
    if (badge) {
      badge.textContent = "Error";
      badge.classList.add("xa-live-settings__badge--off");
      badge.classList.remove("xa-live-settings__badge--on");
    }
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
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
    cacheClobCollateralUsd(snap.collateralUsd);
    setStatus("Browser MetaMask balances updated (viewer only).");
  } catch (error) {
    console.error("[live-trades] balance refresh failed", error);
    setStatus(formatUnknownError(error, "Unable to load balances."), true);
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
  setStatus("Authenticating with Polymarket (approve the MetaMask signature if prompted)…");

  const { client, account } = await createBrowserSecureClient({
    walletClient: state.walletClient,
    wallet: override || null,
  });

  state.client = client;
  state.account = account;
  setConnectedUi(true);
  await refreshBalances();
}

function showMetaMaskConnected(address: Address) {
  setText("xa-live-metamask", shortenAddress(address));
  const mm = $("xa-live-metamask");
  if (mm) mm.setAttribute("title", address);
  $("xa-live-disconnected")?.setAttribute("hidden", "");
  $("xa-live-connected")?.removeAttribute("hidden");
}

async function connectWithWallet(opts: {
  address: Address;
  walletClient: WalletClient;
}) {
  state = {
    address: opts.address,
    walletClient: opts.walletClient,
    client: null,
    account: null,
  };
  showMetaMaskConnected(opts.address);

  try {
    await authenticateAndLoad();
  } catch (authError) {
    console.error("[live-trades] Polymarket auth failed", authError);
    setStatus(formatUnknownError(authError, "Polymarket authentication failed."), true);
  }
}

async function onConnect() {
  const connectBtn = $("xa-live-connect") as HTMLButtonElement | null;
  if (connectBtn) connectBtn.disabled = true;

  try {
    if (!isMetaMaskAvailable()) {
      throw new Error("MetaMask was not found. Install the extension, then reload this page.");
    }

    setStatus("Opening MetaMask…");
    const { address, walletClient } = await connectMetaMask();
    await connectWithWallet({ address, walletClient });
  } catch (error) {
    console.error("[live-trades] MetaMask connect failed", error);
    state = null;
    setConnectedUi(false);
    setStatus(formatUnknownError(error, "Unable to connect MetaMask."), true);
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
  setStatus("Browser viewer disconnected. The always-on bot wallet is unaffected.");
}

async function onApplyWallet() {
  if (!state) {
    setStatus("Connect MetaMask first, then apply the Polymarket wallet.", true);
    return;
  }
  try {
    await authenticateAndLoad();
  } catch (error) {
    console.error("[live-trades] reconnect failed", error);
    setStatus(formatUnknownError(error, "Unable to re-authenticate."), true);
  }
}

async function tryAutoResume() {
  if (!isMetaMaskAvailable()) return;

  const resumed = await tryResumeMetaMask();
  if (!resumed) return;

  setStatus("Resuming MetaMask browser viewer…");
  await connectWithWallet({
    address: resumed.address,
    walletClient: resumed.walletClient,
  });
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;
  adminSession = session;

  initAdminShell(session, "live-trades-account");

  const overrideInput = $("xa-live-wallet-override") as HTMLInputElement | null;
  if (overrideInput) {
    overrideInput.value = loadWalletOverride();
  }

  $("xa-bot-refresh")?.addEventListener("click", () => {
    void refreshBotWallet();
  });
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

  await refreshBotWallet();
  void tryAutoResume();
}

void init();
