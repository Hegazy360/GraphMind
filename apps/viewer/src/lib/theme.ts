/**
 * Theme: follow the OS by default, or pin dark/light. The choice is stamped
 * on `<html data-theme>` (CSS owns the rest) and remembered in localStorage,
 * which is also what makes both themes reviewable side by side.
 */
import type { ThemeChoice } from '../store/uiStore.js';

export const THEME_STORAGE_KEY = 'graphmind.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'dark' || value === 'light';
}

export function loadTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system'; // storage blocked (private mode) — follow the OS
  }
}

export function saveTheme(theme: ThemeChoice): void {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // non-fatal: the theme still applies for this session
  }
}

/** Cycle order for the toolbar toggle. */
export function nextTheme(current: ThemeChoice): ThemeChoice {
  return current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system';
}

export function resolveTheme(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  if (typeof matchMedia !== 'function') return 'dark';
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function themeLabel(choice: ThemeChoice): string {
  return choice === 'system' ? 'System theme' : choice === 'dark' ? 'Dark theme' : 'Light theme';
}
