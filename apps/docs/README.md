# docs

The GraphMind documentation site — [docs.graphmind.ai](https://docs.graphmind.ai).

**Astro + Starlight**, static output. Sidebar nav, full-text search (Pagefind), dark/light
themes, tabbed code blocks and callouts come from Starlight; the GraphMind look comes from
`src/styles/theme.css`, which maps Starlight's design tokens onto the graphmind.ai palette.

## Run it

```sh
pnpm --filter docs dev          # http://localhost:4321/docs/
pnpm --filter docs build        # -> apps/docs/dist (static)
pnpm --filter docs preview      # serve the build locally
pnpm --filter docs check:links  # post-build link check (run after build)
```

`check:links` walks `dist/docs/` (the `outDir`, which already carries the base path) and fails on a link to a missing page, a missing anchor, a page that
never got the `base` prefix, or a page nothing links to (usually one missing from the sidebar).
No dependencies — run it after any content change.

Note the `/docs/` path — see [Base path](#base-path) below.

Requires Node >= 22.13 (the repo-wide floor).

> Search is built by Pagefind at build time, so it works in `preview` and in production but not
> in `dev`. Use `build` + `preview` to test it.

## Base path

The site is served at **`graphmind.ai/docs`**, not at a root or a subdomain. That is not a
preference — `packages/cli/src/commands/init.ts` prints `https://graphmind.ai/docs/...` URLs and
`apps/web/index.html` links to `/docs`, and both are frozen.

So `astro.config.mjs` sets `base: '/docs'`, and:

- Astro handles its own routing, and imported assets under `src/assets/`.
- `plugins/rehype-base-links.mjs` rewrites root-absolute links written in **Markdown**
  (`[x](/start/install/)`).
- `src/lib/with-base.ts` + `src/components/LinkCard.astro` handle **MDX component props and raw
  JSX attributes**, which the rehype plugin cannot see (they compile to JSX expressions, not
  hast).

**Author every internal link as a plain root-absolute path** (`/reference/cli/`) and import
`LinkCard` from `../../components/LinkCard.astro` rather than from
`@astrojs/starlight/components`. Moving the site is then a one-line change to `BASE` in
`astro.config.mjs`.

`/reference/schema/` redirects to `/reference/wire-protocol/` because `graphmind init` prints
the former.

## Layout

```
astro.config.mjs        site config + the whole sidebar (page order lives here)
plugins/
  rehype-base-links.mjs prefixes Markdown links with `base`
src/
  content.config.ts     Starlight content collection
  components/
    LinkCard.astro      Starlight's LinkCard with a base-aware href
  lib/with-base.ts      resolve a root-absolute path against `base`
  content/docs/         every page (.mdx)
    index.mdx           landing page (splash template)
    start/              what GraphMind is, install, core concepts
    integrations/       one page per framework
    debugging/          the debugging workflows
    reference/          CLI, env vars, wire protocol, MCP, telemetry, FAQ, troubleshooting
    contributing/       writing an adapter, project conventions
  styles/theme.css      GraphMind theme over Starlight's tokens
  assets/               images referenced from markdown (optimised by Astro)
public/                 served as-is: demo.gif, graphmind.png
```

## Adding a page

1. Create `src/content/docs/<section>/<slug>.mdx` with `title` and `description` frontmatter.
2. Add its slug to the matching sidebar group in `astro.config.mjs` — the sidebar is explicit,
   so a page that is not listed there will build but stay unlinked.

Starlight components (`Tabs`, `TabItem`, `Aside`, `Steps`, `Card`, `CardGrid`, `LinkCard`,
`FileTree`) are imported from `@astrojs/starlight/components`.

> A fenced code block inside `<TabItem>` needs a blank line before and after it, and the
> `<TabItem>` tags on their own lines. Inline forms fail the MDX parse.

## Images

- `src/assets/*` — referenced from MDX, optimised and hashed by Astro. Use for screenshots.
- `public/*` — served verbatim. `demo.gif` lives here so it stays animated (the image pipeline
  would flatten it).

Assets are copied from the repo's `docs/assets/`; re-copy from there if the originals change.

## Deploying

Zero-config on Vercel beyond framework detection: it picks up Astro, builds with `astro build`,
and serves `dist/`. Fully static — no server runtime, no environment variables.

`vercel.json` sets `cleanUrls` + `trailingSlash`, and rewrites `/docs/*` → `/*` so this project
answers correctly on **both** path shapes: at its own deployment URL and behind a
`graphmind.ai/docs` proxy.

**One step is outside this package** (`apps/web` is not owned here): for the docs to appear at
`graphmind.ai/docs`, add a rewrite to `apps/web/vercel.json`:

```json
{
  "rewrites": [
    { "source": "/docs", "destination": "https://<docs-deployment>/docs" },
    { "source": "/docs/:path*", "destination": "https://<docs-deployment>/docs/:path*" }
  ]
}
```

Without it, the docs still work standalone at their own deployment URL — but the `graphmind init`
links and the landing page's "Docs" nav item point at `graphmind.ai/docs` and would 404.

## Content rules

Everything here is grounded in the actual packages (`packages/schema`, `packages/client`,
`packages/ai-sdk`, `packages/cli` and their READMEs). Do not document behaviour that is not
implemented — if it is aspirational, leave it out or say plainly that it is not there yet.
