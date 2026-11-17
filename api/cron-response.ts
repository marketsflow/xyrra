/**
 * Vercel Cron responses count toward project egress. Cron hits ~10k+/day;
 * omit heavy debug payloads (full `rows`, tick bodies) when the caller is cron.
 */

export function isCronRequest(
  authorization: string | null | undefined,
  cronSecret: string | undefined,
): boolean {
  if (!cronSecret?.trim()) return false;
  const raw = authorization?.trim() ?? "";
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  return token === cronSecret;
}

export function dropKeys<T extends Record<string, unknown>>(
  body: T,
  keys: (keyof T)[],
): T {
  const out = { ...body };
  for (const key of keys) {
    delete out[key];
  }
  return out;
}