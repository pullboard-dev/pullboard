# Identity, storage and trust in the relay

The relay is the hosted service that puts your board on your phone and on your other machines. It stores sealed board records and decides who may fetch them. Reading them takes the board key, and only your paired devices hold it.

This page explains who is who on the relay, every table it stores, what it can read, how pairing moves the board key, and where the protection ends. It is written from the code, and each claim names the file that makes it true. The promises behind it are the H rows in `SPEC.md`, chiefly H5 and H7.

## The parts

```
                     GitHub (people's identity)
                     a GitHub App with Metadata read-only
                               ^
                               | sign-in; a role check on every write
                               |
  +-------------+  ps_ cookie  +-------------------------------------+
  | Phone       |<------------>| Relay                               |
  | browser     | sealed       |  /data/auth.sqlite                  |
  | device key  | records,     |  /data/boards/devices.sqlite        |
  | (IndexedDB) | wrapped keys,|  /data/boards/<board>.journal.sqlite|
  | board keys  | approvals    |  /data/backups/  (14 days)          |
  | (localStorage)             +-------------------------------------+
  +-------------+                    ^ pm_ (machine)    ^ pa_ (one per agent)
        ^                            |                  |
        | the person's tap     +-----+------------------+------+
        |                      | Machine                       |
  +-----+----+   terminal      |  board key file (mode 600)    |
  |  Person  |---------------->|  relay.json: pm_, pa_ cache   |
  +----------+                 |  device roster (public keys)  |
                               |   agent   agent   agent  ...  |
                               +-------------------------------+
```

- **Person**: a human with a GitHub account.
- **Phone**: a browser signed in as the person and paired with a machine.
- **Machine**: a computer with a linked repository. Its CLI holds the board key.
- **Agent**: a worktree on a machine, registered on the board as a seat.
- **Relay**: one Node service (`relay/server.mjs`) that orders sealed records and checks who may fetch them.

## Who is who

### People sign in with GitHub

The relay signs people in through a GitHub App whose only permission is repository Metadata, read-only (`githubAppManifest` in `apps/relay/src/shell/github.js`). It refuses a GitHub token that carries OAuth App scopes (`tokenResult` in `apps/relay/src/shell/github.js`). The GitHub user token is used once to learn the account's numeric id and login; only that id and login are stored (`signedIn` in `apps/relay/src/shell/auth.js`).

The relay asks GitHub for the person's repository role on every write, and caches read checks for under ten minutes (`access` and `ACCESS_WINDOW_MS` in `apps/relay/src/shell/auth.js`). It pins the repository's numeric id when a board is linked, so a different repository that takes the same name inherits nothing.

Browser sign-in uses one-use state, PKCE and a binding cookie (`beginWeb` and `finishWeb` in `apps/relay/src/shell/auth.js`). The session cookie, `pb_session`, is HttpOnly and SameSite=Lax, and Secure over HTTPS (`apps/relay/src/shell/auth-http.js`). The CLI signs in with GitHub's device flow. From an SSH shell, the relay first shows a page naming the board folder and the machine's host name, and the board links only after the person confirms it there (`beginDevice` and `confirmDevice` in `apps/relay/src/shell/auth.js`, `relayOn` in `packages/link/src/shell/relay.js`).

### Machines, agents, grants and devices hold Pullboard credentials

On top of the GitHub identity, the relay issues its own credentials. Each one is a prefix and 32 random bytes (`random` in `apps/relay/src/shell/auth.js`). The relay keeps only a SHA-256 hash of each, and checks expiry and revocation on every use (`issue` and `credential` in `apps/relay/src/shell/auth.js`).

| Credential | Who holds it | What it can do | Lifetime |
| --- | --- | --- | --- |
| `ps_` person session | The phone, in the `pb_session` cookie. The CLI holds one in memory while it links a board, and clears any saved copy (`loadLink` in `packages/link/src/shell/relay.js`). | Everything the person's GitHub role allows: link boards, issue `pm_` and `pa_`, approve phone requests, make person-only moves. | 7 days |
| `pm_` machine credential | One per board per machine, in `<git common dir>/pullboard/relay.json`, mode 600 (`linkFile` in `packages/link/src/shell/relay.js`). | Upload snapshots, register agent seats, publish phone approvals, upload key wraps for paired devices, issue `pa_` tokens and spend a `pg_` grant. It cannot make person-only moves. | 30 days |
| `pa_` agent token | One per agent seat, cached in `relay.json` or supplied as `PULLBOARD_RELAY_TOKEN` (`actorTransport` in `packages/link/src/shell/relay.js`). | Moves on one board as one named agent. | 1 day by default, 30 at most |
| `pg_` action grant | Issued to the phone after the person taps approve, then sealed to the machine's in-memory reply key (`nativePhoneAction` in `packages/link/src/shell/relay-phone.js`). | One exact native action, such as revoking a device or a token or deleting the relay copy, bound to its approval context. | 120 seconds at most, one use |
| `pd_` sign-in ticket | The CLI, during a device sign-in. The relay keeps its hash in memory. | Poll for or cancel one pending sign-in. | GitHub's device-code lifetime |
| `pc_` confirmation ticket | The person's browser, in the fragment of the confirmation link. The relay keeps its hash in memory. | Confirm or decline one board link. | The sign-in, plus 10 minutes after GitHub confirms |

A person session can revoke any of its account's credentials through `POST /auth/tokens/revoke`; a machine or agent credential can revoke only itself (`revoke` in `apps/relay/src/shell/auth.js`). Deleting a board's relay copy, or letting it expire, deletes every credential bound to it (`forgetBoard` in `apps/relay/src/shell/auth.js`). The relay keeps the hashes of the ones still live until they would have expired, so a machine that uses one later hears that the relay copy was deleted and keeps working locally.

The relay labels each record with a sender taken from the credential that sent it, and ignores any sender named in the request (`sender` in `apps/relay/src/shell/service.js`). Every client refuses a record its sender may not make: a machine credential may send snapshots, seat registrations, the coordinator seat and phone-approved moves, and an agent may act only as itself (`relaySenderProblem` in `packages/state/src/core/relay-sender-policy.js`). On the machine, a terminal that carries an agent marker or an SSH marker cannot take person actions, and the person uses the view or the phone instead (`requirePersonChannel` in `packages/person/src/shell/person.js`).

## What the relay stores

Everything durable lives on one volume at `/data`: `auth.sqlite`, then `devices.sqlite` and one journal per board under `boards/`, then `backups/` (`relay/server.mjs`). The relay keeps its files at mode 600 in directories at mode 700.

| Table | File | What it holds | Kept until |
| --- | --- | --- | --- |
| `relay_users` | `auth.sqlite` | Each signed-in GitHub account: its numeric id and login. | No deletion path. |
| `relay_boards` | `auth.sqlite` | Each linked board: board id, repository `owner/name`, repository id, link time. | The board is deleted, or 90 days pass without activity. |
| `relay_board_off` | `auth.sqlite` | Per board turned off by a relink: the board id, its repository id, the board that replaced it, the account that relinked and the time. It is the off receipt that keeps one active link per repository. | No deletion path. |
| `relay_cleanup` | `auth.sqlite` | Board ids whose deletion is in progress. | The deletion finishes. |
| `relay_deleted_credentials` | `auth.sqlite` | Per credential of a deleted board: its SHA-256 hash, the board id, its expiry. | The credential's own expiry. |
| `relay_credentials` | `auth.sqlite` | Per credential: id, SHA-256 hash, kind, account, board, agent or machine name, created, expiry, revoked flag. | The board is deleted or expires. Session rows stay, expired or revoked. |
| `relay_seats` | `auth.sqlite` | Per board seat: board, agent name, how the seat was made (machine, registered or root), its creator, the registering move's sequence and digest, and its first credential's id, creation and expiry. | The board is unlinked or deleted. |
| `relay_coordinator_events` | `auth.sqlite` | Each coordinator token the person issued: board, reason (bootstrap, reissue or reset), session id, the revoked token ids, the issued id and the time. | The board is unlinked or deleted. |
| `relay_action_grants` | `auth.sqlite` | Per approved action: grant hash, request id, account, the full approval context in clear, expiry, used flag. For a passkey grant on a person request, the context is the board, the request id and the SHA-256 of the request's exact intent. | No deletion path. |
| `relay_passkeys` | `auth.sqlite` | Per passkey a person registered: its credential id, account, public key and algorithm, signature counter and creation time. The private key stays in the person's authenticator. | No deletion path. |
| `relay_person_authority` | `auth.sqlite` | One row: the relay's Ed25519 key pair that signs the passkey stamp on person requests. Only the public key leaves the relay. | No deletion path. |
| `device` | `boards/devices.sqlite` | Per paired phone: account, device id, revoked flag. | No deletion path; a revoked row stays so its id is never reused. |
| `device_session` | `boards/devices.sqlite` | Per signed-in browser session: account, session id, the paired device it belongs to, and its expiry, so a revoked device's sessions are refused. | Its expiry; expired rows are deleted whenever a session is recorded. |
| `wrapped_key` | `boards/devices.sqlite` | Per phone and board: the board key, encrypted to that phone's public key, and the engine version. | The device is revoked or the board deleted. A board that expires idle leaves its wraps behind. |
| `enrollment` | `boards/devices.sqlite` | A pending phone pairing: account, locator, expiry, and the phone's signed public enrollment (device id, public key, label, created time, MAC). | Deleted once the machine accepts it, or after it expires at 10 minutes. |
| `person_enrollment` | `boards/devices.sqlite` | Per new-device challenge: account, nonce, device, expiry, the person-signed challenge payload, whether it was used, and the opaque board-key wrap once a trusted machine released it. The relay cannot open the wrap. | No deletion path yet; a used or expired challenge stays as a row. |
| `phone_approval` | `boards/devices.sqlite` | Per request: id, account, publishing board, board, device, action, machine, expiry, the context in clear, the sealed intent, its state and the phone's sealed reply. | No deletion path; expired requests are marked expired. |
| `excluded_inventory` | `boards/devices.sqlite` | Per account and machine: the machine label, excluded-board count, engine version and encrypted repository-name list. The relay cannot open the list. | The machine replaces its publication, or publishes an empty list when no boards remain excluded. No time-based deletion path. |
| `excluded_inventory_wrap` | `boards/devices.sqlite` | Per account, machine and enrolled device: the excluded-list key encrypted to that device. Reads recheck the device is active. | The machine replaces or clears its publication. Revocation blocks reads but does not delete this row. |
| `journal_meta` | `boards/<board>.journal.sqlite` | The board id and the journal format. | The board is deleted or expires. |
| `journal_head` | `boards/<board>.journal.sqlite` | The latest sequence number and the time of the last move or request. | The board is deleted or expires. |
| `journal_record` | `boards/<board>.journal.sqlite` | Per record: sequence, arrival time, kind (move or request), sealed payload, sender kind, sender account, agent or machine name, and, for a person request a passkey confirmed, its stamp: board, request id, intent digest, passkey credential id, time and the relay's signature. | The next snapshot covers it. |
| `journal_registration` | `boards/<board>.journal.sqlite` | Per seat a move registered: the target seat, its creator, the move's sequence and the sealed move's digest, so a replica checks who created a seat. | The board is deleted or expires. |
| `journal_snapshot` | `boards/<board>.journal.sqlite` | One sealed snapshot: the sequence it covers, arrival time, sealed payload, sender. | The next snapshot replaces it. |
| `board_link_delivery` | `boards/<board>.journal.sqlite` | Per cross-board envelope a linked board receives: the source board, a correlation id, the link id and generation, its position, digest, the sealed envelope and its receipt. The relay cannot open the envelope. | The board is deleted or expires; it counts toward the board storage quota. |
| `page_meta` | `boards/<board>.journal.sqlite` | The board id and the history page format. | The board is deleted or expires. |
| `page_object` | `boards/<board>.journal.sqlite` | Per sealed history page: its id, the sequence it reaches, the sealed payload, its child page ids and its creation time. | Collection deletes a page that no current root, pin or staged upload reaches. |
| `page_upload` | `boards/<board>.journal.sqlite` | Per staged page upload: id, the sender's account id, kind and agent or machine name, the sequence it covers and its expiry. | It is published, or it expires. |
| `page_upload_object` | `boards/<board>.journal.sqlite` | Which sealed pages a staged upload holds: the upload id and the page id. | Its upload is deleted. |
| `page_pin` | `boards/<board>.journal.sqlite` | Per read in flight: id, the reader's account id, kind and agent or machine name, the root page it reads and its expiry. | It expires. |
| `journal_upload_status` | `boards/<board>.journal.sqlite` | One opaque, board-key-sealed notice of a refused snapshot upload. The relay cannot read its repository name, measured size or reported limit. | The next accepted snapshot clears it atomically, or the board is deleted or expires. A later notice is ignored once a snapshot exists. |
| `storage_warning` | `boards/storage-quota.sqlite` | Per board refused for account storage: the board, the account id and login in clear, the bytes used and allowed, and the bytes the refused write needed. | The board's next stored checkpoint, or the board is unlinked. |

Once a day the relay copies each journal into `backups/` and keeps each copy for 14 days; deleting a board deletes its copies at once (`apps/relay/src/shell/retention.js`). After 60 days without activity the relay warns on the next contact, and at 90 days it deletes the board.

Some state lives only in memory and ends with the process: machine-to-machine pairing packages, pending sign-ins with their GitHub device codes and board confirmations, GitHub App installation tokens, and the read-permission cache (`apps/relay/src/core/pairing-store.js`, `apps/relay/src/shell/auth.js`, `apps/relay/src/shell/github.js`).

## What the relay can read

The relay sees who and when. It knows every GitHub account that signs in, every linked repository name, and for each record its sequence, arrival time, size, kind and sender: the person's account, a machine's id (`machine-` and a random UUID, from `packages/link/src/shell/relay-machine.js`) or an agent's seat name. From those it can tell how active each board is and which agents work on it. It knows which phones are paired to which account and which boards each phone has keys for, along with each phone's public key and its label, `Phone browser`. Like any web service, it receives the network address of every request.

It also reads phone approvals. A machine publishes each approval with its context in clear: account, boards, device, action, target (a repository name, device id or token id), machine id, the exact command text and the expiry (`approvalContext` in `packages/link/src/core/relay-approval.js`). The relay keeps that context in `phone_approval` and again in `relay_action_grants`. When a board is linked from an SSH shell, the relay holds the machine's host name and the board's folder name in memory to show on the confirmation page.

## What only your devices can read

Board contents travel sealed: items, criteria, shouts, verdicts and spec rows. The machine seals each snapshot, move and request with AES-256-GCM under the board key, and the associated data binds the board id, the sequence and the kind (`seal` in `packages/kernel/src/core/seal.js`). The relay checks only that a payload is canonical base64url, then stores the bytes unparsed (`sealed` in `apps/relay/src/shell/service.js`, `apps/relay/src/shell/journal.js`). Your repository's code stays on your machine; only board records go to the relay.

The relay never receives a board key in a form it can use. A phone gets it wrapped to the phone's own ECDH key, and another machine gets it sealed under a secret that exists only in the printed pairing code. The pairing secrets themselves stay off the relay: the phone's secret rides in the link's fragment, which the browser never sends (`apps/relay/src/shell/browser-devices.js`).

## How pairing moves the board key

**Linking a board.** `pullboard relay on` makes a 256-bit board key on the machine and keeps it in `~/.pullboard/relay-keys/<board>.key`, mode 600 (`generateBoardKey` in `packages/kernel/src/core/seal.js`, `storeBoardKey` in `packages/keys/src/shell/relay-key.js`). The person signs in and the relay records the link. The machine receives its `pm_` and uploads the board's first sealed snapshot.

**Pairing a phone.** The machine makes a one-time locator and secret, keeps the secret in its private `relay-machine/state.json`, and shows both in a QR code (`beginDeviceEnrollment` in `packages/link/src/shell/relay-machine.js`). The phone makes an ECDH P-256 key pair whose private half cannot be exported, and keeps it in IndexedDB (`createDeviceKeys` in `packages/keys/src/core/relay-device-keys.js`). It signs its public key with an HMAC derived from the secret and posts it through the relay (`signDeviceEnrollment`). The machine checks that MAC before it trusts the key, so the relay cannot slip in a key of its own (`acceptDeviceEnrollment` in `packages/link/src/shell/relay-machine.js`). The machine then wraps the board key to the public key it recorded itself (`wrapForRecordedDevice`) and uploads the wrap with its `pm_`. It wraps again on every sync (`deliverDeviceWraps` in `packages/link/src/shell/relay.js`). The phone unwraps it with its private key and keeps the board key in `localStorage` (`deviceBoardKeys` in `apps/relay/src/shell/browser-devices.js`, used by `apps/relay/src/shell/browser-client.js`).

**Pairing another machine.** `pullboard relay pair` prints a code made of the board id, a locator and a 256-bit secret. The machine seals the board key and a snapshot under that secret and posts the package (`sealPairingBundle` in `packages/person/src/shell/pairing.js`). The relay holds it in memory for ten minutes and hands it out once, to a caller who can read the board (`apps/relay/src/core/pairing-store.js`, `apps/relay/src/core/pairing-http.js`).

**Phone approvals.** For a native action that needs the person, such as revoking a device, the machine publishes the context and a sealed intent, authenticated with an HMAC under the board key so the relay cannot invent one (`phoneProposal` in `packages/link/src/shell/relay-phone.js`). The intent also carries the machine's host name and the board's name, sealed, so the phone can show them and the relay cannot read or change them (`proposalNames` in `packages/link/src/shell/relay-phone.js`). The phone shows the request. On a tap the relay issues a `pg_`; the phone seals it to the machine's in-memory reply key, and the machine spends it once (`issueActionGrant` and `consumeActionGrant` in `apps/relay/src/shell/auth.js`).

**One order for every move.** The relay gives each record the next sequence number atomically and refuses repeats and gaps (`insert` in `apps/relay/src/shell/journal.js`). Every client applies records in that order with the CLI's own rules.

## Machine-local relay canary

A relay canary is an opt-in monitor on an ordinary client machine. It checks the authenticated board move path by signing in as its configured ordinary seat, sending a nonce-bearing shout through the normal ordered move, pulling the fresh event and unsealing the exact returned move. A successful `/health` response alone is not a round trip. The canary does not alter the relay API or add a server-side table.

`pullboard relay canary on [--timeout <milliseconds>]` stores `relay.canary` in this machine's settings: an enabled flag, an absolute checkout path, the registered non-coordinator `agentId`, and an optional deadline (5 seconds by default; 100–25,000 ms when set). The credentials stay in the existing local link and key stores. The setting binds the run to that checkout and seat. To monitor one board from two machines, link that board normally on each and configure one ordinary seat per machine after the feature lands. `pullboard relay canary off` disables an existing setting (or leaves an absent setting unset); `status` reads local observations without a network request; `run` executes one probe; `watch` runs an immediate probe and then checks once per minute until stopped with Ctrl-C. The watch is separate from the ordinary ten-minute health scan.

Each machine keeps its observations and minute schedule in a private SQLite file at `<git common dir>/pullboard/relay-health.sqlite`. A fresh result is healthy or degraded; after two minutes without a recent sample, status is unknown. Two consecutive failed probes create an alert. A latency alert requires a complete ten-minute window and at least ten successful samples, with p95 above two seconds. The local Needs-you entry reports the actual queued move count from that machine's outbox. It is local telemetry: it is not included in sealed board presentations or sent to other devices as health state.

On an alert or recovery, the configured seat sends notices through ordinary native ordered shouts to the coordinator and person. If the relay or native notification route is unavailable, the notice remains pending locally and is retried; a later delivery is labeled delayed. A local alert or successful native write is not a phone acknowledgement. Closed-phone push delivery is a separate notification path.

For an operational drill, interrupt the authenticated sign-in, move-upload or fresh-event-read route used by the client, then restore that route and run a complete probe. Do not substitute an HTTP health endpoint for those client routes. The expected recovery is a later successful sealed round trip; if its notice could not travel during the outage, it remains delayed. Configuration alone does not mean either production host has been linked or has completed a successful probe.

## Redeploys

A new relay process on the same `/data` volume keeps every account, link, credential hash, paired phone, wrapped key, approval and journal; `test/relay-deploy.test.js` restarts the relay and proves that no one re-pairs. A restart ends what lives only in memory, so a half-finished sign-in or pairing starts again. The service runs as a single replica, since one writer owns these SQLite files (`relay/README.md`).

A phone pairs again when its browser storage is cleared, when it signs in as another account, or when the device is revoked. The hosted page can be installed to the Home Screen and asks the browser to keep its storage, since Safari on iPhone can clear a site's storage after seven days without a visit (`apps/relay/src/core/browser-install.js`).

## Local main-facts cache

Immutable facts derived from accepted main are stored in the private Git-common-directory cache. The cache retains current main and at most eight recent commit groups by default; older groups are evicted in the same transaction as insertion, and SQLite reclaims the freed space. The default database cap is 512 MiB. `PULLBOARD_MAIN_FACTS_MAX_BYTES` sets the local byte cap (minimum 16384); `PULLBOARD_MAIN_FACTS_RECENT_COMMITS` sets the number of recent groups (1–1000). Invalid values use the defaults. Oversized legacy cache contents are discarded and rebuilt. If the cache is unavailable, busy, unsafe or cannot write, facts are derived without the cache; source and board authority are unchanged. Evictions emit one diagnostic line.

## Honest limits

The relay sees metadata. The section on what it can read lists all of it: accounts, repository names, record sizes and timing, seat names, machine ids, which phones hold which boards, and network addresses.

A compromised relay could serve a compromised page. Every script the phone runs comes from the relay (`apps/relay/src/shell/browser-page.js`), and nothing outside the relay pins or signs that code. Such a page could read the board keys the phone keeps in `localStorage`.

Approval context is in clear. The relay reads each requested action, its target, the machine id and the command text, and keeps them with no deletion path.

The sender of a record is the relay's word. The seal binds the board, the sequence and the kind, and leaves the sender outside it (`packages/kernel/src/core/seal.js`), so a compromised relay could relabel a validly sealed move. The device key only agrees keys: it cannot sign, and no passcode or Face ID guards it. A phone approval proves a tap in a browser that holds the session cookie.

Agents on a machine share what is on disk. Every agent runs as the same operating-system user, so any of them can read the board key file and `relay.json`. The `pm_` there can issue a `pa_` for any seat name the relay is given (`issueToken` in `apps/relay/src/shell/auth.js`), and only the client checks that the name is a registered seat (`actorTransport` in `packages/link/src/shell/relay.js`).

Revoking a phone stops new wraps and deletes its stored ones, and the board keys it already received stay usable to whoever holds them. Board key rotation is a separate step.

Some rows have no deletion path: `relay_users`, `relay_action_grants`, `relay_passkeys`, `relay_person_authority`, `phone_approval`, `person_enrollment` and the `device` tombstones. A board that expires for inactivity leaves its `wrapped_key` rows behind.

RFC 0004 describes keeping the board key in the operating system's keychain. The code keeps it in a mode-600 file and moves any older keychain copy into that file (`packages/keys/src/shell/relay-key.js`).

## Pipeline hops: Build → Gate → Review → Land

Every item travels the same hops from claim to merged. Each row below names the invariant the hop must keep, the harness that proves it, and the live receipt that shows it in production. A harness runs real git, a real SQLite board and real child processes in its own temp folders, never in a checkout, and its after-hook fails it if any process it started is still alive. NONE means no harness exists yet: that is real debt, not a pass. A row is current only when its harness passes and the live receipt agrees.

`node bin/hop-matrix.js --live` runs every harness under `test/harnesses/pipeline/` one after another and prints this matrix with PASS, FAIL or NONE and each timing; `--json` prints the same rows for a view screen. A repro row names the fix commit it must fail before: `node bin/hop-matrix.js --only <harness> --against <commit>^` runs it on the older tree. The harnesses are slow and are not part of the gate; `test/hop-matrix.test.js` keeps this table, the harness files and the runner in step.

Harness results below are from 8 November 2026. Live receipts are this board's `pullboard gate-health` report for the two hours before 11:45 pm CT that night, while the machine ran at load 60 or more.

| Hop | Invariant | Harness | Live receipt | Status |
|---|---|---|---|---|
| <a id="hop-claim"></a>claim | A claim leases the item to one seat and freezes its criterion. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): `claim` on a scratch board, 1-4 s | none | PASS |
| <a id="hop-submit-queued"></a>submit → queued | Submit returns with the gate queued on the submitted commit; it never waits on the gate. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): returns `queued: true` in 3-6 s | queued p50 18.6 s over 50 gates | PASS |
| <a id="hop-dispatcher-launch"></a>dispatcher launches worker | One dispatcher per machine, on the tool root's committed tooling, starts the gate driver. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): one dispatcher, on the snapshot named by the tool root's tooling digest; submit to driver in 4.5-7 s | none | PASS |
| <a id="hop-stale-dispatcher"></a>dispatcher on stale tools hands over | A dispatcher on an older tools copy stops launching and hands over to one on the current tooling within 45 s. | `test/harnesses/pipeline/stale-dispatcher.harness.js` (8 Nov), repro, fails on `1989322098^`: hand-over in 14-26 s, the new gate driven from the current tooling | none | PASS |
| <a id="hop-worker-lease"></a>worker heartbeats and lease | A running driver is alive and renews its 2-minute lease every 5 s; no gap reaches half the lease. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): two renewals, widest gap 5.5-15.5 s under load | 56 SUBMIT_HANDOFF_DEAD | PASS, live disagrees |
| <a id="hop-live-driver"></a>live driver is never declared dead | A sweeper never declares a live, same-incarnation driver dead for a lapsed lease alone. | `test/harnesses/pipeline/live-driver.harness.js` (8 Nov), repro, fails on `515d062720^`: the sweep runs in its own process against a real driver process | none: gate-health cannot tell a false death from a real one | PASS |
| <a id="hop-analysis-on-runner"></a>analysis job on runner | Authorization, cells, doctrine and static run as one runner job and return their artifact. | NONE | remote-analysis p50 3m38s over 17 gates | NONE |
| <a id="hop-runner-admission"></a>runner admission | With a free slot, a gate is admitted to a runner in under 1 s. | `test/harnesses/pipeline/ready-budget.harness.js` (8 Nov), on the repo's local SSH stand-in runner: admitted in 121 ms | admission p50 1.8 s over 29 gates | PASS, live disagrees |
| <a id="hop-orphan-worker"></a>orphaned runner worker is reclaimed | The idle probe stops a runner worker its controller no longer names and proves the runner idle again. | `test/harnesses/pipeline/orphan-worker.harness.js` (8 Nov), repro, fails on `6166bf85ca^`: real worker processes on a local runner root, the orphan gone in 0.3-2 s | none | PASS |
| <a id="hop-ready-budget"></a>dispatch → READY | A dispatch reaches READY on its first attempt with a full startup budget, even after a long analysis. | `test/harnesses/pipeline/ready-budget.harness.js` (8 Nov), repro, refused RUNNER_WAIT_DEADLINE on `8f7c4c7024^`: one dispatch, green, no runner held | 17 admission-deadline readiness misses | PASS, live disagrees |
| <a id="hop-proof-lanes"></a>proof shards: at most 3 lanes | One gate runs at most 3 runner-controllers at once, however many slots are free. | `test/harnesses/pipeline/proof-lanes.harness.js` (8 Nov), repro, 13 at once on `cc0a573570^`: 3 with 13 free slots | none | PASS |
| <a id="hop-runner-spec"></a>proof shards: spec under 1 MiB | A runner request naming every test file of this repository builds a spec under 1 MiB. | `test/harnesses/pipeline/runner-spec.harness.js` (8 Nov), repro, refused RUNNER_REQUEST_LIMIT on `2640738102^`: 58 KiB for 1,445 files | none | PASS |
| <a id="hop-test-receipt"></a>test run → receipt | A green gate leaves a proof receipt naming the submitted commit. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): release to green with its receipts in 6-16 s | result p50 737 ms over 29 gates | PASS |
| <a id="hop-dead-requeue"></a>dead worker → requeue | A gate whose driver is killed is requeued on the same candidate within 20 s, with no builder red. | `test/harnesses/pipeline/dead-worker-requeue.harness.js` (8 Nov), repro, fails on `3a89d81fc5^`: requeued 0.7-1.6 s after the kill | requeue p50 1m41s over 22 gates | PASS, live disagrees |
| <a id="hop-foreign-sweep"></a>another machine queue's sweep | A dispatcher from another machine home never recovers this home's gates; a gate whose driver died stays this home's to retry. | `test/harnesses/pipeline/foreign-sweep.harness.js` (8 Nov), repro, fails on `044d6c6c18^` with a launch in the other home: the dead gate left to its home, which retries it | none | PASS |
| <a id="hop-green-review"></a>green → review | A green gate puts the item in review, waiting on an independent reviewer. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): submitted (in review) | none | PASS |
| <a id="hop-accept-merged"></a>accept → landing batch → merged | An accept lands through a batch: main moves to the recorded merge and is pushed. | `test/harnesses/pipeline/e2e.harness.js` (8 Nov): accept, then `pullboard land`, in 5-19 s | none | PASS |
| <a id="hop-command-latency"></a>board command latency | Seat commands answer in under 200 ms, and none loads more modules than its ratcheted ceiling. | `test/harnesses/pipeline/board-commands.harness.js` (9 Nov), the check the main audit runs, `node bin/hop-matrix.js --only board-commands`: warm medians show 109 ms, whoami 175 ms, inbox 186 ms, status 221 ms, claim 313 ms, next 410 ms; 1,415-1,674 modules each in a fresh process | `pullboard status` 6 min on this board before its disk walk left the command | FAIL: status, claim and next over 200 ms |
| <a id="hop-board-write"></a>board write never queues | A write in a busy checkout answers, and holds the board lock under 1 s, past a slow same-session command, a long reader, a gate worker and dead holders. | `test/harnesses/pipeline/board-write.harness.js` (9 Nov), repro, fails on `58f204a4af^` (the add waits behind the slow command): see the commit for timings | none | PASS |

What the matrix says today:

- Board command latency: through the warm resident process, show, whoami and inbox meet 200 ms on the fixture board; status, claim and next do not yet. A fresh process loads 1,415-1,674 modules for each seat command. The periodic main audit runs the same check (`bin/board-command-budget.js`): a module count over its ceiling in `bin/board-command-ceilings.json`, or a median over 200 ms, files a board item naming the command, the value, the ceiling, the modules it newly loads and the commits since the last passing check; a pass lowers each ceiling to what it measured.
- The analysis job on the runner has no harness. It needs a runner that takes the analysis artifact path, which the local stand-in does not cover yet.
- Five hops pass their harness while production disagrees, command latency above among them. The other four: READY misses, requeue time, admission time and SUBMIT_HANDOFF_DEAD counts in the window still include gates that started before the 8 Nov fixes, on runners under load 60. Each becomes current when a later window agrees.
