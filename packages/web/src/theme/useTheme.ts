import { ref } from 'vue';

export type ThemeName = 'command-deck' | 'blueprint-light';
const STORAGE_KEY = 'legion-theme';

const theme = ref<ThemeName>('command-deck');

function isThemeName(value: unknown): value is ThemeName {
  return value === 'command-deck' || value === 'blueprint-light';
}

function apply(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

export function useTheme() {
  apply(theme.value);

  function initTheme(): void {
    const stored = localStorage.getItem(STORAGE_KEY);
    theme.value = isThemeName(stored) ? stored : 'command-deck';
    apply(theme.value);
  }

  function setTheme(next: ThemeName): void {
    theme.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  return { theme, setTheme, initTheme };
}
