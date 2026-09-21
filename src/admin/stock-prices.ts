import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type FetchResponse = {
  success?: boolean;
  message?: string;
  stocksProcessed?: number;
  rowsUpserted?: number;
  errors?: Array<{ stock: string; message: string }>;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "stock-prices");
  setAdminLoading(false);

  const countEl = document.getElementById("xa-stock-prices-count");
  if (countEl) {
    const { count, error } = await session.supabase
      .from("stocks")
      .select("*", { count: "exact", head: true });
    countEl.textContent = error
      ? `Unable to read the stocks table: ${error.message}`
      : `${(count ?? 0).toLocaleString()} stock${count === 1 ? "" : "s"} in the database.`;
  }

  const fromInput = document.getElementById("xa-stock-prices-from") as HTMLInputElement | null;
  const toInput = document.getElementById("xa-stock-prices-to") as HTMLInputElement | null;
  const fetchBtn = document.getElementById("xa-stock-prices-fetch") as HTMLButtonElement | null;
  const statusEl = document.getElementById("xa-stock-prices-status");
  const errorsEl = document.getElementById("xa-stock-prices-errors");

  if (!fromInput || !toInput || !fetchBtn || !statusEl || !errorsEl) return;

  const today = todayIso();
  toInput.value = today;
  fromInput.value = today;

  let fetching = false;

  function setStatus(message: string, isError = false) {
    statusEl!.textContent = message;
    statusEl!.classList.toggle("xa-users__status--error", isError);
  }

  function renderErrors(errors: Array<{ stock: string; message: string }>) {
    if (errors.length === 0) {
      errorsEl!.innerHTML = "";
      errorsEl!.setAttribute("hidden", "");
      return;
    }
    errorsEl!.removeAttribute("hidden");
    errorsEl!.innerHTML = errors
      .map((error) => `<li><strong>${escapeHtml(error.stock)}</strong>: ${escapeHtml(error.message)}</li>`)
      .join("");
  }

  fetchBtn.addEventListener("click", () => {
    void (async () => {
      if (fetching) return;

      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) {
        setStatus("Choose a from and to date.", true);
        return;
      }
      if (from > to) {
        setStatus("From date must be before or equal to the to date.", true);
        return;
      }

      fetching = true;
      fetchBtn.disabled = true;
      fetchBtn.textContent = "Fetching…";
      renderErrors([]);
      setStatus("Fetching EOD prices…");

      try {
        const auth = await session.supabase.auth.getSession();
        const accessToken = auth.data.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Sign in again.");
        }

        const response = await fetch("/api/stock-prices", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ from, to }),
        });

        const raw = await response.text();
        let body: FetchResponse = {};
        if (raw) {
          try {
            body = JSON.parse(raw) as FetchResponse;
          } catch {
            throw new Error("The stock prices API did not return JSON.");
          }
        }

        if (!response.ok || !body.success) {
          throw new Error(body.message || "Unable to fetch stock prices.");
        }

        renderErrors(body.errors ?? []);
        setStatus(
          `Fetched prices for ${body.stocksProcessed ?? 0} stock${body.stocksProcessed === 1 ? "" : "s"}, saved ${body.rowsUpserted ?? 0} price${body.rowsUpserted === 1 ? "" : "s"}.`,
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Unable to fetch stock prices.", true);
      } finally {
        fetching = false;
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Fetch EOD prices";
      }
    })();
  });
}

void init();
