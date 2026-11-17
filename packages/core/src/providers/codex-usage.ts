import type { ProviderUsageSummary, ProviderUsageWindow } from '@legion-collective/types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function windowLabel(seconds: number): string {
  if (seconds === 18_000) return '5-hour';
  if (seconds === 604_800) return 'Weekly';
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}-hour`;
  return `${Math.round(seconds / 86_400)}-day`;
}

function mapWindow(
  raw: unknown,
  fallbackLabel: string,
  prefix?: string,
): ProviderUsageWindow | null {
  const window = asRecord(raw);
  if (Object.keys(window).length === 0) return null;

  const windowSeconds = asNumber(window['limit_window_seconds']);
  const used = asNumber(window['used_percent']);
  const resetAt = asNumber(window['reset_at']);

  const label =
    windowSeconds === null
      ? fallbackLabel
      : prefix
        ? `${prefix} ${windowLabel(windowSeconds)}`
        : windowLabel(windowSeconds);

  return {
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    windowSeconds,
    resetAt,
  };
}

export function normalizeCodexUsage(raw: unknown): ProviderUsageSummary {
  const body = asRecord(raw);
  const windows: ProviderUsageWindow[] = [];

  const rateLimit = asRecord(body['rate_limit']);
  const primary = mapWindow(rateLimit['primary_window'], 'Primary');
  if (primary) windows.push(primary);
  const secondary = mapWindow(rateLimit['secondary_window'], 'Secondary');
  if (secondary) windows.push(secondary);

  const additional = body['additional_rate_limits'];
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const item = asRecord(entry);
      const prefix =
        asString(item['limit_name']) ?? asString(item['metered_feature']) ?? 'Additional';
      const nested = asRecord(item['rate_limit']);
      const p = mapWindow(nested['primary_window'], 'Primary', prefix);
      if (p) windows.push(p);
      const s = mapWindow(nested['secondary_window'], 'Secondary', prefix);
      if (s) windows.push(s);
    }
  }

  const creditsRaw = asRecord(body['credits']);
  const credits =
    Object.keys(creditsRaw).length > 0
      ? {
          hasCredits: creditsRaw['has_credits'] === true,
          unlimited: creditsRaw['unlimited'] === true,
          balance: asString(creditsRaw['balance']),
        }
      : null;

  return {
    planType: asString(body['plan_type']) ?? undefined,
    windows,
    credits,
    capturedAt: new Date().toISOString(),
  };
}
