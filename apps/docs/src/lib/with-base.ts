/**
 * Resolve a root-absolute site path against Astro's `base`.
 *
 * Pages are authored with plain paths (`/start/install/`) so the source stays
 * readable and the deploy path stays a one-line change in `astro.config.mjs`.
 * Markdown links go through the `rehypeBaseLinks` plugin; MDX component props
 * and raw JSX attributes go through this.
 *
 * Anything that is not a root-absolute path — an external URL, a fragment, a
 * relative path, or a path already under the base — is returned unchanged.
 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  if (base === '') return path;
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}
