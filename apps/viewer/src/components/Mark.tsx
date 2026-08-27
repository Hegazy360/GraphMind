/**
 * The GraphMind node-mark: three nodes, two edges, the top one live. Same
 * shape as the mark on graphmind.ai so the tool and the site read as one
 * product.
 */
export function GraphMindMark({ size = 18, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={animated ? 'gm-mark gm-mark--animated' : 'gm-mark'}
    >
      <path
        d="M12 7.4 6.2 15M12 7.4l5.8 7.6"
        stroke="var(--text-faint)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="5" cy="17" r="2.4" fill="var(--text-dim)" />
      <circle cx="19" cy="17" r="2.4" fill="var(--text-dim)" />
      <circle cx="12" cy="5" r="2.4" fill="var(--accent)" />
    </svg>
  );
}
