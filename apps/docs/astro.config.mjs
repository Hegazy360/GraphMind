// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const GITHUB = 'https://github.com/Hegazy360/GraphMind';

export default defineConfig({
  site: 'https://docs.graphmind.ai',
  build: { format: 'directory' },
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
