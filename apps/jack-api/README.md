# jack-api

GraphMind Jack control plane (`/v1`) and data plane (`/mcp`, `/oauth`, `/.well-known`). Serves the dashboard at `/`. With `accounts` (`@graphmind-ai/accounts`, `jack serve --accounts`) `/v1` needs a signed-in user or a personal token and every project belongs to the account that created it; a static `apiKeys` entry is the operator and sees all of them; `GET /health` stays public. See `docs/plans/hosted-mcp-jack.md` and `docs/jack/USAGE.md`.
