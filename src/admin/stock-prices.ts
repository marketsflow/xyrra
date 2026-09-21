import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

type FetchResponse = {
  success?: boolean;
  message?: string;
  stocksProcessed?: number;
  rowsUpserted?: number;
  errors?: Array<{ stock: string; message: string }>;
  totalStocks?: number;
  nextOffset?: number | null;
};

const BATCH_SIZE = 100;

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
      renderErrors([]);

      const allErrors: Array<{ stock: string; message: string }> = [];
      let totalStocksProcessed = 0;
      let totalRowsUpserted = 0;
      let offset = 0;
      let totalStocks: number | null = null;

      try {
        const auth = await session.supabase.auth.getSession();
        const accessToken = auth.data.session?.access_token;
        if (!accessToken) {
          throw new Error("Your session expired. Sign in again.");
        }

        // Fetched in batches — a single request covering thousands of stocks would exceed the serverless function timeout.
        for (;;) {
          const batchNumber = Math.floor(offset / BATCH_SIZE) + 1;
          fetchBtn.textContent = `Fetching batch ${batchNumber}…`;
          setStatus(
            totalStocks
              ? `Fetching ${offset + 1}–${Math.min(offset + BATCH_SIZE, totalStocks)} of ${totalStocks} stocks…`
              : "Fetching…",
          );

          const response = await fetch("/api/stock-prices", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ from, to, offset, limit: BATCH_SIZE }),
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

          totalStocksProcessed += body.stocksProcessed ?? 0;
          totalRowsUpserted += body.rowsUpserted ?? 0;
          totalStocks = body.totalStocks ?? totalStocks;
          allErrors.push(...(body.errors ?? []));
          renderErrors(allErrors);

          if (body.nextOffset === null || body.nextOffset === undefined) break;
          offset = body.nextOffset;
        }

        setStatus(
          `Fetched prices for ${totalStocksProcessed} stock${totalStocksProcessed === 1 ? "" : "s"}, saved ${totalRowsUpserted} price${totalRowsUpserted === 1 ? "" : "s"}.${allErrors.length ? ` ${allErrors.length} error${allErrors.length === 1 ? "" : "s"}.` : ""}`,
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

