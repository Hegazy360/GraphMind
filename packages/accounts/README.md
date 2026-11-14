# @graphmind-ai/accounts

Self-serve accounts for GraphMind's dashboard servers (Circuit and Jack): email and password
sign-up, browser sessions, and personal API tokens for CLIs. Registration is open and there are
no plans, quotas or payments; that is a decision for later, and the `allowSignup` switch is the
only knob.

```ts
import { createAccounts, SqliteAccountStore } from '@graphmind-ai/accounts';

const accounts = createAccounts({ store: new SqliteAccountStore('accounts.db'), publicOrigin: 'https://app.example.com' });
app.route('/', accounts.routes);           // /auth/signup, /auth/login, /auth/logout, /auth/me, /auth/tokens
app.use('/v1/*', accounts.requireUser());  // session cookie or `Authorization: Bearer gmt_…`
app.get('/v1/whoami', (c) => c.json(accounts.principal(c)!.user));
```

What is enforced (each has a test): scrypt password hashes with stored parameters; sessions are
random 256-bit tokens stored hashed, `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-`-prefixed
on https; state-changing requests from a session must come from the server's own origin; failed
sign-ins are rate-limited per address and email; unknown emails take as long as wrong passwords;
API tokens are shown once, stored hashed, and can only be minted or revoked from a browser session.
