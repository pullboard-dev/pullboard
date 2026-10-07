# Relay authentication

This module implements the GitHub App sign-in and authorization boundary for the
opt-in relay. It does not start a public server or change any repository.

Create the GitHub provider with `createGitHubClient` from `github.js`. Configuration
names are `clientId`, `clientSecret`, `privateKey` (RSA PEM), and `callbackURL`.
The callback ends in `/auth/github/callback`. The default GitHub URLs are used in
production; HTTPS overrides and loopback HTTP stand-ins are supported. Register
with `githubAppManifest(callbackURL)` and enable the App's device flow in GitHub's
settings. The manifest requests only repository Metadata read permission.

Create `createRelayAuth({ database, github })` from `auth.js` with a private SQLite
file, separate from board databases. Create `createAuthHandler({ auth,
publicOrigin })` from `auth-http.js` with the trusted externally visible HTTPS
origin. Mount it before the API handler: it returns `false` for unrelated routes.
The reverse proxy must preserve request `Origin` and cookies; the handler never
trusts a forwarded host to decide cookie-write authorization.

Browser sign-in begins at `GET /auth/github/start`. The callback checks both a
one-use state and an HttpOnly browser-binding cookie, exchanges with S256 PKCE,
and redirects to `/` with an HttpOnly, SameSite=Lax session cookie (Secure on
HTTPS). Codes and session tokens are not put in the final browser URL.

A CLI posts `{}` to `/auth/device/start`, directs its person to the returned
`verificationURL` with `userCode`, then posts `{ticket}` to `/auth/device/poll`.
Pending responses carry `retryAfter` seconds. Polling is throttled and honors
GitHub's slow-down response. Successful polling returns a relay session once.
Response bodies carrying credentials have `Cache-Control: no-store`.

The handler also offers `/auth/session`, `/auth/boards`, `/auth/boards/link`,
`/auth/tokens`, and `/auth/tokens/revoke`. JSON responses have `version: 1`;
refusals have `error: {code, message, next}`. A bearer credential works for CLI
requests. Cookie-authorized writes must carry the exact configured Origin.

The API layer must call `auth.authenticate(token, {board, write})` before serving
board data or applying a board move. `write: true` always checks GitHub. For an
agent credential, use the returned `agent`, never an agent supplied in a request
body. A credential for one board is refused on another before any board lookup.
Use `auth.boardsFor(token)` for visibility, and `auth.linkBoard(token, board,
repository)` to link only a repository the person can read. `auth.issueToken`
requires a human session and returns a random, expiring credential scoped to one
board/agent. `await auth.revoke(token, id)` revokes one owned credential. Session revocation
is independent of a board; board-token revocation requires current write access.

GitHub user credentials are used only to obtain the account's immutable id and
login at sign-in, then discarded. Permission checks use an App-signed JWT to
obtain a repository-scoped installation token asking only for Metadata read.
These App tokens stay in RAM. Private repositories require an App installation
and a permission response for the same immutable user id. Public boards are hidden unless the account has triage, write, maintain, or
admin permission. Public metadata alone grants no board access; confirming a
role needs an App installation. Private collaborators with read permission can
see their boards. Board actions and minting or revoking board tokens require
write, maintain, or admin permission, checked again on every such operation. Repository ids are pinned so a
replacement repository cannot inherit a board link.

SQLite stores account/repository identities and SHA-256 hashes of relay-issued
credentials, never their plaintext. Sessions expire in seven days by default;
board tokens in one day (configurable up to thirty days). Revocation persists
across restart. Sessions survive restart without GitHub user credentials; pending
web/device flows are held only in RAM and must be restarted after a restart.
Read permission checks are cached for less than ten minutes. Writes check again
every time and a denied write invalidates the read cache. Provider failures refuse
the current operation. Revocation or expiry during an awaited check also refuses
it. Call `auth.close()` when the relay shuts down.

`test/relay-github.test.js`, `test/relay.test.js`, and `test/relay-http.test.js` use
real loopback HTTP, generated RSA keys, and private SQLite files. No live GitHub
credentials, repositories, or board databases are needed.
