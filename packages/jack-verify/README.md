# @graphmind-ai/jack-verify

What you add to **your API** for GraphMind Jack's account-linking sign-in
mode. Zero dependencies. Python (`graphmind.jack`) and Ruby
(`Graphmind::Jack`) ports live in this repo's `python/` and `ruby/`.

```js
import { createJackVerifier } from '@graphmind-ai/jack-verify';

const jack = createJackVerifier({
  secret: process.env.JACK_LINK_SECRET,   // shared with the Jack project (its Sign-in page)
  issuer: process.env.JACK_LINK_ISSUER,   // the Jack project's issuer URL
  audience: 'https://api.acme.com',       // your API's origin, as Jack calls it
});

// 1. The link route Jack sends signed-in users to.
app.get('/jack/link', (req, res) => {
  jack.verifyLinkRequest(req.query.request);
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.redirect(jack.linkResponseUrl(req.query.request, { userId: req.user.id, name: req.user.name }));
});

// 2. The per-call assertion: req.jackUser = { userId, scopes, grantId } on Jack's calls.
app.use(jack.express());          // or app.use('*', jack.hono()) · or jack.verifyAssertion(header) anywhere
```

Tokens are standard HS256 JWTs; assertions live 60 seconds and are single-use.
See `docs/jack/USAGE.md`, *Account linking*.
