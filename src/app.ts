import { hasActiveSubscription } from "./lib/auth/entitlement";
import { getAuthenticatedUser } from "./lib/auth/session";
import { getSupabaseClient } from "./lib/supabase/client";
import type { User } from "@supabase/supabase-js";

const LOGIN_URL = "/login/?next=app";

type Trade = {
  symbol?: string;
  profit_loss?: string;
  trade_type?: string;
};

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}

function displayName(user: User) {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return fullName || name || user.email || "there";
}

function show(id: string) {
  document.getElementById(id)?.removeAttribute("hidden");
}

function bindMenu() {
  const menu = document.getElementById("mh-menu");
  const nav = document.getElementById("mh-nav");
  menu?.addEventListener("click", () => {
    const open = nav?.getAttribute("data-open") === "true";
    nav?.setAttribute("data-open", open ? "false" : "true");
    menu.setAttribute("aria-expanded", open ? "false" : "true");
    menu.setAttribute("aria-label", open ? "Open menu" : "Close menu");
  });
}

function highlightPlan() {
  const plan = new URLSearchParams(window.location.search).get("plan");
  if (plan !== "yearly" && plan !== "monthly") return;
  document.querySelector<HTMLElement>(`[data-plan="${plan}"]`)?.classList.add("is-selected");
}

function bindSignOut() {
  document.getElementById("app-signout")?.addEventListener("click", () => {
    void (async () => {
      try {
        const supabase = getSupabaseClient();
        await supabase.auth.signOut();
      } finally {
        window.location.replace("/login/");
      }
    })();
  });
}

async function loadLiveInsights() {
  const list = document.getElementById("app-live");
  if (!list) return;
  list.textContent = "Loading live AI insights…";
  try {
    const response = await fetch("/api/website/ai-stocks?page=1&per_page=5");
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as {
      data?: Trade[] | { data?: Trade[] };
    };
    const payload = body.data;
    const trades = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    if (!trades.length) {
      list.textContent = "No live stock insights are open right now.";
      return;
    }
    list.innerHTML = trades
      .slice(0, 5)
      .map((trade) => {
        const symbol = esc(trade.symbol?.trim() || "—");
        const result = esc(trade.profit_loss?.trim() || trade.trade_type?.trim() || "Live");
        return `<article class="app-trade"><strong>${symbol}</strong><span>${result}</span></article>`;
      })
      .join("");
  } catch {
    list.textContent = "Live insights could not be loaded. Try again in a moment.";
  }
}

async function openApp() {
  document.body.classList.add("auth-checking");
  bindMenu();
  bindSignOut();

  const year = document.getElementById("mh-year");
  if (year) year.textContent = String(new Date().getFullYear());

  try {
    const supabase = getSupabaseClient();
    const user = await getAuthenticatedUser(supabase);
    if (!user) {
      const plan = new URLSearchParams(window.location.search).get("plan");
      const next = plan === "yearly" || plan === "monthly" ? `${LOGIN_URL}&plan=${plan}` : LOGIN_URL;
      window.location.replace(next);
      return;
    }

    const userLabel = document.getElementById("app-user");
    if (userLabel) {
      userLabel.textContent = user.email ?? displayName(user);
      userLabel.hidden = false;
    }
    document.getElementById("app-signout")?.removeAttribute("hidden");

    let entitled = false;
    try {
      entitled = await hasActiveSubscription(supabase, user.id);
    } catch {
      entitled = false;
    }
    document.body.classList.remove("auth-checking");

    if (!entitled) {
      highlightPlan();
      show("app-paywall");
      return;
    }

    const welcome = document.getElementById("app-welcome");
    if (welcome) welcome.textContent = `Signed in as ${displayName(user)}.`;
    show("app-home");
    void loadLiveInsights();
  } catch {
    window.location.replace(LOGIN_URL);
  }
}

void openApp();
