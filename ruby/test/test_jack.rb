# frozen_string_literal: true

# Jack account linking: the Ruby verifier against the token rules Jack's server uses.
require_relative "test_helper"
require "graphmind/jack"

class TestJack < Minitest::Test
  SECRET = "a-shared-secret-of-at-least-32-characters-long"
  ISSUER = "https://acme.mcp.graphmind.ai"
  AUD = "https://api.acme.com"
  T0 = 1_800_000_000

  def request_token(now = T0, secret: SECRET, **over)
    payload = { typ: Graphmind::Jack::TYP_REQUEST, iss: ISSUER, aud: AUD, jti: "jar_1", return: "#{ISSUER}/oauth/link/callback",
                scope: "notes:read", iat: now, exp: now + 300 }.merge(over)
    Graphmind::Jack.sign_hs256(payload, secret)
  end

  def assertion_token(now = T0, **over)
    payload = { typ: Graphmind::Jack::TYP_ASSERTION, iss: ISSUER, aud: AUD, sub: "usr_1", grant_id: "grt_1",
                scope: "notes:read notes:write", jti: "j1", iat: now, exp: now + 60 }.merge(over)
    Graphmind::Jack.sign_hs256(payload, SECRET)
  end

  def verifier(clock)
    Graphmind::Jack::Verifier.new(secret: SECRET, issuer: ISSUER, audience: AUD, now: -> { clock[:t] })
  end

  def test_refuses_weak_secret
    e = assert_raises(Graphmind::Jack::LinkError) { Graphmind::Jack::Verifier.new(secret: "short", issuer: ISSUER, audience: AUD) }
    assert_match(/32 characters/, e.message)
  end

  def test_round_trip
    jack = verifier({ t: T0.to_f })
    req = jack.verify_link_request(request_token)
    assert_equal ["jar_1", "#{ISSUER}/oauth/link/callback", ["notes:read"]], [req.request_id, req.return_url, req.scopes]
    url = jack.link_response_url(request_token, user_id: "usr_1", name: "Alice", email: "a@x.test")
    assert url.start_with?("#{ISSUER}/oauth/link/callback?response=")
    token = url.split("response=", 2).last
    p = Graphmind::Jack.verify_hs256(token, SECRET, typ: Graphmind::Jack::TYP_RESPONSE, issuer: AUD, audience: ISSUER, now: T0)
    assert_equal %w[jar_1 usr_1 Alice a@x.test], [p["jti"], p["sub"], p["name"], p["email"]]
    assert_raises(Graphmind::Jack::LinkError) { jack.link_response(request_token, user_id: "") }
  end

  def test_bad_link_requests
    jack = verifier({ t: T0.to_f })
    cases = {
      request_token(secret: "another-secret-that-is-long-enough-0000000000") => /bad signature/,
      request_token(iss: "https://evil.mcp.graphmind.ai") => /wrong issuer/,
      request_token(aud: "https://other.acme.com") => /wrong audience/,
      request_token(exp: T0 - 120) => /expired/,
      request_token(typ: Graphmind::Jack::TYP_ASSERTION) => /wrong token type/,
      "#{request_token}x" => /signature|malformed/,
      "not.a.jwt" => /malformed/,
      request_token(return: "https://evil.example/steal") => /not the issuer/
    }
    cases.each do |token, why|
      e = assert_raises(Graphmind::Jack::LinkError, token[0, 24]) { jack.verify_link_request(token) }
      assert_match why, e.message
    end
    body = request_token.split(".")[1]
    none = "#{Base64.urlsafe_encode64('{"alg":"none","typ":"JWT"}', padding: false)}.#{body}."
    e = assert_raises(Graphmind::Jack::LinkError) { jack.verify_link_request(none) }
    assert_match(/algorithm/, e.message)
  end

  def test_assertions_single_use_and_skew
    clock = { t: T0.to_f }
    jack = verifier(clock)
    a = jack.verify_assertion(assertion_token(jti: "once"))
    assert_equal ["usr_1", "grt_1", "once", %w[notes:read notes:write]], [a.user_id, a.grant_id, a.jti, a.scopes]
    e = assert_raises(Graphmind::Jack::LinkError) { jack.verify_assertion(assertion_token(jti: "once")) }
    assert_match(/replayed/, e.message)
    clock[:t] = (T0 + 61).to_f
    jack.verify_assertion(assertion_token(jti: "late"))
    clock[:t] = (T0 + 120).to_f
    e = assert_raises(Graphmind::Jack::LinkError) { jack.verify_assertion(assertion_token(jti: "stale")) }
    assert_match(/expired/, e.message)
    e = assert_raises(Graphmind::Jack::LinkError) { jack.verify_assertion(assertion_token(clock[:t].to_i, jti: "g", grant_id: "")) }
    assert_match(/malformed/, e.message)
  end

  def test_rack_middleware
    jack = verifier({ t: T0.to_f })
    app = ->(env) { [200, {}, [env["jack.user"] ? env["jack.user"].user_id : "anonymous"]] }
    mw = Graphmind::Jack::Middleware.new(app, jack)
    assert_equal "anonymous", mw.call({})[2].first
    assert_equal "usr_1", mw.call({ "HTTP_JACK_ASSERTION" => assertion_token(jti: "r1") })[2].first
    status, headers, body = mw.call({ "HTTP_JACK_ASSERTION" => "garbage" })
    assert_equal 401, status
    assert_equal "application/problem+json", headers["content-type"]
    assert_match(/invalid Jack assertion/, body.first)
  end
end
