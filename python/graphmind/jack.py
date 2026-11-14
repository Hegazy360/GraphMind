"""GraphMind Jack — account linking for your API (Python port of @graphmind-ai/jack-verify).

Jack's ``link`` sign-in mode is for apps that have a session login and no
OAuth server. You add two things to your API, both with this module:

1. A link route. Jack sends a signed-in user of your app to it with
   ``?request=<token>``. Verify the request, take the user from your own
   session, and redirect them to ``link_response_url(...)``::

       jack = JackVerifier(secret=os.environ["JACK_LINK_SECRET"], issuer=..., audience=...)

       @app.get("/jack/link")
       def jack_link():
           req = jack.verify_link_request(request.args["request"])
           if not current_user:
               return redirect(url_for("login", next=request.full_path))
           token = request.args["request"]
           user = current_user
           return redirect(jack.link_response_url(token, user_id=user.id, name=user.name))

2. The assertion. Every request Jack makes for that user carries a
   ``Jack-Assertion`` header: a 60-second, single-use signed token naming the
   user and the permissions they granted. ``assertion_from_headers`` turns it
   into the current user; no header means "not a Jack call" (your other auth
   applies).

Standard library only. One shared secret (``JACK_LINK_SECRET``, also stored
encrypted in Jack) signs all three token kinds (HS256); each carries its own
``typ`` so none can stand in for another.
"""

from __future__ import annotations

import base64
import hmac
import json
import secrets as _secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ASSERTION_HEADER = "jack-assertion"
TYP_REQUEST = "jack-link-request"
TYP_RESPONSE = "jack-link-response"
TYP_ASSERTION = "jack-link-assertion"
RESPONSE_TTL_SECONDS = 300

__all__ = [
    "ASSERTION_HEADER",
    "Assertion",
    "JackLinkError",
    "JackVerifier",
    "LinkRequest",
    "sign_hs256",
    "verify_hs256",
]


class JackLinkError(Exception):
    """Anything wrong with a Jack token: bad signature, wrong type, expired, replayed…"""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def sign_hs256(payload: Mapping[str, Any], secret: str) -> str:
    """Compact HS256 JWT. Standard, so Jack (Node) verifies it unchanged."""
    head = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64url(json.dumps(dict(payload), separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), sha256).digest()
    return f"{head}.{body}.{_b64url(sig)}"


def verify_hs256(
    token: str,
    secret: str,
    *,
    typ: str,
    issuer: str,
    audience: str,
    now: float | None = None,
    skew: int = 60,
) -> dict[str, Any]:
    """Verify the signature (constant-time), then ``alg``, ``typ``, ``iss``, ``aud``, times."""
    parts = token.split(".")
    if len(parts) != 3:
        raise JackLinkError("malformed token")
    head, body, sig = parts
    try:
        header = json.loads(_unb64url(head))
        payload = json.loads(_unb64url(body))
    except Exception:
        raise JackLinkError("malformed token") from None
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise JackLinkError("unexpected algorithm")
    expected = hmac.new(secret.encode(), f"{head}.{body}".encode(), sha256).digest()
    try:
        given = _unb64url(sig)
    except Exception:
        raise JackLinkError("bad signature") from None
    if not hmac.compare_digest(given, expected):
        raise JackLinkError("bad signature")
    if not isinstance(payload, dict):
        raise JackLinkError("malformed token")
    if payload.get("typ") != typ:
        raise JackLinkError(f"wrong token type (expected {typ})")
    if payload.get("iss") != issuer:
        raise JackLinkError("wrong issuer")
    aud = payload.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if audience not in auds:
        raise JackLinkError("wrong audience")
    t = int(time.time() if now is None else now)
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp + skew < t:
        raise JackLinkError("expired")
    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and nbf - skew > t:
        raise JackLinkError("not yet valid")
    iat = payload.get("iat")
    if isinstance(iat, (int, float)) and iat - skew > t:
        raise JackLinkError("issued in the future")
    return payload


@dataclass(frozen=True)
class LinkRequest:
    request_id: str
    return_url: str
    scopes: list[str]


@dataclass(frozen=True)
class Assertion:
    user_id: str
    scopes: list[str]
    grant_id: str
    jti: str


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value != "" else None


class JackVerifier:
    """Verify Jack's link requests and assertions, and sign link responses."""

    def __init__(
        self, secret: str, issuer: str, audience: str, now: Callable[[], float] | None = None
    ) -> None:
        if not isinstance(secret, str) or len(secret) < 32:
            raise JackLinkError("secret must be at least 32 characters")
        self._secret = secret
        self._issuer = issuer.rstrip("/")
        a = urlsplit(audience)
        self._audience = f"{a.scheme}://{a.netloc}"
        self._now = now or time.time
        self._seen: dict[str, float] = {}

    # ---- link ---------------------------------------------------------------

    def verify_link_request(self, token: str) -> LinkRequest:
        p = verify_hs256(
            token,
            self._secret,
            typ=TYP_REQUEST,
            issuer=self._issuer,
            audience=self._audience,
            now=self._now(),
        )
        request_id = _text(p.get("jti"))
        return_url = _text(p.get("return"))
        if not request_id or not return_url:
            raise JackLinkError("malformed link request")
        if not return_url.startswith(self._issuer + "/"):
            raise JackLinkError("link request return URL is not the issuer")
        scope = p.get("scope")
        return LinkRequest(request_id, return_url, scope.split() if isinstance(scope, str) else [])

    def link_response(
        self, request_token: str, *, user_id: str, name: str | None = None, email: str | None = None
    ) -> str:
        """The signed response token for a linked user. Usually you want ``link_response_url``."""
        req = self.verify_link_request(request_token)
        if not isinstance(user_id, str) or user_id == "":
            raise JackLinkError("user_id is required")
        iat = int(self._now())
        payload: dict[str, Any] = {
            "typ": TYP_RESPONSE,
            "iss": self._audience,
            "aud": self._issuer,
            "jti": req.request_id,
            "sub": user_id,
        }
        if name:
            payload["name"] = name
        if email:
            payload["email"] = email
        payload["iat"] = iat
        payload["exp"] = iat + RESPONSE_TTL_SECONDS
        return sign_hs256(payload, self._secret)

    def link_response_url(
        self, request_token: str, *, user_id: str, name: str | None = None, email: str | None = None
    ) -> str:
        """Where to redirect the user after linking."""
        req = self.verify_link_request(request_token)
        token = self.link_response(request_token, user_id=user_id, name=name, email=email)
        parts = urlsplit(req.return_url)
        query = [*parse_qsl(parts.query, keep_blank_values=True), ("response", token)]
        return urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
        )

    # ---- per-call assertions ------------------------------------------------

    def verify_assertion(self, token: str) -> Assertion:
        """Raises JackLinkError on anything wrong, including a replay."""
        p = verify_hs256(
            token,
            self._secret,
            typ=TYP_ASSERTION,
            issuer=self._issuer,
            audience=self._audience,
            now=self._now(),
            skew=30,
        )
        jti, user_id, grant_id = _text(p.get("jti")), _text(p.get("sub")), _text(p.get("grant_id"))
        if not jti or not user_id or not grant_id:
            raise JackLinkError("malformed assertion")
        t = int(self._now())
        if len(self._seen) >= 10_000:
            self._seen = {k: v for k, v in self._seen.items() if v >= t}
        if self._seen.get(jti, 0) >= t:
            raise JackLinkError("assertion replayed")
        self._seen[jti] = float(p["exp"]) + 30
        scope = p.get("scope")
        return Assertion(user_id, scope.split() if isinstance(scope, str) else [], grant_id, jti)

    def assertion_from_headers(self, headers: Mapping[str, Any]) -> Assertion | None:
        """Read ``Jack-Assertion`` from a header mapping (WSGI environ, Flask, Django, FastAPI).

        Returns None when the header is absent."""
        value = (
            headers.get(ASSERTION_HEADER)
            or headers.get("Jack-Assertion")
            or headers.get("HTTP_JACK_ASSERTION")
        )
        if not value:
            return None
        return self.verify_assertion(value if isinstance(value, str) else str(value))


def random_jti() -> str:
    return _secrets.token_urlsafe(12)
