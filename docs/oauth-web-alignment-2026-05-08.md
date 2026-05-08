# OAuth + inference-proxy alignment with codebase.foundation web

> **Status:** drift audit · **Date:** 2026-05-08 · **Author:** drive-by review from the web side
>
> **TL;DR:** v1 OAuth is fine. v2 has **five wrong URL paths** that won't resolve against the current web. This doc tells you what the web actually serves and what to change in v2's auth/config so the rewrite lands working on day one.

---

## What the web exposes (canonical)

All routes live under `https://codebase.foundation/...` and also work with an `/api/` prefix because nginx strips it (the same `/api`-strip convention `auth.go` already relies on for v1).

```
POST  /oauth/authorize          PKCE start (POST, not GET — JSON body)
POST  /oauth/token              code exchange + refresh (one endpoint, two grant types)
POST  /oauth/revoke             refresh-token revoke
GET   /oauth/userinfo           caller info, requires Bearer

GET   /cli/projects             list user's projects, requires Bearer
GET   /cli/projects/:id/pull    download project ZIP, requires Bearer

POST  /inference/chat           OpenAI-compat Chat Completions proxy, Bearer + 'inference' scope
POST  /inference/v1/messages    Anthropic Messages API proxy
POST  /inference/messages       alias for /inference/v1/messages
GET   /inference/models         list available models for this user
```

Source-of-truth files on the web side:
- OAuth: `web/backend/routes/oauth.js` (lines 131, 189, 311, 328 for the four handlers)
- CLI projects: `web/backend/routes/cliProjects.js` (lines 30, 80)
- Inference proxy: `web/backend/routes/inference.js` (lines 29, 182, 299)

---

## ✅ v1 (Go, `auth.go`) is aligned

`auth.go:28-32`:

```go
oauthBaseURL      = "https://codebase.foundation/api"
oauthAuthorizeURL = oauthBaseURL + "/oauth/authorize"   // → /oauth/authorize ✓
oauthTokenURL     = oauthBaseURL + "/oauth/token"       // → /oauth/token ✓
oauthRevokeURL    = oauthBaseURL + "/oauth/revoke"      // → /oauth/revoke ✓
oauthUserInfoURL  = oauthBaseURL + "/oauth/userinfo"    // → /oauth/userinfo ✓
```

All four resolve correctly via the nginx `/api`-strip. No change needed.

---

## ❌ v2 (TS) is broken — five wrong paths

`src/auth/cli.ts:9-14` defines:

```ts
authorizationUrl: `${base}/cli/auth`,        // ❌ web has no /cli/auth
tokenUrl:         `${base}/api/cli/token`,   // ❌ web has no /cli/token
refreshUrl:       `${base}/api/cli/refresh`, // ❌ web has no /cli/refresh
revokeUrl:        `${base}/api/cli/revoke`,  // ❌ web has no /cli/revoke
```

`src/agent/config.ts:19`:

```ts
const DEFAULT_PROXY_BASE = "https://codebase.foundation/api/cli";
//                                                       ^^^^^^^
// ❌ web's inference proxy is at /inference/* — /cli/* only has /cli/projects
```

If a user runs `codebase auth login` on v2 right now, the browser opens to `/cli/auth` (404) and the token exchange POSTs to `/api/cli/token` (404). Login can't even start.

Even if auth worked, every `chat()` call would 404 because `/api/cli/chat` (or whatever pi-ai builds from the proxy base) doesn't exist either.

---

## Recommended fix (CLI side, ~10 lines changed)

Update `src/auth/cli.ts:9-14`:

```ts
function defaultOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const base = (env.CODEBASE_AUTH_BASE_URL ?? DEFAULT_AUTH_BASE).replace(/\/+$/, "");
  return {
    // The browser opens this URL; the web's /login page already POSTs
    // PKCE params to /oauth/authorize. We pass the CLI's redirect_uri,
    // client_id, code_challenge, scope, state as query string so /login
    // can pre-fill them.
    authorizationUrl: `${base}/login`,

    // /oauth/token handles BOTH `grant_type=authorization_code` AND
    // `grant_type=refresh_token`. Standard OAuth 2.0 — single endpoint,
    // two grant types. v2 was treating refresh as a separate URL.
    tokenUrl:   `${base}/api/oauth/token`,
    refreshUrl: `${base}/api/oauth/token`,

    revokeUrl:  `${base}/api/oauth/revoke`,

    clientId: env.CODEBASE_CLIENT_ID ?? "codebase-cli",
    scopes:   (env.CODEBASE_SCOPES ?? "inference projects credits").split(/\s+/).filter(Boolean),
  };
}
```

Update `src/agent/config.ts:19`:

```ts
const DEFAULT_PROXY_BASE = "https://codebase.foundation/api/inference";
```

Then where `pi-ai`'s provider config builds request URLs, you need it to hit `/api/inference/v1/messages` for Anthropic-protocol models and `/api/inference/chat` for OpenAI-compat models. Inspect what `pi-ai`'s `streamSimple` does with its `baseUrl` and confirm the path append matches the web's contract.

---

## Subtleties that bit me reading the web routes

### `/oauth/authorize` is POST, not GET

The web's `/oauth/authorize` (line 131 of `routes/oauth.js`) accepts a JSON POST body with `{client_id, redirect_uri, code_challenge, code_challenge_method, scope, state, user_id}` and returns `{code, state, redirect_uri}`. It does NOT do a browser redirect.

The browser-redirect part is handled by `web/app/(app)/login/page.tsx`, which is a regular Next.js page. The CLI opens the user's browser to `/login` (with the PKCE params in the query string), the user logs into the platform on that page, and `/login/page.tsx:68` POSTs to `/oauth/authorize` on the user's behalf. The auth code comes back, and `/login/callback/page.tsx` redirects to the CLI's localhost callback.

**This means v2's `authorizationUrl` should point at `${base}/login` (the page), not `${base}/oauth/authorize` (the API endpoint).**

### Refresh shares `/oauth/token` with code exchange

The web's `/oauth/token` (line 189) handles both grants:
- `grant_type=authorization_code` → exchange code for `{access_token, refresh_token, expires_in, scope, token_type}`
- `grant_type=refresh_token` → rotate to new `{access_token, refresh_token, expires_in}`

Standard OAuth 2.0. v2 was treating these as two endpoints (`tokenUrl`, `refreshUrl`). Both should point at `/api/oauth/token`; the `flow.ts` code just sends a different `grant_type` field.

### Inference proxy expects two paths, not one

The web has separate routes for the two protocols:
- OpenAI-compat (`/inference/chat`): expects `{model, messages, ...}` in OpenAI Chat Completions shape
- Anthropic (`/inference/v1/messages`, also `/inference/messages`): expects `{model, messages, system, ...}` in Anthropic Messages shape

`pi-ai` already routes per-provider, so as long as `DEFAULT_PROXY_BASE` is `/api/inference` and provider configs append the right path (`/chat` or `/v1/messages`), it works. Worth testing one of each end-to-end before claiming the proxy mode is shipped.

### Required scope for inference

`/inference/chat` (line 32) and `/inference/v1/messages` (line 184) both check `if (!scopes.includes('inference'))` and return 403 otherwise. v2 already requests `inference projects credits` — fine. Just make sure the auth flow validates the scope is granted before claiming success.

### What the web returns on `/oauth/userinfo`

I didn't paste the body, but quick read of `routes/oauth.js:328` says it requires Bearer auth and returns `{sub, email, scopes, ...}`. Standard OIDC-ish shape. Whatever v2 does with the userinfo response should map fields explicitly — don't assume any extra fields beyond `sub` + `email`.

---

## What's NOT broken

- v1 OAuth flow works against current web (verified by reading both sides — no nginx, scope, or shape drift).
- The web ALSO supports `/cli/projects` GET routes for project listing. v2 doesn't seem to use them yet but they're there when you wire the project-pull feature.
- Scopes match: `inference projects credits`. PKCE uses S256 only on both sides. Token type is Bearer.
- `~/.codebase/credentials.json` shape v2 uses (CredentialsStore) is independent of the web — purely client-side state. Nothing to align there.

---

## Hand-off

This is a CLI-side fix. The web doesn't need to change. Five lines in `src/auth/cli.ts` plus one in `src/agent/config.ts` plus whatever per-protocol path-append lives in pi-ai's provider configs.

If you'd rather have the web add `/cli/{auth, token, refresh, revoke}` aliases — possible but more web-side work and the `/oauth/*` and `/inference/*` paths are stable across web releases. CLI-side fix is cheaper and keeps the web's contract clean.

Run `codebase auth login` against staging once these land, watch for `200` from `/oauth/token` and a populated `~/.codebase/credentials.json`, then a `codebase` chat that hits `/inference/v1/messages` (or `/chat` depending on the model) and returns a stream. That's the smoke test.

— left for whoever picks up the v2 auth wire-up.
