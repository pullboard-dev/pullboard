# Relay authentication

## Deploy the service

The container definition is `relay/Dockerfile`; its build context must be the
repository root because the service imports `src/` modules. The service listens on
Railway's `PORT` at `0.0.0.0`, and `GET /health` returns `200` after startup.
It stores the auth database at `/data/auth.sqlite`, board journals under
`/data/boards/`, and private backups under `/data/backups/`. Attach one Railway
volume at `/data`; do not scale this SQLite service to multiple replicas.
The entry point prepares that root-mounted directory, then runs the server as
the image's unprivileged `node` user. For Railway volumes, configure
`RAILWAY_RUN_UID=0` so startup can set the directory ownership before dropping
privileges.

For #113, the person completes these account steps:

1. Create the Pullboard GitHub App. Set its callback to
   `https://app.pullboard.dev/auth/github/callback`, grant repository Metadata
   read-only permission, and enable device flow. Create its client id, client
   secret and RSA private key.
2. Create the Railway project and service for this repository. In service
   settings, keep the root directory `/` so the Docker build can copy `src/`,
   choose `relay/Dockerfile`, set the start command to
   `node relay/server.mjs`, and set the health check path to `/health`. Attach
   one persistent volume at `/data`; the auth database, board journals and
   backups live at `/data/auth.sqlite`, `/data/boards/` and `/data/backups/`.
   Set `RAILWAY_RUN_UID=0` so startup can prepare the root-mounted volume before
   dropping to the image's `node` user. Set
   `PULLBOARD_PUBLIC_ORIGIN=https://app.pullboard.dev`,
   `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and
   `GITHUB_APP_PRIVATE_KEY` in Railway's service variables. Keep the secret
   values in Railway, never in git.
3. Give the service the `app.pullboard.dev` domain and point DNS at the target
   Railway provides. Wait for the `/health` check to pass before directing
   clients to it.

The smoke command is `node relay/smoke.mjs <address>`. It uses the current
repository as a disposable smoke board: it links, creates one uniquely named
item, reads and unseals its mirrored move, then unlinks. Use a throwaway
repository and relay when running it against a live deployment; unlink deletes
the remote board. Tests run the same script against a private loopback relay.

Railway's current Infrastructure as Code uses the `railway/iac` package. This
dependency-free project keeps the deployment settings in the service checklist
above instead of adding a Railway SDK dependency. Recheck Railway's current
configuration format before creating a new service.

The auth and API modules implement the GitHub App sign-in and authorization
boundary for the opt-in relay. `server.mjs` is the public container entry point;
the library handlers remain embeddable for tests and other local transports.

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
  Snapshot replacement requires a person's signed-in session, not an agent token.
- GET /api/v1/boards/:id/state returns
  {version: 1, state: {sequence, receivedAt, sender, sealed}}.
- POST /api/v1/boards/:id/moves takes {sequence, sealed}. The client proposes
  the next position before sealing; the relay allocates it atomically only if
  sequence is its next position and returns {version: 1, event, result: {sequence}}.
  A loser receives SEQUENCE_REPEAT (409), reads the latest prefix, reseals with
  a fresh nonce bound to the next position, and retries. Gaps are refused too.
  An event is {event_id, event_at, kind, sender, sealed}. Requests use the same sealed append
  through POST /api/v1/boards/:id/requests. The public transport kind is move or
  request, letting clients select their associated-data binding; content stays sealed.
- GET /api/v1/boards/:id/events?after=N returns sealed events in sequence.
  Accept: text/event-stream follows the same records; Last-Event-ID resumes.
  A cursor older than the latest snapshot gets SNAPSHOT_REQUIRED (409), naming
  the need to fetch state and resume after its coverage cursor.
- DELETE /api/v1/boards/:id removes that board's database and SQLite sidecars.
  It requires a person's signed-in session and current write access.
  It removes the link and its board-scoped credentials too; other boards and person sessions remain valid.

All responses and refusals retain API version 1. Moves use the shared 100,000
byte JSON-body limit. Snapshots allow a bounded 14,000,000 byte JSON body and
10,000,000 decoded bytes. One private SQLite journal per board stores only its
identity, format, head cursor, receive times, public sender identities and sealed payloads. Compaction
keeps the head cursor, so the next move never reuses an earlier sequence.

Bearer credentials work for agents and CLI calls. Browser session-cookie reads
require a configured trusted publicOrigin; cookie writes require that exact
Origin. Duplicate cookies are refused, and neither credentials nor board keys
are accepted through query parameters. Writes recheck current repository access
after body reading; live streams recheck the credential between polls. A board
credential cannot reach another board. Code previews are unavailable on the
relay: source files stay local.

Sender is derived only from the freshly authenticated credential: a board token
gives {kind: 'agent', userId, agent}; a person's session gives {kind: 'person', userId}.
It contains no credential, token id, login or board key. This attribution is saved
with every event and snapshot and returned unchanged through reads and streams.
Each receiving client compares the unsealed operation's acting agent with
sender.agent before applying moves or requests. Agent senders cannot answer as
the person, approve or decline spec rows, or create the person's requests.
Missing attribution and mismatched actors are refused. A refusal advances the
replica's sequence atomically with a durable receipt and a `relay_refused` log
entry naming the authenticated sender and attempted actor; it changes no item,
shout or verdict. The opaque relay cannot do that comparison itself. Receivers
also require a person sender before restoring a snapshot. This replay behavior
uses engine version 3; the event-log format remains version 1.
Snapshot replacement and deletion refuse agent tokens
with HUMAN_REQUIRED (403), before reading their bodies or changing storage.
Journal format 2 requires attribution; the unshipped format-1 prototype is refused
rather than inventing an identity for historical records.

test/relay-journal.test.js races real processes and checks restart/compaction.
test/relay-sealed.test.js seals actual CLI records on two test clients, uses an
actual loopback sign-in stand-in, and checks order, snapshots, live delivery,
revocation, deletion and absence of known plaintext/client keys in database
bytes. Test encryption is client-only; it is not a public client pairing API.
The relay/ service stays outside the npm package.


## Retention and private backups

`createRelayHandler` and `serveRelay` accept `now` (nonnegative integer milliseconds),
`backupsDirectory` (default: the journal directory plus `-backups`), and
`maintenanceMs` (default: 60000; zero delegates scheduling to the caller).
The service checks expiry on each authorized board contact and every maintenance tick.
A new sealed move or request resets inactivity; merely reading or replacing a snapshot does not.
The activity timestamp survives compaction and restart. Links without a move use their original
link time; older unshipped auth databases receive a full grace period during migration.

At sixty idle days, authorized `GET state` and `PUT state` responses include
`state.warning`; event polls include `warning`, live streams emit a named `warning` event,
and the board listing includes `warnings`. Streams send a warning once when it changes,
with normal authorization on every poll. A warning contains only public board
identity, `BOARD_INACTIVE`, idle days, `daysLeft` (remaining days rounded up), the ninety-day deletion deadline and next steps.
Linked CLI and view consumers must display this on their next contact; this backend has no
notification delivery and never reads a seal. At ninety idle days, a contact or maintenance
sweep removes the board's journal, sidecars, backups, link and scoped credentials.
Explicit person-authorized unlink does the same immediately, including backups. The complete
local board is unaffected.

Every service journal operation and retention decision takes the same cross-process lock
in the auth database. All workers for a storage directory must share that auth database.
Unlink first commits access revocation and a durable cleanup intent; cleanup prevents relinking
until all managed files are gone. Maintenance retries an unfinished purge after an I/O failure
or restart. A pending purge is never exposed as an active linked board.

The backup job uses SQLite `VACUUM INTO` to copy a consistent compact database, including
committed WAL contents, into a private temporary file and atomically publishes it.
It preserves opaque snapshots, the uncovered tail and public ordering metadata; it needs no key.
Backups run once per UTC day while the service is running. A restart can produce an extra
backup that day. Only managed backups and unfinished temporary outputs older than fourteen
days are pruned; unrelated operator files remain untouched. Directories are mode 700 and
files mode 600; managed symlinks are refused.

Trusted operators can call `handler.maintenance()` / `relay.maintenance()` or `.backup()`
for external scheduling. `.maintenanceStatus()` reports a stable error code after a failed
scheduled tick; it clears after a successful retry. It contains no native error, credential,
key or storage path. Monitor that status when running a public host: background failures do
not claim success. Shutdown clears the timer; authentication shutdown remains caller-owned.

`test/relay-retention.test.js` uses an injected lifecycle clock, real SQLite, real loopback
GitHub sign-in and HTTP. It checks exact sixty/ninety/fourteen-day boundaries, contact warnings,
compaction/restart, scoped revocation, crash-intent recovery, consistent private backups,
symlink refusal and retryable maintenance failures. Sign-in's separate clock retains normal
credential validity during these simulated long lifecycle intervals.
