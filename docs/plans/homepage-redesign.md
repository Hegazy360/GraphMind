# graphmind.ai redesign — research and proposal

> Status: phases 0–2 and the hero demo built 2026-11-14 (see CHANGELOG "graphmind.ai, redesigned");
> phase 3 (GitHub sign-in, pick-one onboarding) and the motion polish pass remain. Originally: Goal: more visitors sign up **and try a
> product**, without the page getting harder to read as products are added.

---

## 1. The current page, measured

| Measure | Now | Why it matters |
|---|---|---|
| Words in `<main>` | 719 | Every section asks to be read; nothing is skippable by design |
| Sections | 9 | Hero, strip, 5 product sections, stack, closing |
| CTA-styled links | 9 (6 go to `/signup`) | Repetition is fine; *competing* CTAs are not (try, install, docs, builder guide, sign in) |
| Product names before the first clip | 4 (notice bar + nav: Debugger, Builder, Circuit, Jack) | Visitors meet our org chart before they meet the value |
| Bullet ticks | 15 | Three per section × five sections reads as a spec sheet |
| Clip lengths | 17–28 s | Muted loops are usually advised at 8–15 s (up to ~30 s for a hero) |
| Interactive moments | 0 (one link to `/try`) | We own a real in-browser debugger and only link to it |
| Sign-up methods | email + password | Developer audiences overwhelmingly use GitHub sign-in |
| Conversion measurement | page views (Vercel Insights) | We cannot see where visitors drop between homepage → sign-up → first use |

**The "generic AI design" feeling is specific and countable.** Our page has most of the tells the
2026 write-ups list: Inter with no typographic decision behind it; a mono uppercase eyebrow above a
huge tight headline; a soft radial glow behind the hero; a centered hero over a row of rounded
cards; tag pills; a check-mark list per section; a dark page with mid-grey body text. Individually
each is fine; together they are the default output.

## 2. What the research says

Sources are vendor-heavy (demo-tool and CRO companies); treat numbers as direction, not proof.

1. **Let visitors use the product, ungated, on the homepage.** Interactive demos convert better
   than video in every report found (Navattic 2026: +12% conversion vs product videos; 66% of
   top-performing demos are ungated; homepage placement jumped from 8% to 48% of sites). For
   developer tools specifically, "a free sandbox or playground" is the largest estimated lever
   (Relaunch: +50–80%), and "View live demo" outperforms "Sign up free" as a CTA (peal.dev).
   Retool and Figma put the working product in the hero.
2. **One primary action.** Every extra option ("Book a demo", "Watch a video", "Read the docs")
   takes attention from the main path (Relaunch, peal.dev). Keep docs in the nav.
3. **Progressive disclosure for multi-product sites:** overview first, mechanics next, specs
   later; don't mirror the org chart or group by product team instead of buyer outcome
   (Primelion). Supabase maps its products visually as one platform; PostHog goes the other way
   (documentation-style, everything visible) — it works for them because their audience came to
   read. Ours arrives from "debug my agent".
4. **Show what using it feels like.** Linear's homepage "is almost entirely the product" — you
   understand the workflow by the end of the hero (Hackmamba). Resend's homepage is interactive
   code and live send/webhook demos: "the sales process compressed into a page".
5. **Short loops.** Muted autoplay: 8–15 s "short enough to loop without feeling repetitive",
   ≤30 s for a hero; something from the product on screen within 2–3 s (Swarmify, ShotDemo,
   SmoothCapture). Completion falls sharply past 30 s (CRO Audits).
6. **GitHub sign-in for developer products.** The only solid data (Okta/Auth0) shows developer
   sites' users choose GitHub; claimed lifts for social sign-in run 10–40% (one +41% claim for
   GitHub on dev tools, unsourced). Hiding social sign-in behind "other ways" costs 15–30%.
   Caveat: GitHub's email-verified flag isn't always reliable — matters for account linking.
7. **The animation platform is ready.** CSS scroll-driven animations (`animation-timeline: view()`
   / `scroll()`) became Baseline on 2026-10-27 with Firefox 159 (Chrome 115+, Safari 26+): scroll
   storytelling without a JS animation library, on the compositor. Same-document View Transitions
   are Baseline (Firefox 144+); cross-document ones are not (no Firefox yet).
8. **Motion accessibility is a requirement, not polish.** WCAG 2.2.2 (Level A): anything that
   moves automatically for more than 5 s next to other content needs a visible pause/stop.
   `prefers-reduced-motion` is required good practice on top of that, not instead of it.
9. **Small traffic means don't A/B micro-details.** Without large volumes, micro-optimizations
   won't reach significance (peal.dev). Measure the funnel; change big things.

## 3. Recommendation in one paragraph

Turn the homepage into **one story told on our own visual language — the execution graph** — and
let the visitor **perform the core action themselves in the first screen**: a real, embedded,
ungated debugger run that pauses on a failure and asks them to click *Inject*. Everything else on
the page is that same graph continuing down the page, one node per stage of an agent's life
(**Build → Debug → Test → Run → Connect**), each revealed by scroll, each with one short loop and
one sentence. Product names become labels on those nodes, not the headline. One primary CTA
everywhere ("Start free — sign in with GitHub"), one secondary (the live demo), docs in the nav.
After sign-up, land people in a hub with something already running, so the first minute is use,
not setup.

## 4. Information architecture

Organise by what the visitor wants to do, not by product. Five stages, three shown in full above
the fold of attention, two compressed:

```
┌ nav: GraphMind · Product ▾ · Docs · GitHub ★ · Sign in · [Start free]
│
├ 1. HERO — "Your agent just failed. Fix it while it's still running."
│     ┌──────────────────────────────────────────────┐
│     │ LIVE EMBEDDED DEBUGGER (the real /try run)   │  ← the visitor clicks Inject
│     │ graph builds → holds on currencyConvert → ⏸  │    a coach-mark points at it
│     └──────────────────────────────────────────────┘
│     [Start free — GitHub]   or  npx graphmind-ai demo
│
├ 2. THE GRAPH CONTINUES (scroll-driven) — one spine, five nodes
│     ● Build    draw an agent, get the code          (loop 10 s)
│     ● Debug    you just did this ↑                  (no media — callback to the hero)
│     ● Test     every run replays as a test          (terminal + verdict, animated)
│     ● Run      Circuit: workflows that wait for you (loop 12 s)
│     ● Connect  Jack: your API in Claude             (loop 12 s)
│       each node: label, one sentence, one loop, "Open in your account →"
│
├ 3. PROOF — works with your stack (logos/chips) · open source, MIT · local-first, in one row
│
├ 4. ONE ACCOUNT — the hub screenshot, "Everything included while in early access"
│
└ 5. CLOSING — the same primary CTA + the npx command. Release notes form moves to the footer.
```

Target: **≤ 300 words** in `<main>` (from 719), **1 primary + 1 secondary CTA** repeated, no
bullet lists above the fold, every product reachable from the "Product" nav menu for people who
already know what they want.

## 5. Visual direction (leaving the defaults on purpose)

- **Motif: the page is a graph.** A 1px edge runs down the page from the hero's run into each
  stage; stage markers are node cards using the debugger's own states — idle, **live** (green
  pulse), **held** (amber), done. This replaces the radial glow, the pills and the check lists, and
  it is something only we can credibly use.
- **Typography decided, not defaulted:** a display grotesk with character for headlines (e.g.
  *Geist*, *Söhne* or *Neue Montreal*-class; self-hosted, one weight pair) + the mono we already
  use for anything that is data or code. Body stays a quiet sans. No mono uppercase eyebrows.
- **Colour has meaning:** green = live, amber = held/needs a human, red = error — the product's
  semantics, used sparingly. Body text contrast raised (avoid "60% grey on near-black").
- **Product UI is the texture.** Hairline borders, small radii, no ornament (the "Linear look"
  analyses: precision over decoration).
- **Fewer, larger media.** One hero embed, three loops; no five-card strip.

## 6. Animation system

One small, dependency-free system with three layers, all honouring `prefers-reduced-motion` and
each with a visible pause where it runs > 5 s (WCAG 2.2.2):

| Layer | Technique | Used for |
|---|---|---|
| **Scroll** | CSS `animation-timeline: view()` / `scroll()` inside `@supports`, static fallback | The spine drawing itself (`stroke-dashoffset`), nodes turning idle → live as they enter, media sliding in |
| **State** | A ~60-line JS state machine (`idle → live → held → done`) driving `data-state` attributes; CSS transitions do the rest | Stage nodes mirroring the hero run ("held" pulses while the visitor hasn't clicked Inject) |
| **Media** | IntersectionObserver play/pause (exists today) + new 8–15 s cuts | The loops; poster under reduced motion |

Rules: animate only `transform`/`opacity`/`stroke-dashoffset`; nothing animates before content is
readable; total motion budget ≤ 1 s per scroll step; no parallax on text.

## 7. The hero demo (the biggest single lever)

- Embed the real viewer's fixture run (the one `graphmind.ai/try/?fixture=1` already serves) in
  an `<iframe>` on the same origin, lazy-loaded; poster + "Play the demo" on mobile and when
  JS/iframes fail.
- Add a **coach-mark mode** to the viewer (`?fixture=1&tour=1`): when the run holds, a single
  tooltip — "This call failed. Click **Inject** to hand it the right answer" — then, on
  completion, a `postMessage` to the page so the homepage shows "You just debugged an agent.
  Do this with yours → **Start free**".
- **To verify before building:** the `/try` deployment must allow same-origin framing
  (`frame-ancestors 'self'`); the fixture viewer at narrow widths.

## 8. Sign-up and the first minute after it

- **GitHub sign-in** on the sign-up page, first and prominent; email/password stays.
  (`@graphmind-ai/accounts` gains an OAuth provider; requires a GitHub OAuth app per environment.
  Link accounts by verified email only.)
- **Pick-one onboarding** on first hub visit: three cards ("Debug an agent", "Run a workflow",
  "Put my API in Claude"), each opening its product with **sample data already loaded** — the
  Circuit onboarding run paused at its error; Jack with the Acme Tasks spec imported. Empty
  dashboards are where trials die.
- Carry intent through: the homepage CTA under a stage passes `?start=circuit|jack|debug` so the
  hub opens the right card after sign-up.

## 9. Measuring it

Add a first-party, privacy-respecting events endpoint (same pattern as the CLI telemetry
function: no cookies, no PII, anonymous session id) with eight events:

`home_view` · `demo_start` · `demo_inject` (the aha) · `cta_click{where}` · `signup_view` ·
`signup_done{method}` · `product_open{which}` · `activated{which}` (first run fixed in Circuit,
first deploy in Jack)

Read it as a funnel weekly. With our traffic, compare before/after over 2–4 weeks rather than
A/B testing details.

## 10. Plan

| Phase | Ships | Size |
|---|---|---|
| **0. Measure** | Events endpoint + the eight events on today's page | S — do first, to have a baseline |
| **1. Hero demo** | Coach-mark mode in the viewer, embedded hero, `postMessage` CTA, mobile fallback | M |
| **2. Page rebuild** | New IA, graph spine, typography, ≤ 300 words, 8–15 s re-cuts via `pnpm media` | M |
| **3. Sign-up + first minute** | GitHub OAuth, pick-one onboarding, seeded sample data, intent carry-through | M–L |
| **4. Polish** | Scroll-driven spine, state machine, motion audit, reduced-motion pass, Lighthouse ≥ 95 | S |

Decisions needed: (a) the headline direction (problem-first "Your agent just failed…" vs
product-first "The debugger for AI agents"); (b) typeface (licence/self-hosting); (c) GitHub OAuth
now or after the page; (d) whether the hero may embed the live viewer (it adds ~1 MB of JS, lazy).

## Sources

- Relaunch — [11 SaaS landing page best practices (2026)](https://relaunch.ai/blog/11-saas-landing-page-best-practices-that-separate-38-from-11)
- peal.dev — [Landing page optimization for developer tools](https://www.peal.dev/blog/landing-page-optimization-developer-tools-what-converts)
- daily.dev — [Developer-first landing pages that convert](https://business.daily.dev/resources/create-developer-first-landing-pages-convert/)
- Userpilot — [SaaS landing page examples 2026](https://userpilot.com/blog/saas-landing-pages/)
- Navattic — [State of the Interactive Product Demo 2026](https://www.navattic.com/report/state-of-the-interactive-product-demo-2026)
- Arcade — [Interactive demo benchmarks](https://www.arcade.software/post/interactive-demo-benchmarks)
- Pixel8 — [Product demo video statistics 2026](https://www.pixel8production.com/blog/product-demo-video-statistics)
- Primelion — [Explaining complex SaaS products clearly](https://primeliondigital.co.uk/blog/web-design/saas-website-design-how-to-explain-complex-products-clearly/)
- Orbix — [SaaS website design examples 2026](https://www.orbix.studio/blogs/saas-website-design-examples)
- Hackmamba — [10 developer tool homepages that get one thing right](https://hackmamba.io/developer-marketing/developer-tool-homepage-examples/)
- Frontend Horse — [The Linear Look](https://frontend.horse/articles/the-linear-look/)
- webdesignhot — [Resend DESIGN.md](https://www.webdesignhot.com/design.md/resend/)
- Designcode — [How to avoid AI slop in landing pages](https://designcode.io/articles/avoid-ai-slop-vibe-coded-landing-pages)
- 925 Studios — [AI slop design tells](https://www.925studios.co/blog/ai-slop-design-tells)
- buildtolaunch — [Fix AI slop website design](https://buildtolaunch.substack.com/p/fix-ai-slop-website-design)
- Swarmify — [Product video best practices](https://swarmify.com/blog/product-video-best-practices/) · [Video landing pages](https://swarmify.com/blog/video-landing-page/)
- ShotDemo — [How long should a product demo video be](https://www.shotdemo.com/guides/how-long-should-a-product-demo-video-be)
- CRO Audits — [Video vs static landing pages](https://croaudits.com/blog/video-vs-static-landing-pages/)
- SmoothCapture — [Landing page video guide](https://www.smoothcapture.app/blog/landing-page-video)
- Okta/Auth0 — [Going deep with social login (whitepaper)](https://www.okta.com/sites/default/files/2023-06/GoingDeepwithSocialLogin-Whitepaper-20230601-Final.pdf)
- Artisan Growth — [SaaS signup conversion](https://www.artisangrowthstrategies.com/blog/saas-signup-conversion-optimization-best-practices-guide)
- VibeWeek — [Social login implementation](https://www.vibeweek.ai/grow/social-login-oauth-chat)
- DEV — [Scroll-driven animations are Baseline](https://dev.to/richicodes/scroll-driven-animations-are-baseline-at-last-3c8g)
- CSS-Tricks — [Cross-document view transitions](https://css-tricks.com/cross-document-view-transitions-part-1/)
- webperfclinic — [View transitions MPA guide (2026)](https://webperfclinic.com/article/cross-document-view-transitions-mpa-2026)
- A11yPath — [Motion and animation](https://a11ypath.com/guides/motion-and-animation/) · EqualWeb — [WCAG 2.2.2](https://www.equalweb.com/wcag/criteria/2-2-2/)
