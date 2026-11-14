"""Jack account linking: the Python verifier against the token rules Jack's server uses."""

from __future__ import annotations

import pytest

from graphmind.jack import (
    TYP_ASSERTION,
    TYP_REQUEST,
    TYP_RESPONSE,
    JackLinkError,
    JackVerifier,
    sign_hs256,
    verify_hs256,
)

SECRET = "a-shared-secret-of-at-least-32-characters-long"
ISSUER = "https://acme.mcp.graphmind.ai"
AUD = "https://api.acme.com"
T0 = 1_800_000_000


def make_request(now: int, **over: object) -> str:
    payload = {
        "typ": TYP_REQUEST,
        "iss": ISSUER,
        "aud": AUD,
        "jti": "jar_1",
        "return": f"{ISSUER}/oauth/link/callback",
        "scope": "notes:read",
        "iat": now,
        "exp": now + 300,
    }
    payload.update(over)
    return sign_hs256(payload, str(over.pop("_secret", SECRET)))


def make_assertion(now: int, **over: object) -> str:
    payload = {
        "typ": TYP_ASSERTION,
        "iss": ISSUER,
        "aud": AUD,
        "sub": "usr_1",
        "grant_id": "grt_1",
        "scope": "notes:read notes:write",
        "jti": "j1",
        "iat": now,
        "exp": now + 60,
    }
    payload.update(over)
    return sign_hs256(payload, SECRET)


class Clock:
    def __init__(self) -> None:
        self.t = float(T0)

    def __call__(self) -> float:
        return self.t


def test_refuses_weak_secret() -> None:
    with pytest.raises(JackLinkError, match="32 characters"):
        JackVerifier(secret="short", issuer=ISSUER, audience=AUD)


def test_link_request_response_round_trip() -> None:
    clock = Clock()
    jack = JackVerifier(secret=SECRET, issuer=ISSUER, audience=AUD, now=clock)
    req = jack.verify_link_request(make_request(T0))
    assert (req.request_id, req.return_url, req.scopes) == (
        "jar_1",
        f"{ISSUER}/oauth/link/callback",
        ["notes:read"],
    )
    url = jack.link_response_url(make_request(T0), user_id="usr_1", name="Alice", email="a@x.test")
    assert url.startswith(f"{ISSUER}/oauth/link/callback?response=")
    token = url.split("response=", 1)[1]
    p = verify_hs256(token, SECRET, typ=TYP_RESPONSE, issuer=AUD, audience=ISSUER, now=T0)
    assert (p["jti"], p["sub"], p["name"], p["email"]) == ("jar_1", "usr_1", "Alice", "a@x.test")
    with pytest.raises(JackLinkError, match="user_id"):
        jack.link_response(make_request(T0), user_id="")


@pytest.mark.parametrize(
    ("token", "why"),
    [
        (
            make_request(T0, _secret="another-secret-that-is-long-enough-0000000000"),
            "bad signature",
        ),
        (make_request(T0, iss="https://evil.mcp.graphmind.ai"), "wrong issuer"),
        (make_request(T0, aud="https://other.acme.com"), "wrong audience"),
        (make_request(T0, exp=T0 - 120), "expired"),
        (make_request(T0, typ=TYP_ASSERTION), "wrong token type"),
        (make_request(T0) + "x", "signature|malformed"),
        ("not.a.jwt", "malformed"),
        (make_request(T0, **{"return": "https://evil.example/steal"}), "not the issuer"),
    ],
)
def test_bad_link_requests(token: str, why: str) -> None:
    jack = JackVerifier(secret=SECRET, issuer=ISSUER, audience=AUD, now=Clock())
    with pytest.raises(JackLinkError, match=why):
        jack.verify_link_request(token)


def test_alg_none_is_refused() -> None:
    import base64

    body = make_request(T0).split(".")[1]
    head = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b"=").decode()
    jack = JackVerifier(secret=SECRET, issuer=ISSUER, audience=AUD, now=Clock())
    with pytest.raises(JackLinkError, match="algorithm"):
        jack.verify_link_request(f"{head}.{body}.")


def test_assertions_single_use_and_skew() -> None:
    clock = Clock()
    jack = JackVerifier(secret=SECRET, issuer=ISSUER, audience=AUD, now=clock)
    a = jack.verify_assertion(make_assertion(T0, jti="once"))
    assert (a.user_id, a.grant_id, a.jti, a.scopes) == (
        "usr_1",
        "grt_1",
        "once",
        ["notes:read", "notes:write"],
    )
    with pytest.raises(JackLinkError, match="replayed"):
        jack.verify_assertion(make_assertion(T0, jti="once"))
    clock.t = T0 + 61  # past exp, inside the 30 s skew
    jack.verify_assertion(make_assertion(T0, jti="late"))
    clock.t = T0 + 120
    with pytest.raises(JackLinkError, match="expired"):
        jack.verify_assertion(make_assertion(T0, jti="stale"))
    with pytest.raises(JackLinkError, match="malformed"):
        jack.verify_assertion(make_assertion(T0 + 120, jti="g", grant_id=""))
    with pytest.raises(JackLinkError, match="wrong token type"):
        jack.verify_assertion(make_request(T0 + 120))


def test_assertion_from_headers_wsgi_and_plain() -> None:
    jack = JackVerifier(secret=SECRET, issuer=ISSUER, audience=AUD, now=Clock())
    assert jack.assertion_from_headers({}) is None
    assert (
        jack.assertion_from_headers({"HTTP_JACK_ASSERTION": make_assertion(T0, jti="w")}).user_id
        == "usr_1"
    )
    assert (
        jack.assertion_from_headers({"Jack-Assertion": make_assertion(T0, jti="p")}).user_id
        == "usr_1"
    )
    with pytest.raises(JackLinkError):
        jack.assertion_from_headers({"jack-assertion": "garbage"})
