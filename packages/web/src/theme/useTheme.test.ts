import { describe, expect, it, beforeEach } from 'vitest';
import { useTheme } from './useTheme.js';

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to command-deck and sets the attribute', () => {
    const { theme } = useTheme();
    expect(theme.value).toBe('command-deck');
    expect(document.documentElement.dataset.theme).toBe('command-deck');
  });

  it('setTheme switches and persists', () => {
    const first = useTheme();
    first.setTheme('blueprint-light');
    expect(document.documentElement.dataset.theme).toBe('blueprint-light');
    // module-scoped state: a fresh call sees the same theme
    const second = useTheme();
    expect(second.theme.value).toBe('blueprint-light');
    expect(localStorage.getItem('legion-theme')).toBe('blueprint-light');
  });

  it('restores the persisted theme on init', () => {
    localStorage.setItem('legion-theme', 'blueprint-light');
    // simulate a fresh module graph: initTheme is idempotent-safe to call again
    const { theme, initTheme } = useTheme();
    initTheme();
    expect(theme.value).toBe('blueprint-light');
    expect(document.documentElement.dataset.theme).toBe('blueprint-light');
  });

  it('ignores unknown persisted values', () => {
    localStorage.setItem('legion-theme', 'solarized');
    const { theme, initTheme } = useTheme();
    initTheme();
    expect(theme.value).toBe('command-deck');
  });
});
