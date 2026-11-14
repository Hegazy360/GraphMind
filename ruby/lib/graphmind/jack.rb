# frozen_string_literal: true

require "base64"
require "json"
require "openssl"
require "securerandom"
require "uri"

module Graphmind
  # GraphMind Jack — account linking for your API (Ruby port of @graphmind-ai/jack-verify).
  #
  # Jack's `link` sign-in mode is for apps with a session login and no OAuth
  # server. You add two things, both with this module:
  #
  # 1. A link route. Jack sends a signed-in user to it with `?request=<token>`.
  #    Verify the request, take the user from your session, redirect to
  #    `link_response_url`:
  #
  #      jack = Graphmind::Jack::Verifier.new(secret: ENV.fetch("JACK_LINK_SECRET"), issuer: ..., audience: ...)
  #
  #      get "/jack/link" do
  #        jack.verify_link_request(params[:request])
  #        redirect to("/login?next=#{CGI.escape(request.fullpath)}") unless current_user
  #        redirect jack.link_response_url(params[:request], user_id: current_user.id, name: current_user.name)
  #      end
  #
  # 2. The assertion. Every request Jack makes carries a `Jack-Assertion`
  #    header: a 60-second, single-use signed token naming the user and the
  #    permissions they granted. `Graphmind::Jack::Middleware` (Rack) puts the
  #    verified assertion in `env["jack.user"]`; no header means "not a Jack call".
  #
  # Standard library only. One shared secret (`JACK_LINK_SECRET`, also stored
  # encrypted in Jack) signs all three token kinds (HS256), each with its own `typ`.
  module Jack
    ASSERTION_HEADER = "jack-assertion"
    TYP_REQUEST = "jack-link-request"
    TYP_RESPONSE = "jack-link-response"
    TYP_ASSERTION = "jack-link-assertion"
    RESPONSE_TTL_SECONDS = 300

    class LinkError < StandardError; end

    LinkRequest = Struct.new(:request_id, :return_url, :scopes, keyword_init: true)
    Assertion = Struct.new(:user_id, :scopes, :grant_id, :jti, keyword_init: true)

    module_function

    def b64url(bytes)
      Base64.urlsafe_encode64(bytes, padding: false)
    end

    def unb64url(text)
      Base64.urlsafe_decode64(text + ("=" * ((4 - text.length % 4) % 4)))
    end

    # Compact HS256 JWT. Standard, so Jack (Node) verifies it unchanged.
    def sign_hs256(payload, secret)
      head = b64url(JSON.generate({ alg: "HS256", typ: "JWT" }))
      body = b64url(JSON.generate(payload))
      sig = OpenSSL::HMAC.digest("SHA256", secret, "#{head}.#{body}")
      "#{head}.#{body}.#{b64url(sig)}"
    end

    # Verify signature (constant-time), alg, typ, iss, aud, exp/nbf/iat.
    def verify_hs256(token, secret, typ:, issuer:, audience:, now: nil, skew: 60)
      parts = token.to_s.split(".", -1)
      raise LinkError, "malformed token" unless parts.length == 3

      head, body, sig = parts
      begin
        header = JSON.parse(unb64url(head))
        payload = JSON.parse(unb64url(body))
      rescue StandardError
        raise LinkError, "malformed token"
      end
      raise LinkError, "unexpected algorithm" unless header.is_a?(Hash) && header["alg"] == "HS256"

      expected = OpenSSL::HMAC.digest("SHA256", secret, "#{head}.#{body}")
      given = begin
        unb64url(sig)
      rescue StandardError
        raise LinkError, "bad signature"
      end
      raise LinkError, "bad signature" unless given.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(given, expected)
      raise LinkError, "malformed token" unless payload.is_a?(Hash)
      raise LinkError, "wrong token type (expected #{typ})" unless payload["typ"] == typ
      raise LinkError, "wrong issuer" unless payload["iss"] == issuer

      auds = payload["aud"].is_a?(Array) ? payload["aud"] : [payload["aud"]]
      raise LinkError, "wrong audience" unless auds.include?(audience)

      t = (now || Time.now.to_f).to_i
      exp = payload["exp"]
      raise LinkError, "expired" unless exp.is_a?(Numeric) && exp + skew >= t
      raise LinkError, "not yet valid" if payload["nbf"].is_a?(Numeric) && payload["nbf"] - skew > t
      raise LinkError, "issued in the future" if payload["iat"].is_a?(Numeric) && payload["iat"] - skew > t

      payload
    end

    # Verify Jack's link requests and assertions; sign link responses.
    class Verifier
      def initialize(secret:, issuer:, audience:, now: nil)
        raise LinkError, "secret must be at least 32 characters" unless secret.is_a?(String) && secret.length >= 32

        @secret = secret
        @issuer = issuer.sub(%r{/+\z}, "")
        a = URI(audience)
        @audience = "#{a.scheme}://#{a.host}#{a.port && a.port != a.default_port ? ":#{a.port}" : ""}"
        @now = now || -> { Time.now.to_f }
        @seen = {}
      end

      attr_reader :issuer, :audience

      def verify_link_request(token)
        p = Jack.verify_hs256(token, @secret, typ: TYP_REQUEST, issuer: @issuer, audience: @audience, now: @now.call)
        request_id = text(p["jti"])
        return_url = text(p["return"])
        raise LinkError, "malformed link request" unless request_id && return_url
        raise LinkError, "link request return URL is not the issuer" unless return_url.start_with?("#{@issuer}/")

        LinkRequest.new(request_id: request_id, return_url: return_url, scopes: p["scope"].is_a?(String) ? p["scope"].split : [])
      end

      # The signed response token for a linked user. Usually you want `link_response_url`.
      def link_response(request_token, user_id:, name: nil, email: nil)
        req = verify_link_request(request_token)
        raise LinkError, "user_id is required" unless user_id.is_a?(String) && !user_id.empty?

        iat = @now.call.to_i
        payload = { typ: TYP_RESPONSE, iss: @audience, aud: @issuer, jti: req.request_id, sub: user_id }
        payload[:name] = name if name && !name.empty?
        payload[:email] = email if email && !email.empty?
        payload[:iat] = iat
        payload[:exp] = iat + RESPONSE_TTL_SECONDS
        Jack.sign_hs256(payload, @secret)
      end

      # Where to redirect the user after linking.
      def link_response_url(request_token, user_id:, name: nil, email: nil)
        req = verify_link_request(request_token)
        token = link_response(request_token, user_id: user_id, name: name, email: email)
        u = URI(req.return_url)
        query = URI.decode_www_form(u.query || "") << ["response", token]
        u.query = URI.encode_www_form(query)
        u.to_s
      end

      # Raises LinkError on anything wrong, including a replay.
      def verify_assertion(token)
        p = Jack.verify_hs256(token, @secret, typ: TYP_ASSERTION, issuer: @issuer, audience: @audience, now: @now.call, skew: 30)
        jti = text(p["jti"])
        user_id = text(p["sub"])
        grant_id = text(p["grant_id"])
        raise LinkError, "malformed assertion" unless jti && user_id && grant_id

        t = @now.call.to_i
        @seen.delete_if { |_, exp| exp < t } if @seen.size >= 10_000
        raise LinkError, "assertion replayed" if (@seen[jti] || 0) >= t

        @seen[jti] = p["exp"].to_f + 30
        Assertion.new(user_id: user_id, scopes: p["scope"].is_a?(String) ? p["scope"].split : [], grant_id: grant_id, jti: jti)
      end

      # From a Rack env or a plain header hash. nil when absent.
      def assertion_from(headers)
        value = headers["HTTP_JACK_ASSERTION"] || headers[ASSERTION_HEADER] || headers["Jack-Assertion"]
        return nil if value.nil? || value.to_s.empty?

        verify_assertion(value.to_s)
      end

      private

      def text(value)
        value.is_a?(String) && !value.empty? ? value : nil
      end
    end

    # Rack middleware: `env["jack.user"]` is the Assertion when a valid header is present;
    # an invalid one is a 401; no header passes through.
    class Middleware
      def initialize(app, verifier)
        @app = app
        @verifier = verifier
      end

      def call(env)
        begin
          assertion = @verifier.assertion_from(env)
          env["jack.user"] = assertion if assertion
        rescue LinkError => e
          body = JSON.generate({ title: "Unauthorized", status: 401, detail: "invalid Jack assertion: #{e.message}" })
          return [401, { "content-type" => "application/problem+json" }, [body]]
        end
        @app.call(env)
      end
    end
  end
end
