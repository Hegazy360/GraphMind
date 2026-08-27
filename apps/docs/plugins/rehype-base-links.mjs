/**
 * Prefix root-absolute links and asset sources written in Markdown/MDX with
 * Astro's `base`.
 *
 * The site is served from `graphmind.ai/docs`, but pages are authored with
 * plain root-absolute links (`/start/install/`) so the source stays readable
 * and the deploy path stays a one-line config change. Astro rewrites `base`
 * into its own routing and into imported assets, but not into raw hrefs in
 * content — this closes that gap.
 *
 * Left alone: external URLs, protocol-relative URLs, fragments, mailto/tel,
 * relative paths, and anything already under the base.
 *
 * Hand-rolled tree walk rather than `unist-util-visit`: it is six lines, and
 * the repo's convention is to not add a dependency for six lines.
 */
const ATTRS = ['href', 'src'];

export function rehypeBaseLinks({ base = '/' } = {}) {
  const prefix = base === '/' ? '' : base.replace(/\/+$/, '');

  function rebase(node) {
    if (node.type === 'element' && node.properties !== undefined) {
      for (const attr of ATTRS) {
        const value = node.properties[attr];
        if (typeof value !== 'string') continue;
        if (!value.startsWith('/')) continue; // relative, fragment, mailto, or absolute URL
        if (value.startsWith('//')) continue; // protocol-relative
        if (value === prefix || value.startsWith(`${prefix}/`)) continue; // already based
        node.properties[attr] = `${prefix}${value}`;
      }
    }
    const children = node.children;
    if (Array.isArray(children)) for (const child of children) rebase(child);
  }

  return function transformer(tree) {
    if (prefix === '') return;
    rebase(tree);
  };
}

export default rehypeBaseLinks;
