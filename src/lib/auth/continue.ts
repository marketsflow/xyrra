export const LOGIN_PATH = "/login/";
export const APP_PATH = "/app/";

export const CONTINUE_DESTINATIONS = {
  "pre-order": "/pre-order/",
  agent: "/xyrra-agent/download/",
  app: APP_PATH,
} as const;

export type ContinueKey = keyof typeof CONTINUE_DESTINATIONS;

const SYSTEM_VALUES = new Set(["core", "pro", "ultra"]);
const PLAN_VALUES = new Set(["monthly", "yearly"]);
const CONTINUE_KEYS = new Set<string>(Object.keys(CONTINUE_DESTINATIONS));

export type AuthMode = "signup" | "signin";

function isContinueKey(value: string | null | undefined): value is ContinueKey {
  return Boolean(value && CONTINUE_KEYS.has(value));
}

function normalizeSystem(value: string | null | undefined): string {
  const system = (value ?? "").trim().toLowerCase();
  return SYSTEM_VALUES.has(system) ? system : "";
}

function normalizePlan(value: string | null | undefined): string {
  const plan = (value ?? "").trim().toLowerCase();
  return PLAN_VALUES.has(plan) ? plan : "";
}

function withPlan(path: string, plan: string): string {
  if (!plan || !path.startsWith("/app")) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}plan=${plan}`;
}

export function continueKeyFromPath(pathname: string): ContinueKey | null {
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return "app";
  }
  if (pathname === "/pre-order" || pathname.startsWith("/pre-order/")) {
    return "pre-order";
  }
  if (pathname === "/xyrra-agent/download" || pathname.startsWith("/xyrra-agent/download/")) {
    return "agent";
  }
  return null;
}

export function continuePathFromSearch(search: URLSearchParams): string {
  const plan = normalizePlan(search.get("plan"));
  const next = search.get("next");
  if (!isContinueKey(next)) {
    return withPlan(APP_PATH, plan);
  }

  const dest = CONTINUE_DESTINATIONS[next];
  const system = normalizeSystem(search.get("system"));
  if (next === "pre-order" && system) {
    return `${dest}?system=${system}`;
  }
  if (next === "app") {
    return withPlan(dest, plan);
  }
  return dest;
}

export function loginHref(options: {
  next: ContinueKey;
  system?: string | null;
  mode?: AuthMode;
  plan?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("next", options.next);
  const system = normalizeSystem(options.system);
  if (system) {
    params.set("system", system);
  }
  const plan = normalizePlan(options.plan);
  if (plan && options.next === "app") {
    params.set("plan", plan);
  }
  if (options.mode === "signin") {
    params.set("mode", "signin");
  }
  return `${LOGIN_PATH}?${params.toString()}`;
}

export function loginHrefForCurrentPage(mode: AuthMode = "signup"): string {
  const key = continueKeyFromPath(window.location.pathname);
  if (!key) {
    return LOGIN_PATH;
  }
  const search = new URLSearchParams(window.location.search);
  return loginHref({
    next: key,
    system: search.get("system"),
    plan: search.get("plan"),
    mode,
  });
}

export function destinationLabel(next: string | null, systemName?: string | null): string {
  if (next === "pre-order") {
    return systemName ? `pre-order the ${systemName}` : "pre-order a Xyrra PC";
  }
  if (next === "agent") {
    return "download Xyrra Agent";
  }
  return "the Xyrra app";
}
