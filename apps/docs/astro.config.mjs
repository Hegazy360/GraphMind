// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { rehypeBaseLinks } from './plugins/rehype-base-links.mjs';

const GITHUB = 'https://github.com/Hegazy360/GraphMind';

/**
 * The docs are served from `graphmind.ai/docs` — the URL the `graphmind init`
 * command and the landing page both point at. Pages are authored with plain
 * root-absolute links; `rehypeBaseLinks` rewrites them onto this base, so
 * moving the site (e.g. to its own subdomain) is a one-line change here.
 */
const BASE = '/docs';

export default defineConfig({
  site: 'https://graphmind.ai',
  base: BASE,
  trailingSlash: 'always',
  build: { format: 'directory' },
  markdown: {
    processor: unified({ rehypePlugins: [[rehypeBaseLinks, { base: BASE }]] }),
  },
  redirects: {
    // `graphmind init` prints .../docs/reference/schema/ for adapter authors.
    // Keys are base-relative (Astro prepends `base`); destinations are not.
    '/reference/schema/': `${BASE}/reference/wire-protocol/`,
  },
  integrations: [
    starlight({
      title: 'GraphMind',
      description:
        'GraphMind is a live debugger for AI agents. Attach to a running agent: watch the execution graph, pause on error, set breakpoints, inspect every input and output, inject a fix, and resume. Local-first, MIT.',
      tagline: 'The live debugger for AI agents.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'GraphMind',
        replacesTitle: false,
      },
      favicon: '/graphmind.png',
      customCss: ['./src/styles/theme.css'],
      editLink: { baseUrl: `${GITHUB}/edit/master/apps/docs/` },
      lastUpdated: false,
      credits: false,
      social: [
        { icon: 'github', label: 'GitHub', href: GITHUB },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/graphmind-ai' },
      ],
      head: [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#0a0a0c', media: '(prefers-color-scheme: dark)' },
        },
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: '#fbfbfc', media: '(prefers-color-scheme: light)' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
          },
        },
      ],
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: {
          borderRadius: '10px',
          codeFontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
          codeFontSize: '0.855rem',
          codeLineHeight: '1.7',
          borderColor: 'var(--gm-code-border)',
          frames: {
            editorActiveTabIndicatorTopColor: 'var(--gm-accent)',
            terminalTitlebarDotsForeground: 'var(--gm-border-strong)',
          },
          textMarkers: {
            markBackground: 'var(--gm-accent-dim)',
            markBorderColor: 'var(--gm-accent)',
          },
        },
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'start/what-is-graphmind' },
            { slug: 'start/install' },
            { slug: 'start/concepts' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { slug: 'integrations' },
            { slug: 'integrations/vercel-ai-sdk' },
            { slug: 'integrations/anthropic' },
            { slug: 'integrations/openai' },
            { slug: 'integrations/langgraph' },
            { slug: 'integrations/python' },
            { slug: 'integrations/other-frameworks' },
          ],
        },
        {
          label: 'Debugging workflows',
          items: [
            { slug: 'debugging/pause-on-error' },
            { slug: 'debugging/breakpoints-and-step' },
            { slug: 'debugging/inspecting' },
            { slug: 'debugging/inject-and-continue' },
            { slug: 'debugging/retry-and-abort' },
            { slug: 'debugging/large-graphs' },
            { slug: 'debugging/comparing-runs' },
            { slug: 'debugging/recording-runs' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/viewer' },
            { slug: 'reference/cli' },
            { slug: 'reference/environment' },
            { slug: 'reference/wire-protocol' },
            { slug: 'reference/mcp' },
            { slug: 'reference/telemetry' },
            { slug: 'reference/faq' },
            { slug: 'reference/troubleshooting' },
          ],
        },
        {
          label: 'Contributing',
          items: [{ slug: 'contributing/writing-an-adapter' }, { slug: 'contributing/project' }],
        },
      ],
    }),
  ],
});
