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
sealed board data or storing a sealed board move. `write: true` always checks GitHub. For an
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

## Sealed API relay

createRelayHandler({ directory, auth, publicOrigin, pollMs }) from service.js
mounts API v1 on the existing sign-in component. Mount the auth handler first,
then this handler, on one HTTP server; call the handler's close() at shutdown.
serveRelay({ directory, auth, port, host, publicOrigin }) is a convenience
server for these API routes. Its default address is loopback and its default
port is chosen by the operating system. It does not deploy a public service or
close the caller-owned auth component.

Per accepted RFC 0004, this service has no board engine or board key. Clients
seal records before sending them; the server validates only the outer transport
envelope and stores uninterpreted bytes. A sealed field is canonical base64url.
The client owns the encryption format and engine-version checks.

- GET /api/v1/boards returns visible board/repository identities.
- PUT /api/v1/boards/:id/state takes {sequence, sealed}. The first snapshot
  normally covers sequence 0. A later snapshot may cover only committed moves,
  cannot move behind the previous snapshot, and removes the covered move prefix.
- GET /api/v1/boards/:id/state returns
  {version: 1, state: {sequence, receivedAt, sealed}}.
- POST /api/v1/boards/:id/moves takes {sequence, sealed}. The client proposes
  the next position before sealing; the relay allocates it atomically only if
  sequence is its next position and returns {version: 1, event, result: {sequence}}.
  A loser receives SEQUENCE_REPEAT (409), reads the latest prefix, reseals with
  a fresh nonce bound to the next position, and retries. Gaps are refused too.
  An event is {event_id, event_at, kind, sealed}. Requests use the same sealed append
  through POST /api/v1/boards/:id/requests. The public transport kind is move or
  request, letting clients select their associated-data binding; content stays sealed.
- GET /api/v1/boards/:id/events?after=N returns sealed events in sequence.
  Accept: text/event-stream follows the same records; Last-Event-ID resumes.
  A cursor older than the latest snapshot gets SNAPSHOT_REQUIRED (409), naming
  the need to fetch state and resume after its coverage cursor.
- DELETE /api/v1/boards/:id removes that board's database and SQLite sidecars.
  GitHub link/credential lifecycle remains owned by the sign-in/linking layer.

All responses and refusals retain API version 1. Moves use the shared 100,000
byte JSON-body limit. Snapshots allow a bounded 14,000,000 byte JSON body and
10,000,000 decoded bytes. One private SQLite journal per board stores only its
identity, format, head cursor, receive times and sealed payloads. Compaction
keeps the head cursor, so the next move never reuses an earlier sequence.

Bearer credentials work for agents and CLI calls. Browser session-cookie reads
require a configured trusted publicOrigin; cookie writes require that exact
Origin. Duplicate cookies are refused, and neither credentials nor board keys
are accepted through query parameters. Writes recheck current repository access
after body reading; live streams recheck the credential between polls. A board
credential cannot reach another board. Code previews are unavailable on the
relay: source files stay local.

test/relay-journal.test.js races real processes and checks restart/compaction.
test/relay-sealed.test.js seals actual CLI records on two test clients, uses an
actual loopback sign-in stand-in, and checks order, snapshots, live delivery,
revocation, deletion and absence of known plaintext/client keys in database
bytes. Test encryption is client-only; it is not a public client pairing API.
The relay/ service stays outside the npm package.
