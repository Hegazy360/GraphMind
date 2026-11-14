# @graphmind-ai/ui

The one look and the one account space for every GraphMind web surface: the platform hub, the
Circuit dashboard and the Jack dashboard.

- `assets/graphmind.css` — graphmind.ai's design tokens (dark first, light via
  `prefers-color-scheme`) and the shared components: the top bar, buttons, inputs, cards, panels,
  pills, tables, banners, toasts, and the sign-in and account pages.
- `assets/shell.js` — `startShell({ product })` draws the top bar (GraphMind logo, the
  Home / Circuit / Jack switcher, Docs, the user menu), knows whether the page runs inside the
  platform, and owns account UX: `requireSession()`, `signOut()`, and the account page with
  personal API tokens. Inside the platform, account links and sign-in go to the hub, so there is
  exactly one account space; a standalone `jack serve --accounts` or `circuit dev --accounts`
  renders the same component in place.

Servers serve both files under `gm/`: `app.get('/gm/:name', async (c) => (await uiAsset(c.req.param('name'))) ?? c.notFound())`.
Pages load them relatively: `<link rel="stylesheet" href="./gm/graphmind.css">`,
`import { startShell } from './gm/shell.js'`. Everything renders with `textContent` and the
CSSOM, so it works under `default-src 'self'` with no inline styles or scripts.
