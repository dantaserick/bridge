// Small narrowing helpers for untrusted hook/statusline JSON payloads coming
// from Claude Code. Deliberately no schema library (zod, etc.) — these are
// call-site-friendly type guards that return `undefined`/`{}` on a mismatch
// instead of throwing, so callers can chain `??`/`||` for defaults.

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
