/** Minimal inline icon set (24px grid, stroke = currentColor). */
import type { SVGProps } from 'react';

function base(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  };
}

export const IconEye = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const IconEyeOff = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.8A9.8 9.8 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.5 17.5 0 0 1-3.1 3.9M6.6 6.9A16.5 16.5 0 0 0 2 12s3.5 6.5 10 6.5a9.9 9.9 0 0 0 4.1-.9" />
    <path d="M9.9 10.1a2.6 2.6 0 0 0 3.7 3.7" />
  </svg>
);

export const IconFit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </svg>
);

export const IconArrange = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5.5" cy="19" r="2.2" />
    <circle cx="18.5" cy="19" r="2.2" />
    <path d="M12 7.2V12m0 0-5 5m5-5 5 5" />
  </svg>
);

export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </svg>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconReplay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 2.6-6.4" />
    <path d="M3 4v4h4" />
  </svg>
);

export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 5v14M15 5v14" />
  </svg>
);

export const IconTimeline = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 6h11M3 12h7M3 18h14" />
    <path d="M17 4.5v3M13 10.5v3M20 16.5v3" strokeOpacity="0.55" />
  </svg>
);

export const IconGraph = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5.5" cy="18" r="2.2" />
    <circle cx="18.5" cy="18" r="2.2" />
    <path d="M12 7.2 6.6 15.9M12 7.2l5.4 8.7" />
  </svg>
);

export const IconSplit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 14h18" />
    <path d="M6.5 17h6" strokeOpacity="0.6" />
  </svg>
);

export const IconFilter = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3.5 5.5h17l-6.6 7.6V19l-3.8 2v-7.9L3.5 5.5Z" />
  </svg>
);

export const IconCollapse = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4.5 12 7.5l3-3M15 19.5 12 16.5l-3 3" />
    <path d="M4 12h16" />
  </svg>
);

export const IconExpand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3.5v6M12 20.5v-6" />
    <path d="M9 6.5 12 3.5l3 3M15 17.5l-3 3-3-3" />
    <path d="M4 12h16" strokeOpacity="0.5" />
  </svg>
);

export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2.2" />
    <path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5" />
  </svg>
);

export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.6 6.2" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.2-1.2" />
  </svg>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconCommand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z" />
  </svg>
);

export const IconTheme = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="5" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </svg>
);

export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
  </svg>
);

export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
  </svg>
);

export const IconZoomIn = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4M11 8.4v5.2M8.4 11h5.2" />
  </svg>
);

export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3.5 12.5 8.5 4.7 8.5-4.7" strokeOpacity="0.6" />
  </svg>
);

export const IconStack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="17" height="5" rx="1.6" />
    <rect x="3.5" y="12" width="17" height="8" rx="1.6" strokeOpacity="0.6" />
  </svg>
);

// ── node-kind glyphs ───────────────────────────────────────────────────────
// Kind is carried by shape first and tint second: green and red are spoken
// for (alive / failed), and a colour-only language excludes anyone who can't
// separate two desaturated blues.

export const IconKindAgent = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="5.5" r="2.3" />
    <circle cx="5.5" cy="18" r="2.3" />
    <circle cx="18.5" cy="18" r="2.3" />
    <path d="M12 7.8 6.8 15.9M12 7.8l5.2 8.1" />
  </svg>
);

export const IconKindLlm = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3.2 13.7 9l5.8 1.7-5.8 1.7L12 18.2l-1.7-5.8L4.5 10.7 10.3 9 12 3.2Z" />
    <path d="M18.4 16.6l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7.7-2.2Z" strokeOpacity="0.55" />
  </svg>
);

export const IconKindTool = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M14.8 3.6a5 5 0 0 0-6 6.5l-5 5a2.1 2.1 0 0 0 3 3l5-5a5 5 0 0 0 6.5-6l-2.9 2.9-2.5-2.5 2.9-2.9Z" />
  </svg>
);

export const IconKindChain = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="9.5" width="7.5" height="5" rx="2.5" />
    <rect x="13.5" y="9.5" width="7.5" height="5" rx="2.5" />
    <path d="M10.5 12h3" />
  </svg>
);

export const IconKindRetriever = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" />
    <path d="M5 12v5c0 1.5 3.1 2.8 7 2.8" strokeOpacity="0.55" />
  </svg>
);

export const IconKindServer = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="17" height="6" rx="1.8" />
    <rect x="3.5" y="14" width="17" height="6" rx="1.8" />
    <path d="M7 7h.01M7 17h.01" />
  </svg>
);

export const IconKindResource = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M13.5 3.5H7a1.8 1.8 0 0 0-1.8 1.8v13.4A1.8 1.8 0 0 0 7 20.5h10a1.8 1.8 0 0 0 1.8-1.8V8.8l-5.3-5.3Z" />
    <path d="M13.4 3.6v5.2h5.2" strokeOpacity="0.6" />
  </svg>
);

export const IconKindPrompt = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20.5 12.6c0 3.6-3.8 6.5-8.5 6.5a10 10 0 0 1-2.7-.4L4.5 20.5l1.3-3.5A6.2 6.2 0 0 1 3.5 12.6c0-3.6 3.8-6.5 8.5-6.5s8.5 2.9 8.5 6.5Z" />
    <path d="M9 12h6" strokeOpacity="0.6" />
  </svg>
);

export const IconKindCustom = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="4" y="7" width="16" height="10" rx="2.4" strokeDasharray="3 3" />
  </svg>
);

export const IconKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9" />
  </svg>
);
