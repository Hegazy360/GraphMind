/**
 * Test setup, for both environments.
 *
 * The jest-dom matchers (`toBeVisible`, `toBeDisabled`, `toHaveAccessibleName`)
 * and React Testing Library's auto-cleanup only mean anything under jsdom,
 * so they are loaded only there — a node-environment suite importing a DOM
 * library would fail at import time, not at the assertion.
 */
if (globalThis.document !== undefined) {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup, configure } = await import('@testing-library/react');
  const { afterEach } = await import('vitest');
  // The viewer's own class names are the stable hooks the e2e audit uses,
  // so a failure message that prints them is the useful one.
  configure({ testIdAttribute: 'data-testid' });
  afterEach(() => cleanup());
}

export {};
