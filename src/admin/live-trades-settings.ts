import {
  DEFAULT_POSITION_SIZE_PCT,
  formatNextTradeConfirmation,
  readCachedClobCollateralUsd,
} from "../lib/polymarket/position-size";
import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

const SIGNAL_RULE_MIN = 1;
const SIGNAL_RULE_MAX = 21;

type LiveTradeSettings = {
  id: number;
  automation_enabled: boolean;
  position_size_pct: number;
  max_open_trades: number;
  daily_loss_limit_usd: number | null;
  allowed_signal_rules: number[];
  notes: string | null;
  updated_at: string | null;
};

function $(id: string) {
  return document.getElementById(id);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function setStatus(message: string, isError = false) {
  const el = $("xa-live-settings-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("xa-users__status--error", isError);
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}

function mapSettings(row: Record<string, unknown>): LiveTradeSettings {
  const rulesRaw = row.allowed_signal_rules;
  const rules = Array.isArray(rulesRaw)
    ? rulesRaw
        .map((r) => asNumber(r))
        .filter((n): n is number => n !== null && n >= SIGNAL_RULE_MIN && n <= SIGNAL_RULE_MAX)
        .sort((a, b) => a - b)
    : [];

  const pct = asNumber(row.position_size_pct);
  return {
    id: asNumber(row.id) ?? 1,
    automation_enabled: Boolean(row.automation_enabled),
    // Always fall back to 10% — never treat missing as full balance.
    position_size_pct: pct !== null && pct > 0 ? pct : DEFAULT_POSITION_SIZE_PCT,
    max_open_trades: asNumber(row.max_open_trades) ?? 1,
    daily_loss_limit_usd: asNumber(row.daily_loss_limit_usd),
    allowed_signal_rules: rules,
    notes: asString(row.notes),
    updated_at: asString(row.updated_at),
  };
}

function renderRuleCheckboxes(container: HTMLElement, selected: number[]) {
  const selectedSet = new Set(selected);
  const parts: string[] = [];
  for (let rule = SIGNAL_RULE_MIN; rule <= SIGNAL_RULE_MAX; rule += 1) {
    const checked = selectedSet.has(rule) ? " checked" : "";
    parts.push(
      `<label class="xa-live-settings__rule">
        <input type="checkbox" name="signal-rule" value="${rule}"${checked} />
        <span>${rule}</span>
      </label>`,
    );
  }
  container.innerHTML = parts.join("");
}

function readSelectedRules(): number[] {
  const boxes = document.querySelectorAll<HTMLInputElement>(
    'input[name="signal-rule"]:checked',
  );
  return Array.from(boxes)
    .map((el) => Number(el.value))
    .filter((n) => Number.isInteger(n) && n >= SIGNAL_RULE_MIN && n <= SIGNAL_RULE_MAX)
    .sort((a, b) => a - b);
}

function setAllRules(checked: boolean) {
  document.querySelectorAll<HTMLInputElement>('input[name="signal-rule"]').forEach((el) => {
    el.checked = checked;
  });
}

function readPctFromInput(): number {
  const pctEl = $("xa-live-settings-pct") as HTMLInputElement | null;
  const pct = asNumber(pctEl?.value);
  if (pct === null || pct <= 0) return DEFAULT_POSITION_SIZE_PCT;
  return Math.min(pct, 100);
}

function updateStakeConfirmation() {
  const confirmEl = $("xa-live-settings-stake-confirm");
  if (!confirmEl) return;

  const pct = readPctFromInput();
  const collateral = readCachedClobCollateralUsd();
  confirmEl.textContent = formatNextTradeConfirmation(pct, collateral);
  confirmEl.classList.toggle("xa-live-settings__confirm--warn", pct >= 100);
}

function fillForm(settings: LiveTradeSettings) {
  const automation = $("xa-live-settings-automation") as HTMLInputElement | null;
  const pct = $("xa-live-settings-pct") as HTMLInputElement | null;
  const maxOpen = $("xa-live-settings-max-open") as HTMLInputElement | null;
  const dailyLoss = $("xa-live-settings-daily-loss") as HTMLInputElement | null;
  const notes = $("xa-live-settings-notes") as HTMLTextAreaElement | null;
  const rulesEl = $("xa-live-settings-rules");
  const updatedEl = $("xa-live-settings-updated");

  if (automation) automation.checked = settings.automation_enabled;
  if (pct) pct.value = String(settings.position_size_pct || DEFAULT_POSITION_SIZE_PCT);
  if (maxOpen) maxOpen.value = String(settings.max_open_trades);
  if (dailyLoss) {
    dailyLoss.value =
      settings.daily_loss_limit_usd === null ? "" : String(settings.daily_loss_limit_usd);
  }
  if (notes) notes.value = settings.notes ?? "";
  if (rulesEl) renderRuleCheckboxes(rulesEl, settings.allowed_signal_rules);
  if (updatedEl) updatedEl.textContent = formatUpdatedAt(settings.updated_at);

  updateAutomationBadge(settings.automation_enabled);
  updateStakeConfirmation();
}

function updateAutomationBadge(enabled: boolean) {
  const badge = $("xa-live-settings-badge");
  if (!badge) return;
  badge.textContent = enabled ? "Automation ON" : "Automation OFF";
  badge.classList.toggle("xa-live-settings__badge--on", enabled);
  badge.classList.toggle("xa-live-settings__badge--off", !enabled);
}

function readForm(): {
  automation_enabled: boolean;
  position_size_pct: number;
  max_open_trades: number;
  daily_loss_limit_usd: number | null;
  allowed_signal_rules: number[];
  notes: string | null;
} {
  const automation = $("xa-live-settings-automation") as HTMLInputElement | null;
  const pctEl = $("xa-live-settings-pct") as HTMLInputElement | null;
  const maxOpenEl = $("xa-live-settings-max-open") as HTMLInputElement | null;
  const dailyLossEl = $("xa-live-settings-daily-loss") as HTMLInputElement | null;
  const notesEl = $("xa-live-settings-notes") as HTMLTextAreaElement | null;

  let position_size_pct = asNumber(pctEl?.value);
  // Empty / invalid → keep the safe 10% default (never imply 100%).
  if (position_size_pct === null || position_size_pct <= 0) {
    position_size_pct = DEFAULT_POSITION_SIZE_PCT;
    if (pctEl) pctEl.value = String(DEFAULT_POSITION_SIZE_PCT);
  }
  if (position_size_pct > 100) {
    throw new Error("Position size percent cannot exceed 100.");
  }

  const max_open_trades = asNumber(maxOpenEl?.value);
  const dailyRaw = dailyLossEl?.value.trim() ?? "";
  const daily_loss_limit_usd = dailyRaw === "" ? null : asNumber(dailyRaw);

  if (max_open_trades === null || max_open_trades < 1 || max_open_trades > 50) {
    throw new Error("Max open trades must be between 1 and 50.");
  }
  if (dailyRaw !== "" && (daily_loss_limit_usd === null || daily_loss_limit_usd <= 0)) {
    throw new Error("Daily loss limit must be empty or a positive dollar amount.");
  }

  return {
    automation_enabled: Boolean(automation?.checked),
    position_size_pct,
    max_open_trades: Math.floor(max_open_trades),
    daily_loss_limit_usd,
    allowed_signal_rules: readSelectedRules(),
    notes: asString(notesEl?.value ?? ""),
  };
}

function confirmNextTradeAmount(positionSizePct: number): boolean {
  const collateral = readCachedClobCollateralUsd();
  const message = formatNextTradeConfirmation(positionSizePct, collateral);
  return window.confirm(`${message}\n\nSave these settings?`);
}

const SETTINGS_SELECT =
  "id, automation_enabled, position_size_pct, max_open_trades, daily_loss_limit_usd, allowed_signal_rules, notes, updated_at";

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "live-trades-settings");

  const rulesEl = $("xa-live-settings-rules");
  if (rulesEl) renderRuleCheckboxes(rulesEl, []);

  const pctInput = $("xa-live-settings-pct") as HTMLInputElement | null;
  if (pctInput && !pctInput.value) {
    pctInput.value = String(DEFAULT_POSITION_SIZE_PCT);
  }
  updateStakeConfirmation();

  setStatus("Loading settings…");

  const { data, error } = await session.supabase
    .from("live_trade_settings")
    .select(SETTINGS_SELECT)
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    setStatus(
      `Unable to load settings: ${error.message}. Apply migrations through 20261017140000 if needed.`,
      true,
    );
    setAdminLoading(false);
    return;
  }

  if (!data) {
    setStatus("No settings row found. Run the live_trade_settings migrations.", true);
    setAdminLoading(false);
    return;
  }

  fillForm(mapSettings(data as Record<string, unknown>));
  setStatus("Settings loaded. Default stake is 10% of CLOB unless you change it.");

  $("xa-live-settings-select-all")?.addEventListener("click", () => {
    setAllRules(true);
  });
  $("xa-live-settings-clear-rules")?.addEventListener("click", () => {
    setAllRules(false);
  });

  $("xa-live-settings-automation")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    updateAutomationBadge(target.checked);
  });

  pctInput?.addEventListener("input", () => {
    updateStakeConfirmation();
  });
  pctInput?.addEventListener("blur", () => {
    const pct = asNumber(pctInput.value);
    if (pct === null || pct <= 0) {
      pctInput.value = String(DEFAULT_POSITION_SIZE_PCT);
      updateStakeConfirmation();
    }
  });

  const form = $("xa-live-settings-form") as HTMLFormElement | null;
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const saveBtn = $("xa-live-settings-save") as HTMLButtonElement | null;
      if (saveBtn) saveBtn.disabled = true;
      try {
        const payload = readForm();
        if (payload.automation_enabled && payload.allowed_signal_rules.length === 0) {
          throw new Error(
            "Turn on automation only after selecting at least one signal rule (or leave automation off).",
          );
        }

        updateStakeConfirmation();
        if (!confirmNextTradeAmount(payload.position_size_pct)) {
          setStatus("Save cancelled.");
          return;
        }

        setStatus("Saving…");
        const { data: saved, error: saveError } = await session.supabase
          .from("live_trade_settings")
          .update({
            automation_enabled: payload.automation_enabled,
            position_size_pct: payload.position_size_pct,
            max_open_trades: payload.max_open_trades,
            daily_loss_limit_usd: payload.daily_loss_limit_usd,
            allowed_signal_rules: payload.allowed_signal_rules,
            notes: payload.notes,
          })
          .eq("id", 1)
          .select(SETTINGS_SELECT)
          .maybeSingle();

        if (saveError) throw new Error(saveError.message);
        if (!saved) throw new Error("Save succeeded but no row was returned.");

        fillForm(mapSettings(saved as Record<string, unknown>));
        const collateral = readCachedClobCollateralUsd();
        const confirmMsg = formatNextTradeConfirmation(payload.position_size_pct, collateral);
        setStatus(
          payload.automation_enabled
            ? `Saved. Automation ON. ${confirmMsg}`
            : `Saved. Automation OFF. ${confirmMsg}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unable to save settings.";
        setStatus(msg, true);
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    })();
  });

  setAdminLoading(false);
}

void init();
