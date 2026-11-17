import { describe, expect, it } from 'vitest';
import { normalizeCodexUsage } from './codex-usage.js';

describe('normalizeCodexUsage', () => {
  it('maps primary and secondary windows with labels and remaining percentages', () => {
    const summary = normalizeCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { limit_window_seconds: 18000, used_percent: 12, reset_at: 1790036132 },
        secondary_window: { limit_window_seconds: 604800, used_percent: 40, reset_at: 1790640932 },
      },
      credits: { has_credits: true, unlimited: false, balance: '4.50' },
    });

    expect(summary.planType).toBe('plus');
    expect(summary.windows).toEqual([
      {
        label: '5-hour',
        usedPercent: 12,
        remainingPercent: 88,
        windowSeconds: 18000,
        resetAt: 1790036132,
      },
      {
        label: 'Weekly',
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: 604800,
        resetAt: 1790640932,
      },
    ]);
    expect(summary.credits).toEqual({ hasCredits: true, unlimited: false, balance: '4.50' });
  });

  it('labels additional rate limits and clamps percentages', () => {
    const summary = normalizeCodexUsage({
      additional_rate_limits: [
        {
          limit_name: 'GPT-5 Codex',
          rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 120 } },
        },
      ],
    });

    expect(summary.windows).toEqual([
      {
        label: 'GPT-5 Codex 5-hour',
        usedPercent: 120,
        remainingPercent: 0,
        windowSeconds: 18000,
        resetAt: null,
      },
    ]);
  });

  it('returns empty windows for an unrecognized body', () => {
    expect(normalizeCodexUsage({}).windows).toEqual([]);
  });
});
