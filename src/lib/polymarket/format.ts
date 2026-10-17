export function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function shortenAddress(address: string, left = 6, right = 4) {
  const value = address.trim();
  if (value.length <= left + right + 2) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}
