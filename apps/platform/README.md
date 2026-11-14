# platform

The GraphMind platform server: the whole end-user experience on one origin, behind one account.
This is what `app.graphmind.ai` runs; locally, `pnpm platform` runs it with the homepage in front
so the complete journey can be walked and tested: graphmind.ai → Create a free account → the hub →
Circuit → Jack, with the same session everywhere.

```sh
pnpm platform                 # http://127.0.0.1:4800 — homepage at /, hub at /app/, Circuit at /app/circuit/, Jack at /app/jack/
pnpm --filter platform test       # request-level tests of the composition
pnpm --filter platform test:e2e   # the browser journey (Playwright)
```

See `src/index.ts` for the URL map and `src/cli.ts` for `dev` and `serve` (the hosted shape).
