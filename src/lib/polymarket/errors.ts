/** MetaMask / RPC / SDK errors are often plain objects, not `Error` instances. */
export function formatUnknownError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;

    for (const key of ["shortMessage", "message", "details", "reason"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        const code = record.code;
        if (typeof code === "number" || typeof code === "string") {
          return `${value.trim()} (code ${code})`;
        }
        return value.trim();
      }
    }

    // Nested viem / ethers cause
    if (record.cause) {
      return formatUnknownError(record.cause, fallback);
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json.slice(0, 280);
    } catch {
      // ignore
    }
  }

  return fallback;
}
