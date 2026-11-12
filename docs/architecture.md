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
- **Relay**: one Node service (`apps/relay/src/io/deploy/server.mjs`) that orders sealed records and checks who may fetch them.

## Who is who

### People sign in with GitHub

The relay signs people in through a GitHub App whose only permission is repository Metadata, read-only (`githubAppManifest` in `apps/relay/src/io/github.js`). It refuses a GitHub token that carries OAuth App scopes (`tokenResult` in `apps/relay/src/io/github.js`). The GitHub user token is used once to learn the account's numeric id and login; only that id and login are stored (`signedIn` in `apps/relay/src/io/auth.js`).

The relay asks GitHub for the person's repository role on every write, and caches read checks for under ten minutes (`access` and `ACCESS_WINDOW_MS` in `apps/relay/src/io/auth.js`). It pins the repository's numeric id when a board is linked, so a different repository that takes the same name inherits nothing.

Browser sign-in uses one-use state, PKCE and a binding cookie (`beginWeb` and `finishWeb` in `apps/relay/src/io/auth.js`). The session cookie, `pb_session`, is HttpOnly and SameSite=Lax, and Secure over HTTPS (`apps/relay/src/io/auth/http.js`). The CLI signs in with GitHub's device flow. From an SSH shell, the relay first shows a page naming the board folder and the machine's host name, and the board links only after the person confirms it there (`beginDevice` and `confirmDevice` in `apps/relay/src/io/auth.js`, `relayOn` in `packages/link/src/io/relay.js`).

### Machines, agents, grants and devices hold Pullboard credentials

On top of the GitHub identity, the relay issues its own credentials. Each one is a prefix and 32 random bytes (`random` in `apps/relay/src/io/auth.js`). The relay keeps only a SHA-256 hash of each, and checks expiry and revocation on every use (`issue` and `credential` in `apps/relay/src/io/auth.js`).

| Credential | Who holds it | What it can do | Lifetime |
| --- | --- | --- | --- |
| `ps_` person session | The phone, in the `pb_session` cookie. The CLI holds one in memory while it links a board, and clears any saved copy (`loadLink` in `packages/link/src/io/relay.js`). | Everything the person's GitHub role allows: link boards, issue `pm_` and `pa_`, approve phone requests, make person-only moves. | 7 days |
| `pm_` machine credential | One per board per machine, in `<git common dir>/pullboard/relay.json`, mode 600 (`linkFile` in `packages/link/src/io/relay.js`). | Upload snapshots, register agent seats, publish phone approvals, upload key wraps for paired devices, issue `pa_` tokens and spend a `pg_` grant. It cannot make person-only moves. | 30 days |
| `pa_` agent token | One per agent seat, cached in `relay.json` or supplied as `PULLBOARD_RELAY_TOKEN` (`actorTransport` in `packages/link/src/io/relay.js`). | Moves on one board as one named agent. | 1 day by default, 30 at most |
| `pg_` action grant | Issued to the phone after the person taps approve, then sealed to the machine's in-memory reply key (`nativePhoneAction` in `packages/link/src/io/relay/phone.js`). | One exact native action, such as revoking a device or a token or deleting the relay copy, bound to its approval context. | 120 seconds at most, one use |
| `pd_` sign-in ticket | The CLI, during a device sign-in. The relay keeps its hash in memory. | Poll for or cancel one pending sign-in. | GitHub's device-code lifetime |
| `pc_` confirmation ticket | The person's browser, in the fragment of the confirmation link. The relay keeps its hash in memory. | Confirm or decline one board link. | The sign-in, plus 10 minutes after GitHub confirms |

A person session can revoke any of its account's credentials through `POST /auth/tokens/revoke`; a machine or agent credential can revoke only itself (`revoke` in `apps/relay/src/io/auth.js`). Deleting a board's relay copy, or letting it expire, deletes every credential bound to it (`forgetBoard` in `apps/relay/src/io/auth.js`). The relay keeps the hashes of the ones still live until they would have expired, so a machine that uses one later hears that the relay copy was deleted and keeps working locally.

The relay labels each record with a sender taken from the credential that sent it, and ignores any sender named in the request (`sender` in `apps/relay/src/io/service.js`). Every client refuses a record its sender may not make: a machine credential may send snapshots, seat registrations, the coordinator seat and phone-approved moves, and an agent may act only as itself (`relaySenderProblem` in `packages/state/src/logic/relay/sender.js`). On the machine, a terminal that carries an agent marker or an SSH marker cannot take person actions, and the person uses the view or the phone instead (`requirePersonChannel` in `packages/person/src/io/main.js`).

## What the relay stores

Everything durable lives on one volume at `/data`: `auth.sqlite`, then `devices.sqlite` and one journal per board under `boards/`, then `backups/` (`apps/relay/src/io/deploy/server.mjs`). The relay keeps its files at mode 600 in directories at mode 700.

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

Once a day the relay copies each journal into `backups/` and keeps each copy for 14 days; deleting a board deletes its copies at once (`apps/relay/src/io/retention.js`). After 60 days without activity the relay warns on the next contact, and at 90 days it deletes the board.

Some state lives only in memory and ends with the process: machine-to-machine pairing packages, pending sign-ins with their GitHub device codes and board confirmations, GitHub App installation tokens, and the read-permission cache (`apps/relay/src/logic/pairing/store.js`, `apps/relay/src/io/auth.js`, `apps/relay/src/io/github.js`).

## What the relay can read

The relay sees who and when. It knows every GitHub account that signs in, every linked repository name, and for each record its sequence, arrival time, size, kind and sender: the person's account, a machine's id (`machine-` and a random UUID, from `packages/link/src/io/relay/machine.js`) or an agent's seat name. From those it can tell how active each board is and which agents work on it. It knows which phones are paired to which account and which boards each phone has keys for, along with each phone's public key and its label, `Phone browser`. Like any web service, it receives the network address of every request.

It also reads phone approvals. A machine publishes each approval with its context in clear: account, boards, device, action, target (a repository name, device id or token id), machine id, the exact command text and the expiry (`approvalContext` in `packages/link/src/logic/relay/approval.js`). The relay keeps that context in `phone_approval` and again in `relay_action_grants`. When a board is linked from an SSH shell, the relay holds the machine's host name and the board's folder name in memory to show on the confirmation page.

## What only your devices can read

Board contents travel sealed: items, criteria, shouts, verdicts and spec rows. The machine seals each snapshot, move and request with AES-256-GCM under the board key, and the associated data binds the board id, the sequence and the kind (`seal` in `packages/kernel/src/logic/seal.js`). The relay checks only that a payload is canonical base64url, then stores the bytes unparsed (`sealed` in `apps/relay/src/io/service.js`, `apps/relay/src/io/journal.js`). Your repository's code stays on your machine; only board records go to the relay.

The relay never receives a board key in a form it can use. A phone gets it wrapped to the phone's own ECDH key, and another machine gets it sealed under a secret that exists only in the printed pairing code. The pairing secrets themselves stay off the relay: the phone's secret rides in the link's fragment, which the browser never sends (`apps/relay/src/io/browser/devices.js`).

## How pairing moves the board key

**Linking a board.** `pullboard relay on` makes a 256-bit board key on the machine and keeps it in `~/.pullboard/relay-keys/<board>.key`, mode 600 (`generateBoardKey` in `packages/kernel/src/logic/seal.js`, `storeBoardKey` in `packages/keys/src/io/relay.js`). The person signs in and the relay records the link. The machine receives its `pm_` and uploads the board's first sealed snapshot.

**Pairing a phone.** The machine makes a one-time locator and secret, keeps the secret in its private `relay-machine/state.json`, and shows both in a QR code (`beginDeviceEnrollment` in `packages/link/src/io/relay/machine.js`). The phone makes an ECDH P-256 key pair whose private half cannot be exported, and keeps it in IndexedDB (`createDeviceKeys` in `packages/keys/src/logic/device.js`). It signs its public key with an HMAC derived from the secret and posts it through the relay (`signDeviceEnrollment`). The machine checks that MAC before it trusts the key, so the relay cannot slip in a key of its own (`acceptDeviceEnrollment` in `packages/link/src/io/relay/machine.js`). The machine then wraps the board key to the public key it recorded itself (`wrapForRecordedDevice`) and uploads the wrap with its `pm_`. It wraps again on every sync (`deliverDeviceWraps` in `packages/link/src/io/relay.js`). The phone unwraps it with its private key and keeps the board key in `localStorage` (`deviceBoardKeys` in `apps/relay/src/io/browser/devices.js`, used by `apps/relay/src/io/browser/client.js`).

**Pairing another machine.** `pullboard relay pair` prints a code made of the board id, a locator and a 256-bit secret. The machine seals the board key and a snapshot under that secret and posts the package (`sealPairingBundle` in `packages/person/src/io/pairing.js`). The relay holds it in memory for ten minutes and hands it out once, to a caller who can read the board (`apps/relay/src/logic/pairing/store.js`, `apps/relay/src/logic/pairing/http.js`).

**Phone approvals.** For a native action that needs the person, such as revoking a device, the machine publishes the context and a sealed intent, authenticated with an HMAC under the board key so the relay cannot invent one (`phoneProposal` in `packages/link/src/io/relay/phone.js`). The intent also carries the machine's host name and the board's name, sealed, so the phone can show them and the relay cannot read or change them (`proposalNames` in `packages/link/src/io/relay/phone.js`). The phone shows the request. On a tap the relay issues a `pg_`; the phone seals it to the machine's in-memory reply key, and the machine spends it once (`issueActionGrant` and `consumeActionGrant` in `apps/relay/src/io/auth.js`).

**One order for every move.** The relay gives each record the next sequence number atomically and refuses repeats and gaps (`insert` in `apps/relay/src/io/journal.js`). Every client applies records in that order with the CLI's own rules.

## Machine-local relay canary

A relay canary is an opt-in monitor on an ordinary client machine. It checks the authenticated board move path by signing in as its configured ordinary seat, sending a nonce-bearing shout through the normal ordered move, pulling the fresh event and unsealing the exact returned move. A successful `/health` response alone is not a round trip. The canary does not alter the relay API or add a server-side table.

`pullboard relay canary on [--timeout <milliseconds>]` stores `relay.canary` in this machine's settings: an enabled flag, an absolute checkout path, the registered non-coordinator `agentId`, and an optional deadline (5 seconds by default; 100–25,000 ms when set). The credentials stay in the existing local link and key stores. The setting binds the run to that checkout and seat. To monitor one board from two machines, link that board normally on each and configure one ordinary seat per machine after the feature lands. `pullboard relay canary off` disables an existing setting (or leaves an absent setting unset); `status` reads local observations without a network request; `run` executes one probe; `watch` runs an immediate probe and then checks once per minute until stopped with Ctrl-C. The watch is separate from the ordinary ten-minute health scan.

Each machine keeps its observations and minute schedule in a private SQLite file at `<git common dir>/pullboard/relay-health.sqlite`. A fresh result is healthy or degraded; after two minutes without a recent sample, status is unknown. Two consecutive failed probes create an alert. A latency alert requires a complete ten-minute window and at least ten successful samples, with p95 above two seconds. The local Needs-you entry reports the actual queued move count from that machine's outbox. It is local telemetry: it is not included in sealed board presentations or sent to other devices as health state.

On an alert or recovery, the configured seat sends notices through ordinary native ordered shouts to the coordinator and person. If the relay or native notification route is unavailable, the notice remains pending locally and is retried; a later delivery is labeled delayed. A local alert or successful native write is not a phone acknowledgement. Closed-phone push delivery is a separate notification path.

For an operational drill, interrupt the authenticated sign-in, move-upload or fresh-event-read route used by the client, then restore that route and run a complete probe. Do not substitute an HTTP health endpoint for those client routes. The expected recovery is a later successful sealed round trip; if its notice could not travel during the outage, it remains delayed. Configuration alone does not mean either production host has been linked or has completed a successful probe.

## Redeploys

A new relay process on the same `/data` volume keeps every account, link, credential hash, paired phone, wrapped key, approval and journal; `apps/cli/journeys/relay/deploy.test.js` restarts the relay and proves that no one re-pairs. A restart ends what lives only in memory, so a half-finished sign-in or pairing starts again. The service runs as a single replica, since one writer owns these SQLite files (`apps/relay/src/io/deploy/README.md`).

A phone pairs again when its browser storage is cleared, when it signs in as another account, or when the device is revoked. The hosted page can be installed to the Home Screen and asks the browser to keep its storage, since Safari on iPhone can clear a site's storage after seven days without a visit (`apps/relay/src/logic/browser/install.js`).

## Local main-facts cache

Immutable facts derived from accepted main are stored in the private Git-common-directory cache. The cache retains current main and at most eight recent commit groups by default; older groups are evicted in the same transaction as insertion, and SQLite reclaims the freed space. The default database cap is 512 MiB. `PULLBOARD_MAIN_FACTS_MAX_BYTES` sets the local byte cap (minimum 16384); `PULLBOARD_MAIN_FACTS_RECENT_COMMITS` sets the number of recent groups (1–1000). Invalid values use the defaults. Oversized legacy cache contents are discarded and rebuilt. If the cache is unavailable, busy, unsafe or cannot write, facts are derived without the cache; source and board authority are unchanged. Evictions emit one diagnostic line.

## Honest limits

The relay sees metadata. The section on what it can read lists all of it: accounts, repository names, record sizes and timing, seat names, machine ids, which phones hold which boards, and network addresses.

A compromised relay could serve a compromised page. Every script the phone runs comes from the relay (`apps/relay/src/io/browser/page.js`), and nothing outside the relay pins or signs that code. Such a page could read the board keys the phone keeps in `localStorage`.

Approval context is in clear. The relay reads each requested action, its target, the machine id and the command text, and keeps them with no deletion path.

The sender of a record is the relay's word. The seal binds the board, the sequence and the kind, and leaves the sender outside it (`packages/kernel/src/logic/seal.js`), so a compromised relay could relabel a validly sealed move. The device key only agrees keys: it cannot sign, and no passcode or Face ID guards it. A phone approval proves a tap in a browser that holds the session cookie.

Agents on a machine share what is on disk. Every agent runs as the same operating-system user, so any of them can read the board key file and `relay.json`. The `pm_` there can issue a `pa_` for any seat name the relay is given (`issueToken` in `apps/relay/src/io/auth.js`), and only the client checks that the name is a registered seat (`actorTransport` in `packages/link/src/io/relay.js`).

Revoking a phone stops new wraps and deletes its stored ones, and the board keys it already received stay usable to whoever holds them. Board key rotation is a separate step.

Some rows have no deletion path: `relay_users`, `relay_action_grants`, `relay_passkeys`, `relay_person_authority`, `phone_approval`, `person_enrollment` and the `device` tombstones. A board that expires for inactivity leaves its `wrapped_key` rows behind.

RFC 0004 describes keeping the board key in the operating system's keychain. The code keeps it in a mode-600 file and moves any older keychain copy into that file (`packages/keys/src/io/relay.js`).

## Pipeline hops: Build → Gate → Review → Land

Every item travels the same hops from claim to merged. Each row below names the invariant the hop must keep, the harness that proves it, and the live receipt that shows it in production. A harness runs real git, a real SQLite board and real child processes in its own temp folders, never in a checkout, and its after-hook fails it if any process it started is still alive. NONE means no harness exists yet: that is real debt, not a pass. A row is current only when its harness passes and the live receipt agrees.

`node packages/gate/src/io/matrix.js --live` runs every harness under `packages/gate/tests/fixtures/pipeline/` one after another and prints this matrix with PASS, FAIL or NONE and each timing; `--json` prints the same rows for a view screen. A repro row names the fix commit it must fail before: `node packages/gate/src/io/matrix.js --only <harness> --against <commit>^` runs it on the older tree. The harnesses are slow and are not part of the gate; `packages/gate/tests/io/matrix.test.js` keeps this table, the harness files and the runner in step.

Harness results below are from 8 November 2026. Live receipts are this board's `pullboard gate-health` report for the two hours before 11:45 pm CT that night, while the machine ran at load 60 or more.

| Hop | Invariant | Harness | Live receipt | Status |
|---|---|---|---|---|
| <a id="hop-claim"></a>claim | A claim leases the item to one seat and freezes its criterion. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): `claim` on a scratch board, 1-4 s | none | PASS |
| <a id="hop-submit-queued"></a>submit → queued | Submit returns with the gate queued on the submitted commit; it never waits on the gate. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): returns `queued: true` in 3-6 s | queued p50 18.6 s over 50 gates | PASS |
| <a id="hop-dispatcher-launch"></a>dispatcher launches worker | One dispatcher per machine, on the tool root's committed tooling, starts the gate driver. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): one dispatcher, on the snapshot named by the tool root's tooling digest; submit to driver in 4.5-7 s | none | PASS |
| <a id="hop-stale-dispatcher"></a>dispatcher on stale tools hands over | A dispatcher on an older tools copy stops launching and hands over to one on the current tooling within 45 s. | `packages/gate/tests/fixtures/pipeline/dispatcher.js` (8 Nov), repro, fails on `1989322098^`: hand-over in 14-26 s, the new gate driven from the current tooling | none | PASS |
| <a id="hop-worker-lease"></a>worker heartbeats and lease | A running driver is alive and renews its 2-minute lease every 5 s; no gap reaches half the lease. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): two renewals, widest gap 5.5-15.5 s under load | 56 SUBMIT_HANDOFF_DEAD | PASS, live disagrees |
| <a id="hop-live-driver"></a>live driver is never declared dead | A sweeper never declares a live, same-incarnation driver dead for a lapsed lease alone. | `packages/gate/tests/fixtures/pipeline/driver.js` (8 Nov), repro, fails on `515d062720^`: the sweep runs in its own process against a real driver process | none: gate-health cannot tell a false death from a real one | PASS |
| <a id="hop-analysis-on-runner"></a>analysis job on runner | Authorization, cells, doctrine and static run as one runner job and return their artifact. | NONE | remote-analysis p50 3m38s over 17 gates | NONE |
| <a id="hop-runner-admission"></a>runner admission | With a free slot, a gate is admitted to a runner in under 1 s. | `packages/gate/tests/fixtures/pipeline/budget.js` (8 Nov), on the repo's local SSH stand-in runner: admitted in 121 ms | admission p50 1.8 s over 29 gates | PASS, live disagrees |
| <a id="hop-orphan-worker"></a>orphaned runner worker is reclaimed | The idle probe stops a runner worker its controller no longer names and proves the runner idle again. | `packages/gate/tests/fixtures/pipeline/worker.js` (8 Nov), repro, fails on `6166bf85ca^`: real worker processes on a local runner root, the orphan gone in 0.3-2 s | none | PASS |
| <a id="hop-ready-budget"></a>dispatch → READY | A dispatch reaches READY on its first attempt with a full startup budget, even after a long analysis. | `packages/gate/tests/fixtures/pipeline/budget.js` (8 Nov), repro, refused RUNNER_WAIT_DEADLINE on `8f7c4c7024^`: one dispatch, green, no runner held | 17 admission-deadline readiness misses | PASS, live disagrees |
| <a id="hop-proof-lanes"></a>proof shards: at most 3 lanes | One gate runs at most 3 runner-controllers at once, however many slots are free. | `packages/gate/tests/fixtures/pipeline/lanes.js` (8 Nov), repro, 13 at once on `cc0a573570^`: 3 with 13 free slots | none | PASS |
| <a id="hop-runner-spec"></a>proof shards: spec under 1 MiB | A runner request naming every test file of this repository builds a spec under 1 MiB. | `packages/gate/tests/fixtures/pipeline/spec.js` (8 Nov), repro, refused RUNNER_REQUEST_LIMIT on `2640738102^`: 58 KiB for 1,445 files | none | PASS |
| <a id="hop-test-receipt"></a>test run → receipt | A green gate leaves a proof receipt naming the submitted commit. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): release to green with its receipts in 6-16 s | result p50 737 ms over 29 gates | PASS |
| <a id="hop-dead-requeue"></a>dead worker → requeue | A gate whose driver is killed is requeued on the same candidate within 20 s, with no builder red. | `packages/gate/tests/fixtures/pipeline/requeue.js` (8 Nov), repro, fails on `3a89d81fc5^`: requeued 0.7-1.6 s after the kill | requeue p50 1m41s over 22 gates | PASS, live disagrees |
| <a id="hop-foreign-sweep"></a>another machine queue's sweep | A dispatcher from another machine home never recovers this home's gates; a gate whose driver died stays this home's to retry. | `packages/gate/tests/fixtures/pipeline/sweep.js` (8 Nov), repro, fails on `044d6c6c18^` with a launch in the other home: the dead gate left to its home, which retries it | none | PASS |
| <a id="hop-green-review"></a>green → review | A green gate puts the item in review, waiting on an independent reviewer. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): submitted (in review) | none | PASS |
| <a id="hop-accept-merged"></a>accept → landing batch → merged | An accept lands through a batch: main moves to the recorded merge and is pushed. | `packages/gate/tests/fixtures/pipeline/e2e.js` (8 Nov): accept, then `pullboard land`, in 5-19 s | none | PASS |
| <a id="hop-landing-reopen"></a>reject or reopen during landing | An item reopened between selection and merge drops out of the landing batch: main never takes its commit and it records no merge. | `packages/gate/tests/fixtures/pipeline/a-reject-or-reopen-during-landing.js` (12 Nov): reopen while the landing gate holds | none | PASS |
| <a id="hop-command-latency"></a>board command latency | Seat commands answer in under 200 ms, and none loads more modules than its ratcheted ceiling. | `packages/gate/tests/fixtures/pipeline/board/commands.js` (9 Nov), the check the main audit runs, `node packages/gate/src/io/matrix.js --only board-commands`: warm medians show 109 ms, whoami 175 ms, inbox 186 ms, status 221 ms, claim 313 ms, next 410 ms; 1,415-1,674 modules each in a fresh process | `pullboard status` 6 min on this board before its disk walk left the command | FAIL: status, claim and next over 200 ms |
| <a id="hop-board-write"></a>board write never queues | A write in a busy checkout answers, and holds the board lock under 1 s, past a slow same-session command, a long reader, a gate worker and dead holders. | `packages/gate/tests/fixtures/pipeline/board/write.js` (9 Nov), repro, fails on `58f204a4af^` (the add waits behind the slow command): see the commit for timings | none | PASS |
| <a id="hop-import-undeclared"></a>board restored from an export with an undeclared status | An import whose item row carries an undeclared status is refused UNDECLARED_STATE before anything is inserted. | `packages/gate/tests/fixtures/pipeline/board-restored-from-an-export-with-an-un.js` (12 Nov): a forged status refused, the unchanged export restored | none | PASS |

What the matrix says today:

- Board command latency: through the warm resident process, show, whoami and inbox meet 200 ms on the fixture board; status, claim and next do not yet. A fresh process loads 1,415-1,674 modules for each seat command. The periodic main audit runs the same check (`apps/cli/src/io/landing/budget.js`): a module count over its ceiling in `packages/gate/data/ceilings/board-commands.json`, or a median over 200 ms, files a board item naming the command, the value, the ceiling, the modules it newly loads and the commits since the last passing check; a pass lowers each ceiling to what it measured.
- The analysis job on the runner has no harness. It needs a runner that takes the analysis artifact path, which the local stand-in does not cover yet.
- Five hops pass their harness while production disagrees, command latency above among them. The other four: READY misses, requeue time, admission time and SUBMIT_HANDOFF_DEAD counts in the window still include gates that started before the 8 Nov fixes, on runners under load 60. Each becomes current when a later window agrees.



## State machines

Every move the loop makes, written down from the code as it is on 9 November 2026, so nothing can happen that is not on this page. Each row cites the function that does it (`function` in `file`) and the harness that proves it, or NONE where nothing does; a NONE row is open debt. `packages/state/tests/fixtures/machines.json` holds the same tables as data, and `packages/state/tests/machines.test.js` fails when the code names a status, a move, a job kind or a job step that the map lacks, or the map names one the code lacks.

One invariant runs through all of it: **a job, a lease or an offer whose item is no longer in the state it serves ends at once.** Where the code breaks it, the row says violated and names a gap from the list at the end.

### 1. Item lifecycle

An item has five statuses, declared with its moves as `STATES` and `MOVES` in `packages/state/src/logic/machine/declaration.js`. One function writes a status, `checkedItemMove` in `packages/store/src/io/board.js`, and the board file's own triggers refuse any change that no move declares (UNDECLARED_MOVE) or any status that is not declared (UNDECLARED_STATE).

| Status | Final | Means |
|---|---|---|
| `open` | no | waiting for a builder; claimable once what it waits on is verified |
| `claimed` | no | one seat holds it under a lease, its criterion frozen |
| `submitted` | no | gated green (or intaken from outside) at a pinned commit, waiting on review |
| `verified` | no | accepted at its commit; landed once item_merged_commit is set |
| `withdrawn` | yes | nobody should build it; nothing leaves it |

These are not statuses. Each is a field or an event on top of one:

| Flag | Stored as | Set by | Note |
|---|---|---|---|
| merged | item_merged_commit and a merged event | `merged` in `packages/store/src/io/board/merged.js` | a flag on a verified item, never a status; the display stage is landed |
| held | item_hold_reason, item_hold_by, item_hold_at | `applyItemHold` in `packages/items/src/logic/holds.js` | blocks claim (ITEM_HELD) and landing selection; lifted by applyItemHoldRelease or liftConditionalHold |
| reopened | a reopen event | `reopen` in `packages/store/src/io/board/reopen.js` | an event; the item goes to open |
| in review | item_review_by, item_review_until and a review job | `reserveWithin` in `packages/store/src/io/board/reserve/review.js` | the reserve move; status stays submitted |
| frozen | item_frozen_digest | `claim` in `packages/store/src/io/board/claim.js` | the criterion a claim is judged against |
| lapsed claim | item_lease_until in the past | `current` in `packages/store/src/io/board/query.js` | read as open by every reader; written back only by a later release or claim |

#### Transitions

A declared move is in `MOVES`; an undeclared one is a code path the declaration does not name.

| Move | From | To | By | Cause | Where | Guard (refusals) | Emits | Harness |
|---|---|---|---|---|---|---|---|---|
| `add` (undeclared) | (new) | `open` | agent, coordinator | pullboard add | `insertItem` in `packages/store/src/io/board/add.js` | machine_item_start trigger (UNDECLARED_MOVE) | add | `apps/cli/journeys/verify/machine.test.js` |
| `claim` | `open`, `claimed` | `claimed` | agent, coordinator | pullboard claim, next, next --take | `claim` in `packages/store/src/io/board/claim.js` | NOT_CLAIMABLE, HELD, ITEM_HELD, LANE_HELD, BLOCKED, WRONG_LANE, ROUTE, ITEM_BUILD_BUDGET, ONE_CLAIM, REOPEN_HELD_FOR_BUILDER, PENDING_REFREEZE, LINE_WIP_LIMIT | claim or renew | `apps/cli/journeys/claim/race.test.js` |
| `release` | `open`, `claimed` | `open` | agent, coordinator | pullboard release; stale and idle maintenance | `releaseClaim` in `packages/store/src/logic/board/claim.js` | NOT_YOURS, RELEASE_REASON, ENGINE_VERSION | release (+hold_item after a second release) | `apps/lib/tests/hold.test.js` |
| `lapse` | `claimed` | `open` | clock | a claim lease runs out; written only by an edit of an expired claim or by stale maintenance as a release | `applyStaleState` in `packages/store/src/logic/board/stale/apply.js` | caller checks STALE_STATE_CHANGED; the move's state check is passed as null | release {expiredClaim} and stale_maintenance; never a lapse event | `apps/cli/journeys/init/lapse.test.js` |
| `submit` | `claimed` | `submitted` | agent, coordinator | pullboard submit, after its queued gate is green | `submit` in `packages/store/src/io/board/submit.js` | NOT_YOURS, PENDING_REFREEZE, BAR_NOT_READY, CLAUSE_UNTICKED, SUBMISSION_PROOF, CHILDREN_OPEN, HEAD_NOT_NEW; CLI: DIRTY, OUTSIDE_LANE, GATE_RED | submit | `apps/cli/journeys/submit/handoff.test.js` |
| `submit-merge` | `claimed` | `verified` | agent, coordinator | pullboard submit of a carried acceptance | `submit` in `packages/store/src/io/board/submit.js` | the submit guards, MERGE_ONLY_PROOF, SELF_VERIFY, PROOF_REQUIRED | merge-only-accept, submit | `apps/cli/journeys/verify/machine.test.js` |
| `intake` | `open` | `submitted` | agent, coordinator | pullboard intake <PR> | `applyOutsideIntake` in `packages/store/src/io/outside.js` | NOT_CLAIMABLE, OUTSIDE_HEAD_CHANGED | outside-intake | `apps/cli/journeys/verify/machine.test.js` |
| `reserve` | `submitted` | `submitted` | agent, coordinator | next --verify, plain next's mandatory review | `reserveWithin` in `packages/store/src/io/board/reserve/review.js` | NOT_SUBMITTED, GATE_PENDING, REVIEW_COOLDOWN, COMPANION_WINDOW, SELF_VERIFY, SAME_FAMILY, REQUIRED_REVIEW_FAMILY, ROUTE, REVIEW_HELD | reserve | `packages/moves/tests/logic/moves/reserveNextReview/durable.test.js` |
| `accept` | `submitted`, `verified` | `verified` | agent, coordinator | pullboard verify <id> accept; verified to verified only for a new review on newer engines | `verify` in `packages/store/src/io/board/verify.js` | NOT_SUBMITTED, GATE_PENDING, ALREADY_MERGED, SELF_VERIFY, CRITERIA_CHANGED, PROOF_REQUIRED, CHECK_RED | accept and a verdict row | `apps/cli/journeys/verify/machine.test.js` |
| `accept (machine)` (undeclared) | `submitted` | `verified` | coordinator | a machine-proved submission is accepted after submit | `acceptMachineSubmission` in `packages/verify/src/io/machine.js` | every accept guard passed as null; only the caller's MACHINE_PROOF check and the database proof trigger | accept by coordinator | NONE |
| `reject` | `submitted`, `verified` | `open` | agent, coordinator | pullboard verify <id> reject | `verify` in `packages/store/src/io/board/verify.js` | as accept, plus BAD_REASON, NOTE_REQUIRED, BAR_CLAUSE_REQUIRED | reject and a verdict row (+hold_item, bar-sharpen) | `packages/store/tests/any.test.js` |
| `reopen` | `submitted`, `verified` | `open` | agent, coordinator | pullboard reopen; automatic trunk conflict; verdict withdrawal; stale verdict at landing | `reopen` in `packages/store/src/io/board/reopen.js` | NOT_SUBMITTED, COORDINATOR_ONLY, ALREADY_MERGED, VERDICT_WITHDRAW_*, NOTE_REQUIRED, BAD_CONFLICT | reopen | `apps/cli/journeys/reopen/conflict.test.js` |
| `escalate` | `open`, `claimed` | `open` | agent, coordinator | pullboard escalate | `escalate` in `packages/store/src/logic/board/escalate.js` | CLOSED, NOTE_REQUIRED, NOT_YOURS | escalate | `apps/cli/journeys/verify/machine.test.js` |
| `refreeze` | `open`, `claimed`, `submitted`, `verified` | `open` | coordinator | pullboard refreeze (edit --criterion) | `refreeze` in `packages/store/src/io/board/refreeze.js` | COORDINATOR_ONLY, CLOSED (verified only inside a spec correction, never merged), BAR_NOT_READY | refreeze | `apps/cli/journeys/verify/machine.test.js` |
| `refreeze` | `claimed` | `claimed` | agent, coordinator | the holder takes a refrozen bar | `refreeze` in `packages/store/src/io/board/refreeze.js` | NOT_YOURS, UNKNOWN_SPEC | refreeze | `apps/cli/journeys/verify/machine.test.js` |
| `withdraw` | `open`, `claimed`, `submitted` | `withdrawn` | coordinator | pullboard withdraw; a forced merged on an unverified item | `withdraw` in `packages/store/src/io/board/withdraw.js` | CLOSED, COORDINATOR_ONLY, NOTE_REQUIRED, STALE_MAIN_RED | withdraw; ends a queued or running hand-off record | `apps/cli/journeys/withdraw/handoff.test.js` |
| `patch` | `submitted`, `verified` | `submitted` | coordinator | pullboard patch attach or remove | `invalidateItemPatch` in `packages/items/src/io/patches.js` | ITEM_PATCH_STATE, COORDINATOR_ONLY, ALREADY_MERGED | item_patch_attach or item_patch_remove | `apps/cli/journeys/verify/machine.test.js` |
| `patch-claimed` | `claimed` | `claimed` | coordinator | pullboard patch on a claimed item | `invalidateItemPatch` in `packages/items/src/io/patches.js` | ITEM_PATCH_STATE, COORDINATOR_ONLY | item_patch_attach | `apps/cli/journeys/verify/machine.test.js` |
| `patch-objected` | `claimed`, `submitted` | `open` | agent | pullboard patch object | `applyItemPatchObjection` in `packages/items/src/io/patches.js` | ITEM_PATCH_WINDOW, NOTE_REQUIRED | item_patch_object | `apps/cli/journeys/verify/machine.test.js` |
| `rehomeImport` | `open` | `verified` | agent | pullboard rehome with a carried ACCEPT | `applyRehomeItem` in `packages/items/src/io/rehome.js` | REHOME_VERDICT, NOT_AT_COMMIT, SELF_VERIFY, CRITERIA_CHANGED, PROOF_REQUIRED | rehome_import, rehome_applied | `apps/cli/journeys/verify/machine.test.js` |
| `reland` (undeclared) | `open` | `verified` | coordinator | landing re-lands an accepted green item | `relandAccepted` in `packages/store/src/logic/board/reland.js` | COORDINATOR_ONLY, RELAND_NOT_ELIGIBLE, NOT_AT_COMMIT, SELF_VERIFY, CRITERIA_CHANGED; its proof check is a no-op; passes the trigger only because rehomeImport declares open to verified | reland | `apps/cli/journeys/reopen/relands.test.js` |
| `red return` (undeclared) | `claimed` | `claimed` | clock | a queued gate comes back red; the builder keeps the claim with a renewed lease | `returnToBuilder` in `packages/store/src/io/submit/handoff/retry.js` | the hand-off record's own state; lease set with setItem | renew {queuedRedReturn}, submit_handoff_returned | `apps/cli/journeys/submit/handoff.test.js` |
| `merged` (undeclared) | `verified` | `verified` | coordinator | pullboard merged, or a landing batch finishing | `merged` in `packages/store/src/io/board/merged.js` | COORDINATOR_ONLY, NOT_VERIFIED, FORCED_REASON; no check for an existing item_merged_commit on the CLI path (the batch path checks it) | merged | `apps/cli/journeys/land/main.test.js` |

#### Refused changes

No move declares these, so the board file refuses them whatever command asks. A harness can assert each one.

| Change | Enforced by | Harness |
|---|---|---|
| submitted → claimed | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| verified → claimed | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| verified → withdrawn | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| withdrawn → open | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| withdrawn → claimed | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| withdrawn → submitted | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| withdrawn → verified | `storeTriggers` in `packages/state/src/io/machine.js` | `apps/cli/journeys/verify/machine.test.js` |
| verified and merged to open or submitted (guard only: the trigger allows verified to open and to submitted; only the ALREADY_MERGED guards in verify, reopen and patch, and CLOSED in refreeze, stop it) | `reopen` in `packages/store/src/io/board/reopen.js` | `apps/cli/journeys/reopen/command.test.js` |

#### Writes that bypass the declaration

- `restoreDocument` in `packages/store/src/io/exchange.js`: board import and relay restore drop the machine triggers and insert any item_status.
- `undoQueuedWith` in `packages/outbox/src/logic/undo.js`: relay undo suspends the guards and reapplies an inverse changeset.
- `relandAccepted` in `packages/store/src/logic/board/reland.js`: an ad-hoc reland move that MOVES does not declare.
- `acceptMachineSubmission` in `packages/verify/src/io/machine.js`: accept with every guard passed as null.
- `merged` in `packages/store/src/io/board/merged.js`: a second pullboard merged overwrites item_merged_commit and logs a second merged event.

### 2. Job lifecycles

A job is a row with append-only steps and a lease (RFC 0008). Its current step is the last one written; `done` is a mark set only by `finishJob` in `packages/jobs/src/io/lease.js`. Job leases are `LEASE_MS`, 2 minutes. Each table names the item state the job serves, and whether the code ends the job once the item leaves it.

#### `gate`: submit hand-off record

- **Id:** `<hand-off id>`. Created by `shadowSubmitHandoff` in `packages/jobs/src/io/shadow.js`.
- **Serves:** item claimed by the hand-off's seat at its commit and frozen digest, until the gate's green turns into the submit.
- **States:** `queued`, `running`, `green`, `submitted`, `red`, `incomplete`, `infrastructure`, `ownership-wait`, `ended`, `withdrawn`, `done`. Terminal: `green`, `submitted`, `red`, `incomplete`, `ownership-wait`, `ended`, `withdrawn`, `done`.
- **Lease:** none in production since f226542983; legacy handoff-drive rows carried a 2-minute lease (LEASE_MS).
- **Ends when its item moves on:** partial, at `startSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js`: checked on queue and on queued to running; a running record is resumed with no item check (driveSubmitHandoff proceeds when the record is already running). The fallback's predicate is submitted-at-commit (submittedAt), which is the wrong serving state for a pre-submit gate.
- **Harness:** `apps/cli/journeys/gate/jobs.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `queued` | pullboard submit queues its gate; checks claimed, owner, live lease, digest | `queueSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `queued` | `running` | the driver starts; checks claimed, owner, digest | `startSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `green` | code 0 and the item is submitted at the result commit | `completeSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `red` | a red gate; the builder keeps the claim | `completeSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `ownership-wait` | the source needs another lane's file | `completeSubmitHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `infrastructure` | SUBMIT_HANDOFF_DEAD or another infrastructure stop | `recordInfrastructureStop` in `packages/store/src/io/submit/handoff/retry.js` |
| `infrastructure` | `queued` | a retry under a new id, up to INFRASTRUCTURE_RETRY_LIMIT (3) | `retryStoppedHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `queued` | `ended` | the item is withdrawn | `endWithdrawnHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `ended` | the item is withdrawn; the running driver is not told | `endWithdrawnHandoff` in `packages/store/src/io/submit/handoff/retry.js` |
| `running` | `withdrawn` | legacy leased row only: the fallback finds its item no longer submitted at its commit | `endDeadGateJobs` in `packages/drive/src/io/reclaim.js` |
| `running` | `ended` | legacy leased row only: the fallback finds no step for 20 minutes | `endDeadGateJobs` in `packages/drive/src/io/reclaim.js` |

#### `gate-drive`: submit gate driver

- **Id:** `gate-drive:<hand-off id>`. Created by `admitGateDrive` in `packages/drive/src/io/gate.js`.
- **Serves:** the hand-off record while it is queued or running, so the item claimed at the hand-off's commit and digest.
- **States:** `admitted`, `spawned`, `unstarted`, `queued`, `captured`, `running`, `shard.started`, `shard.done`, `shard.invalid`, `section.done`, `gate.progress`, `gate.stalled`, `collected`, `verdict`, `done`. Terminal: `done`, `unstarted`.
- **Lease:** LEASE_MS 120 s; renewed every GATE_RENEW_MS 5 s by the driver's timer; a late tick retakes a lapsed lease; GATE_STALL_MS 20 min with no step stalls once, then GATE_INFRA_EXHAUSTED.
- **Ends when its item moves on:** violated (gap SM1), at `attemptGate` in `packages/drive/src/io/once.js`: no item or hand-off check on admission, on any drive transition, or on renewal; the fallback lists only kind gate, so it never sees this kind. A withdrawn, reopened or replaced item's driver runs to its verdict; a driver freed by SIGTERM stays not done and is never ended.
- **Harness:** `apps/cli/journeys/handoff/dead/running.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `admitted` | the dispatcher admits a queued ticket and takes the lease | `admitGateDrive` in `packages/drive/src/io/gate.js` |
| `admitted` | `spawned` | the driver process started | `recordGateDriveSpawn` in `packages/drive/src/io/gate.js` |
| `admitted` | `unstarted` | spawn failed; lease released | `endGateDriveUnstarted` in `packages/drive/src/io/gate.js` |
| `spawned` | `captured` | candidate and base resolved to trees | `driveOnce` in `packages/drive/src/io/once.js` |
| `captured` | `running` | source sent, gate started | `driveOnce` in `packages/drive/src/io/once.js` |
| `running` | `gate.progress` | every 30 s while the gate runs; resets the stall clock | `attemptGate` in `packages/drive/src/io/once.js` |
| `running` | `gate.stalled` | no step for GATE_STALL_MS | `attemptGate` in `packages/drive/src/io/once.js` |
| `running` | `collected` | the gate returned, or GATE_INFRA_EXHAUSTED after one stall retry | `driveOnce` in `packages/drive/src/io/once.js` |
| `collected` | `verdict` | the receipt cell judges; lease released | `recordJobRow` in `packages/drive/src/io/once.js` |
| `verdict` | `done` | after completeSubmitHandoff | `driveSubmitHandoff` in `apps/cli/src/io/submit/handoff/worker.js` |
| `running` | (lease freed, not done) | SIGTERM, SIGINT or the dispatcher lifeline ends | `driveSubmitHandoff` in `apps/cli/src/io/submit/handoff/worker.js` |

#### `dispatcher`: gate dispatcher

- **Id:** `dispatcher`. Created by `ensureDispatcher` in `packages/drive/src/io/dispatcher.js`.
- **Serves:** no item: one per machine while tickets wait or drivers run.
- **States:** `dispatcher.spawned`. Terminal: none (released, never done).
- **Lease:** LEASE_MS 120 s; renewed every 5 s per pass; released when the queue empties; never done.
- **Ends when its item moves on:** violated (gap SM1), at `startWorker` in `packages/resources/src/io/handoff/worker/cap.js`: launches every waiting ticket with no read of its item
- **Harness:** `apps/cli/journeys/handoff/dispatcher/relaunch.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (lapsed) | `dispatcher.spawned` | submit, next or claim ensures it; takes the row only where the lease lapsed | `ensureDispatcher` in `packages/drive/src/io/dispatcher.js` |
| `dispatcher.spawned` | `dispatcher.spawned` | each pass renews, or retakes a lapsed row | `renewDispatcher` in `packages/drive/src/io/dispatcher.js` |
| `dispatcher.spawned` | (released) | queue empty or failure | `gateDispatcherRow` in `packages/drive/src/io/gate/admission.js` |

#### `review`: review reservation

- **Id:** `review:<item>`. Created by `reserveReview` in `packages/jobs/src/io/review.js`.
- **Serves:** item submitted at the reserved commit and digest, reserved by this reviewer.
- **States:** `reserved`, `lapsed`, `released`. Terminal: none (released, never done).
- **Lease:** LEASE_MS 120 s on the job; item_review_until follows the reviewLease setting (30 m); renewed only when the same reviewer reserves again; extended by a sweep while the reviewer heartbeats.
- **Ends when its item moves on:** violated (gap SM5), at `sweepLapsedReviews` in `packages/store/src/io/board/review/lease.js`: no verdict, withdraw or reopen releases the job; reclaimLapsedReviews extends the lease while the reviewer heartbeats whatever the item's state
- **Harness:** `packages/moves/tests/logic/moves/reserveNextReview/durable.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `reserved` | next --verify reserves | `reserveReview` in `packages/jobs/src/io/review.js` |
| `reserved` | `reserved` | the same reviewer reserves again | `renewReview` in `packages/jobs/src/io/review.js` |
| `reserved` | `lapsed` | a sweep finds the lease lapsed and the reviewer silent | `reclaimLapsedReviews` in `packages/jobs/src/io/review.js` |
| `reserved` | `released` | another reviewer takes it over | `releaseReview` in `packages/jobs/src/io/review.js` |

#### `landing-run`: landing run

- **Id:** `land:run:<uuid>`. Created by `driveLanding` in `packages/drive/src/io/landing.js`.
- **Serves:** the verified, unmerged items of one landing pass.
- **States:** `started`, `finished`, `failed`, `done`. Terminal: `done`.
- **Lease:** LEASE_MS 120 s renewed every 5 s until the run returns; LANDING_STALL_MS 10 min without progress stalls it.
- **Ends when its item moves on:** held, at `mergeGroup` in `packages/landing/src/io/step/merge.js`: the job never reads items, but every landing step re-checks verified at the commit (selection, merge, trunk, publish)
- **Harness:** `apps/cli/journeys/verify/landing/drill.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `started` | automatic landing or pullboard land | `driveLanding` in `packages/drive/src/io/landing.js` |
| `started` | `finished` | the run returned; then done | `driveLanding` in `packages/drive/src/io/landing.js` |
| `started` | `failed` | LAND_STALLED or a throw; lease released, never done | `driveLanding` in `packages/drive/src/io/landing.js` |

#### `landing`: landing finish sequence

- **Id:** `land:batch:<batch> or land:merged:<ids>:<commit>`. Created by `landBatch` in `packages/land/src/io/runs.js`.
- **Serves:** the batch's verified items at their recorded commits.
- **States:** `select`, `compose`, `prove`, `merge`, `record`, `publish`, `done`. Terminal: `done`.
- **Lease:** taken or renewed between steps; LAND_PROOF_NOT_GREEN and JOB_LEASED leave the lease to lapse with no done.
- **Ends when its item moves on:** partial, at `landMerged` in `packages/land/src/io/runs.js`: the batch steps check items; landMerged relies on its caller's check
- **Harness:** `apps/lib/tests/durable/land/done.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `select` | a batch or pullboard merged starts the sequence | `finishSequence` in `packages/land/src/io/sequence.js` |
| `select` | `compose` | next step | `finishSequence` in `packages/land/src/io/sequence.js` |
| `compose` | `prove` | next step | `finishSequence` in `packages/land/src/io/sequence.js` |
| `prove` | `merge` | proof green | `finishSequence` in `packages/land/src/io/sequence.js` |
| `merge` | `record` | next step | `finishSequence` in `packages/land/src/io/sequence.js` |
| `record` | `publish` | next step | `finishSequence` in `packages/land/src/io/sequence.js` |
| `publish` | `done` | finished | `finishSequence` in `packages/land/src/io/sequence.js` |

#### `main-test`: main-red comparison

- **Id:** `main-test:<key>`. Created by `mainRedLookup` in `packages/drive/src/io/main/red.js`.
- **Serves:** no item: main's tree and one test file.
- **States:** `queued`, `offered`, `unoffered`, `receipt`. Terminal: `receipt`.
- **Lease:** none.
- **Ends when its item moves on:** n/a, at `mainRedLookup` in `packages/drive/src/io/main/red.js`: keyed by tree; no driver ends a job queued by receiptComparison
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `queued` | a red file is looked up on main | `receiptComparison` in `packages/landing/src/io/main/red/receipt.js` |
| `queued` | `offered` | the recheck offers the queued file to a runner | `offerMainTests` in `packages/api/src/io/recheck.js` |
| `queued` | `unoffered` | the queued tree is not among trunk's recent commits | `offerMainTests` in `packages/api/src/io/recheck.js` |
| `queued` | `receipt` | submit returns a main test result | `returnMainTest` in `packages/gate/src/io/main/verdict.js` |

#### `gate-verdict`: main-owned gate verdict

- **Id:** `gate-verdict:<item>:<candidate>`. Created by `recordGateVerdict` in `packages/gate/src/io/main/verdict.js`.
- **Serves:** item submitted at the candidate, waiting on main's own test result.
- **States:** `awaiting-main`, `verdict`. Terminal: `verdict`.
- **Lease:** none; finished on each dispatcher pass (5 s).
- **Ends when its item moves on:** violated (gap SM16), at `finishAwaitingVerdicts` in `packages/gate/src/io/main/verdict.js`: no item check
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `awaiting-main` | a gate red only where main is red | `recordGateVerdict` in `packages/gate/src/io/main/verdict.js` |
| `awaiting-main` | `verdict` | main's result arrives | `finishAwaitingVerdicts` in `packages/gate/src/io/main/verdict.js` |

#### `flake-diagnose`: flake diagnosis

- **Id:** `flakeDiagnoseKey(tree, file, case)`. Created by `queueFlakeDiagnoses` in `packages/drive/src/io/diagnose.js`.
- **Serves:** a finished gate's verdict.
- **States:** `queued`, `diagnosed`, `attached`. Terminal: `attached`.
- **Lease:** released when finished.
- **Ends when its item moves on:** n/a, at `finishFlakeDiagnose` in `packages/drive/src/io/diagnose.js`: runs after the verdict; never changes the item
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `queued` | a verdict with flaky tests | `queueFlakeDiagnoses` in `packages/drive/src/io/diagnose.js` |
| `queued` | `diagnosed` | diagnosis done | `finishFlakeDiagnose` in `packages/drive/src/io/diagnose.js` |
| `diagnosed` | `attached` | attached to the item | `finishFlakeDiagnose` in `packages/drive/src/io/diagnose.js` |

#### `cells-inventory`: keyed derived result

- **Id:** `<kind>:<tree>`. Created by `keyedResult` in `packages/drive/src/io/keyed.js`.
- **Serves:** no item: a tree id.
- **States:** `produce.started`, `part.<name>`, `result`. Terminal: `result`.
- **Lease:** LEASE_MS 120 s renewed every 5 s until produce settles, with no stall bound.
- **Ends when its item moves on:** n/a, at `produceUnderLease` in `packages/drive/src/io/keyed.js`: keyed by content
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `produce.started` | the first reader takes the lease | `produceUnderLease` in `packages/drive/src/io/keyed.js` |
| `produce.started` | `result` | produce returned | `produceUnderLease` in `packages/drive/src/io/keyed.js` |

#### `test-run`: queued test run

- **Id:** `test-run:<uuid>`. Created by `queueTestRun` in `packages/drive/src/io/queue.js`.
- **Serves:** no item that it ends: the seat that queued it, and an optional item for display.
- **States:** `queued`, `running`, `result`, `lost`, `cancelled`, `delivered`. Terminal: `delivered`.
- **Lease:** LEASE_MS 120 s, taken by the worker and renewed every RENEW_MS; a worker that dies stops renewing and the run is reported lost 2 minutes later.
- **Ends when its item moves on:** n/a, at `workTestRun` in `packages/drive/src/io/queue.js`: serves the queuing seat, never an item state; no driver ends it on an item move
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `queued` | pullboard test queues a run and starts its detached worker | `queueTestRun` in `packages/drive/src/io/queue.js` |
| `queued` | `running` | the worker takes the lease | `workTestRun` in `packages/drive/src/io/queue.js` |
| `running` | `result` | the work returned or failed; lease released | `workTestRun` in `packages/drive/src/io/queue.js` |
| `running` | `lost` | the lease lapsed and the worker process is gone; lost step recorded and lease released | `endLostTestRuns` in `packages/drive/src/io/queue.js` |
| `result` | `delivered` | next hands the finished run to its seat once | `deliverTestRun` in `packages/drive/src/io/queue.js` |
| `queued` | `cancelled` | the seat cancels its run; the job ends and the worker group stops | `cancelTestRun` in `packages/drive/src/io/queue.js` |
| `lost` | `delivered` | next hands the lost run to its seat once | `deliverTestRun` in `packages/drive/src/io/queue.js` |

#### `land`: pulled landing job

- **Id:** `land:<items>:<key>`. Created by `offerLandingJob` in `packages/api/src/io/landing.js`.
- **Serves:** the landing's accepted items at the trunk sha they were accepted against; the runner re-checks each and the board applies the receipt.
- **States:** `request`, `offered`, `claimed`, `receipt`, `done`. Terminal: `done`.
- **Lease:** LEASE_MS 120 s taken by the claiming runner and renewed by it; a lapsed lease is claimable again with no sweeper.
- **Ends when its item moves on:** held, at `offerLandingJob` in `packages/api/src/io/landing.js`: the runner re-checks each item before it pushes and the board checks the permit on every renewal
- **Harness:** `apps/cli/journeys/runner/landing/guard.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `request` | the offer carries a request, recorded before it is offered | `offerJob` in `packages/api/src/io/jobs.js` |
| (none) | `offered` | the job is offered with the capabilities a runner needs | `offerLandingJob` in `packages/api/src/io/landing.js` |
| `offered` | `claimed` | a runner with every capability takes the lease | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `claimed` | a lapsed lease is taken by another runner, as the next attempt | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `receipt` | the holding runner posts its receipt | `postReceipt` in `packages/api/src/io/jobs.js` |
| `receipt` | `done` | the receipt is recorded and the lease released | `postReceipt` in `packages/api/src/io/jobs.js` |

#### `gate-shard`: pulled gate proof shard

- **Id:** `<gate job>:shard:<n>`. Created by `offerProofShards` in `packages/api/src/io/gate.js`.
- **Serves:** item submitted at the candidate, one slice of its proof files; the gate result applies when the last shard posts.
- **States:** `request`, `offered`, `claimed`, `receipt`, `done`. Terminal: `done`.
- **Lease:** LEASE_MS 120 s taken by the claiming runner and renewed by it; a lapsed lease is claimable again with no sweeper.
- **Ends when its item moves on:** n/a, at `offerProofShards` in `packages/api/src/io/gate.js`: a shard serves its gate job; the gate result applies once and a moved item refuses it
- **Harness:** NONE.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `request` | the offer carries a request, recorded before it is offered | `offerJob` in `packages/api/src/io/jobs.js` |
| (none) | `offered` | the job is offered with the capabilities a runner needs | `offerProofShards` in `packages/api/src/io/gate.js` |
| `offered` | `claimed` | a runner with every capability takes the lease | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `claimed` | a lapsed lease is taken by another runner, as the next attempt | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `receipt` | the holding runner posts its receipt | `postReceipt` in `packages/api/src/io/jobs.js` |
| `receipt` | `done` | the receipt is recorded and the lease released | `postReceipt` in `packages/api/src/io/jobs.js` |

#### `test`: pulled test run

- **Id:** `test:<commit>:<tag>`. Created by `offerTestJob` in `apps/cli/src/io/test/pull.js`.
- **Serves:** no item that it ends: the seat waiting on pullboard test; the board records the receipt and applies nothing.
- **States:** `request`, `offered`, `claimed`, `receipt`, `done`. Terminal: `done`.
- **Lease:** LEASE_MS 120 s taken by the claiming runner and renewed by it; a lapsed lease is claimable again with no sweeper.
- **Ends when its item moves on:** n/a, at `offerTestJob` in `apps/cli/src/io/test/pull.js`: serves the pulling runner's work; no driver ends it on an item move
- **Harness:** `apps/cli/journeys/runner/check.pull.test.js`.

| From | To | Trigger | Where |
|---|---|---|---|
| (none) | `request` | the offer carries a request, recorded before it is offered | `offerJob` in `packages/api/src/io/jobs.js` |
| (none) | `offered` | the job is offered with the capabilities a runner needs | `offerTestJob` in `apps/cli/src/io/test/pull.js` |
| `offered` | `claimed` | a runner with every capability takes the lease | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `claimed` | a lapsed lease is taken by another runner, as the next attempt | `claimJob` in `packages/api/src/io/jobs.js` |
| `claimed` | `receipt` | the holding runner posts its receipt | `postReceipt` in `packages/api/src/io/jobs.js` |
| `receipt` | `done` | the receipt is recorded and the lease released | `postReceipt` in `packages/api/src/io/jobs.js` |

#### Processes that are not job rows

| Process | What it does | Where | Serves | Harness |
|---|---|---|---|---|
| test-run | pullboard test --compare-main runs files on runners under a gate-slot lease; its queued run is the test-run job | `runTestFiles` in `packages/gate/src/io/test/run.js` | no item | `packages/gate/tests/fixtures/pipeline/e2e.js` |
| main-red refresh | refreshes main-red comparisons under a resource lease and a cache file; no job row | `refreshMainRedComparisons` in `packages/landing/src/io/main/red.js` | no item | NONE |
| sentinels | board sentinels run under an activeRun deadline of timeout + 10 s; no job row | `beginSentinelRun` in `packages/sentinels/src/io/main.js` | no item | NONE |
| seat heartbeat | a heartbeat row every 60 s; proves the seat alive and never selects or claims | `heartbeatSeat` in `packages/store/src/io/presence.js` | the seat | `apps/cli/journeys/heartbeat/presence.test.js` |
| claim heartbeat | re-claims or re-reserves at half the lease while a queued gate runs; stops with ITEM_LEASE_LOST when the item is no longer claimed or submitted by this seat at its digest and commit | `createQueuedItemLease` in `packages/git/src/io/lease.js` | item claimed or submitted by this seat | `apps/cli/journeys/gate/during/holds.test.js` |
| landing lease | board_meta landing_lease, 120 s, renewed every 5 s by the lander | `landingLeaseMove` in `packages/store/src/logic/board/landing/lease.js` | one lander per board | `apps/lib/tests/landing/lease.test.js` |
| automatic landing scheduler | a pending.json record; a crashed lander is recovered by the next command, sentinel or view | `recoverAutomaticLanding` in `packages/landing/src/io/automatic/scheduler.js` | verified, unmerged items | `apps/cli/journeys/verify/landing/drill.test.js` |

### 3. What `next` hands out

Branches run in this order. P runs once per command; B is plain `next`, `--build` and `--wait`; C is `next --take` (and plain `next` when a main-red repair routes there); D is `next --verify`; E is the idle end. Fresh says whether the hand-out is re-checked where it is printed: guarded means re-checked inside the write transaction that claims or reserves; advisory means nothing is written and the later claim or reserve is guarded; stale means it can name an item that is no longer in the state shown.

| # | Path | Inspects | Returns | Side effects | Hands out | Fresh | Where |
|---|---|---|---|---|---|---|---|
| P1 | all | lapsed leased gate jobs | nothing | DJ15 fallback: ends stale and idle legacy gate jobs, drives at most one by one transition within 1 s | nothing | n/a | `fallbackReclaim` in `apps/cli/src/io/reclaim.js` |
| P2 | builder | an undelivered red queued gate for this seat | red queued gate on #N; #N stays claimed by you until <lease> | records delivery | `claimed` | stale (gap SM13) | `queuedReds` in `packages/store/src/io/queued/red.js` |
| B1 | builder --wait | an unread shout that asks this seat to act on #N | a shout asks you to act on #N | marks the inbox read | `open`, `claimed`, `submitted` | stale (gap SM7) | `takeWaitShouts` in `packages/activity/src/io/shouts.js` |
| B2 | builder | an ownership wait in this lane | #N waits on your ownership of ... | none | nothing | fresh | `nextWithProgress` in `apps/cli/src/io/commands/next.js` |
| B3 | builder | open main-red items main already passes | nothing | withdraws them as coordinator | nothing | fresh | `closePassingMainReds` in `packages/sandbox/src/io/take.js` |
| B4 | builder | a routable main-red repair with no mandatory review | switches to the next --take path | none | nothing | fresh | `mainRedBuildOffer` in `packages/sandbox/src/io/take.js` |
| B5 | builder | this seat's dead queued or running hand-offs | nothing | retires them | nothing | fresh | `recoverOwnSubmitHandoffs` in `apps/cli/src/io/submit/handoff.js` |
| B6 | builder | a mandatory review (plain next) and no own claim | next to verify: #N; reserved for you until ... | reserves a review | `submitted` | guarded | `reserveWithin` in `packages/store/src/io/board/reserve/review.js` |
| B7 | builder | this seat's own claim | you hold #N | parks it on unmet deps; opens the item folder; never renews the lease | `claimed` | stale (gap SM6) | `nextOnce` in `apps/cli/src/io/next.js` |
| B8 | builder | a review worth offering beside a build | review offered: #N; build available: ... | none (advisory) | `submitted`, `open` | advisory | `sayReviewOffer` in `apps/cli/src/io/next/say.js` |
| B9 | builder | nothing picked, another lane's pick, or a route mismatch | idle reason | next-idle event | nothing | n/a | `otherLaneWork` in `packages/moves/src/io/selection.js` |
| B10 | builder | a light item with no diagnosis and a light seat active | diagnose #N | none (advisory) | `open` | advisory | `nextPick` in `packages/moves/src/io/selection.js` |
| B11 | builder --wait | the pick is still open | available #N; claim it when ready | does not claim | `open` | advisory | `nextOnce` in `apps/cli/src/io/next.js` |
| B12 | builder | a live item folder for the pick | skipped #N | omits it and retries | nothing | n/a | `liveFolderRefusal` in `apps/cli/src/io/item/folder.js` |
| B13 | builder | the pick | claimed #N with criterion, check, brief and any returned red | claims in one write transaction | `open`, lapsed claim | guarded | `claimOrdered` in `apps/cli/src/io/claim.js` |
| C1 | take | a mandatory review and no held build | next to verify: #N | reserves a review | `submitted` | guarded | `nextTake` in `packages/sandbox/src/io/take.js` |
| C2 | take | main-red build routing | claimed #N, or an offer to another seat, or a release request | claims, wakes a routed seat, or releases ROUTED_ELSEWHERE | `open` | guarded | `nextTake` in `packages/sandbox/src/io/take.js` |
| C3 | take | held claim, held review, any review, infra-stopped claim, then a build | you hold #N; next to verify; claimed #N | renews a held review; reserves; claims; a held claim is not renewed | `claimed`, `submitted`, `open` | stale (gap SM6) | `dispatchWork` in `packages/store/src/io/eligibility.js` |
| D1 | reviewer | submitted heads that conflict with trunk | returned #N to its builder unreviewed | reopens, or shouts the live review holder once | nothing | guarded | `returnUnmergeable` in `packages/verify/src/logic/next.js` |
| D2 | reviewer | next --verify N | next to verify: #N | reserves that review | `submitted` | guarded | `nextReview` in `packages/verify/src/logic/next.js` |
| D3 | reviewer | the best eligible review | next to verify: #N, reserved for you until ... | reserves after re-checking status, commit and digest | `submitted` | guarded | `reserveChosen` in `packages/store/src/io/board/reserve/next.js` |
| E1 | all | nothing to do | nothing for this seat: end your turn, or NOTHING_FREE, REVIEW_NOT_READY, NEXT_TIMEOUT | next-idle event; --wait sleeps on board and git file changes | nothing | n/a | `refuseNextIdle` in `apps/cli/src/io/next/steps.js` |

Every build claim and every review reservation is checked in one write transaction, so two seats never both win and no reviewer gets its own work. The stale branches only print: none of them writes a claim, but each can tell a seat to act on an item that has moved on.

### 4. What could happen

| Case | Today | Intended | Harness |
|---|---|---|---|
| two seats claim the same item | the claim move runs in one write transaction; the second gets HELD and next retries | same | `apps/cli/journeys/claim/race.test.js` |
| two reviewers reserve the same item | reserveChosen re-checks status, commit and digest inside the transaction; the second gets REVIEW_HELD and retries | same | `packages/store/tests/io/board/reserve/next.test.js` |
| a reviewer is offered its own work | notBuilder and the session skip list refuse it in the transaction (SELF_VERIFY) | same | `apps/cli/journeys/verify/machine.test.js` |
| dead seat holding a claim | the lease runs out; readers see open; the next write frees it with builder first refusal | same | `apps/cli/journeys/init/lapse.test.js` |
| heartbeat-only claim (seat alive, no work) | a live holder heartbeat vetoes expiry; idle maintenance releases it after health.stuck | a heartbeat proves the seat, never the work; an untouched claim frees after its idle window | `apps/cli/journeys/release/next/untouched.test.js` |
| dead reviewer | the review job lapses after 2 minutes and the item is offered again | same | `packages/moves/tests/logic/moves/reserveNextReview/durable.test.js` |
| red gate | the hand-off ends red; the builder keeps the claim with a renewed lease and next tells it once | same | `apps/cli/journeys/submit/handoff.test.js` |
| red notice after the claim lapsed | next still says the item stays claimed by you until a past time | the notice reads the live lease and says the claim lapsed | NONE |
| a red from an older head shown at claim | returnedRecord shows the newest red or infrastructure gate without matching the current commit | only a red at the item's current commit is shown | NONE |
| main moved while an item was in review | a clean move keeps the verdict; a real conflict reopens the item naming the file | same | `apps/cli/journeys/lifecycle/merge.test.js` |
| main moved after acceptance, before landing | the lander reopens a stale verdict to its lane with the file named | same | `apps/cli/journeys/reopen/landing/stale.test.js` |
| gate driver lease lost | a refused renewal retakes the lease on the next tick | same, but only while its item still is in its serving state | `apps/cli/journeys/handoff/dead/running.test.js` |
| gate driver killed | the gate is requeued on the same candidate within seconds, with no builder red | same | `packages/gate/tests/fixtures/pipeline/requeue.js` |
| live driver mistaken for dead | a sweep never declares a live, same-incarnation driver dead for a lapsed lease alone | same | `packages/gate/tests/fixtures/pipeline/driver.js` |
| runner lost mid-shard | the idle probe stops the orphan worker; the gate requeues with attempt + 1; three infrastructure stops end it | same | `packages/gate/tests/fixtures/pipeline/worker.js` |
| dispatcher down with queued gates | next and claim recover a dead dispatcher; status, show and whoami never do | same | `apps/cli/journeys/handoff/dispatcher/relaunch.test.js` |
| dispatcher on stale tools | it stops launching and hands over to one on current tooling within 45 s | same | `packages/gate/tests/fixtures/pipeline/dispatcher.js` |
| seat runs a stale CLI | a worktree runs the main checkout's current CLI | same | `apps/cli/journeys/worktree/current.test.js` |
| another machine's dispatcher sweeps this home | it never recovers this home's gates | same | `packages/gate/tests/fixtures/pipeline/sweep.js` |
| landing crash | killing the lander at any stage lets the next accept land both items without manual recovery | same | `apps/cli/journeys/verify/landing/drill.test.js` |
| two landers | the board landing lease admits one; a stalled relay cannot block the holder's heartbeat | same | `apps/lib/tests/landing/lease.test.js` |
| a reject or reopen during landing | every landing step re-checks verified at the commit, so the item drops out of the batch | same, proven between select and merge | `packages/gate/tests/fixtures/pipeline/a-reject-or-reopen-during-landing.js` |
| withdrawal mid-gate | the hand-off record ends withdrawn and its ticket is dropped, but a running driver is not stopped and runs to its verdict | the driver ends at its next renewal tick | `apps/cli/journeys/withdraw/handoff.test.js` |
| reopen or reject mid-gate | next skips a gate older than the reopen; the driver keeps running | the driver ends at its next renewal tick | `packages/store/tests/io/board/next/gate.test.js` |
| new head submitted while a gate runs | the old worker is signalled, its slot freed and the new head queued | same | `apps/cli/journeys/submit/replaces.test.js` |
| lapsed gate job whose item moved on (zombie) | a fallback pass ends legacy kind gate rows; kind gate-drive is never listed | every job kind ends at once when its item leaves its serving state | `apps/cli/journeys/gate/jobs.test.js` |
| review held on an item that was withdrawn or verified | the review job is not released; a heartbeating reviewer keeps extending it | a verdict, withdraw or reopen releases it in the same transaction | NONE |
| next resumes a claim that changed in the same moment | you hold #N prints from the read snapshot | re-read in the transaction that prints | NONE |
| a shout names an item this seat cannot act on | next --wait returns a shout asks you to act on #N for any item not verified or withdrawn | only an item this seat may claim, holds, or may review | NONE |
| pullboard merged run twice | the second overwrites item_merged_commit and logs a second merged event | refused ALREADY_MERGED unless it names the same commit | NONE |
| board restored from an export with an undeclared status | the import refuses it UNDECLARED_STATE before it inserts any row | same | `packages/gate/tests/fixtures/pipeline/board-restored-from-an-export-with-an-un.js` |
| queued main-test job never driven | stays queued with no end | driven or ended within its lease | NONE |
| landing run fails or its proof is not green | the job is lease-freed but never done; nothing lists it again | it ends failed and done | NONE |
| machine sleeps past every lease | every lease lapses at once; the next command's fallback and the dispatcher retake them | same, with no job driven for an item that moved on meanwhile | NONE |
| board write contention | a write holds the board lock under 1 s past slow commands, readers, gate workers and dead holders | same | `packages/gate/tests/fixtures/pipeline/board/write.js` |
| the P7 chaos test | SPEC P7 names test/durable-chaos-26.test.js as its gate; the file does not exist | the chaos test kills drivers at random and asserts each job finishes once | NONE |

### 5. Gaps

Ordered by severity. Each is a brief the coordinator can file as it stands; a test marked (new) does not exist yet.

- **SM1 (high): gate-drive jobs never check their item.** Files: `packages/drive/src/io/once.js`, `packages/drive/src/io/gate.js`, `apps/cli/src/io/submit/handoff/worker.js`. Test: test/gate-drive-serving-state.test.js (new). Criterion: A gate-drive job whose hand-off record is no longer queued or running, or whose item is not claimed by the hand-off's seat at its frozen digest, writes an ended step {stale:true}, is marked done and stops its gate at its next renewal tick; the dispatcher never admits such a ticket.
- **SM2 (high): the fallback lists only kind gate.** Files: `packages/drive/src/io/reclaim.js`, `apps/cli/src/io/reclaim.js`. Test: `apps/cli/journeys/gate/jobs.test.js`. Criterion: lapsedGateJobs lists kinds gate and gate-drive; a lapsed gate-drive job whose hand-off is ended, or whose item left its serving state, ends stale on the next next or status, never driven.
- **SM3 (high): a running hand-off resumes with no item check.** Files: `packages/store/src/io/submit/handoff/retry.js`, `apps/cli/src/io/submit/handoff/worker.js`. Test: `apps/cli/journeys/handoff/dead/running.test.js`. Criterion: startSubmitHandoff on a running record checks the item is claimed by the record's seat at its digest, as it does for a queued one, and refuses SUBMIT_HANDOFF_CHANGED otherwise; the worker then ends the job.
- **SM4 (high): the fallback's serving predicate is wrong for pre-submit gates.** Files: `apps/cli/src/io/reclaim.js`. Test: `apps/cli/journeys/gate/jobs.test.js`. Criterion: the active predicate takes the hand-off record: a queued or running gate serves claimed by its seat at its digest, and only a post-submit job serves submitted at its commit; a pre-submit gate for a claimed item is never ended stale.
- **SM5 (medium): review jobs outlive their item's review.** Files: `packages/jobs/src/io/review.js`, `packages/store/src/io/board/review/lease.js`, `packages/store/src/io/board/verify.js`. Test: `packages/moves/tests/logic/moves/reserveNextReview/durable.test.js`. Criterion: verify, withdraw and reopen release the item's review job (step released, done) in the same transaction; reclaimLapsedReviews never extends a lease whose item is not submitted.
- **SM6 (medium): next resumes a held claim from a snapshot.** Files: `apps/cli/src/io/next.js`, `packages/store/src/io/eligibility.js`. Test: test/next-held-claim-fresh.test.js (new). Criterion: next and next --take print you hold #N only after re-reading, in the board read that prints, that #N is claimed by this seat with a live lease; otherwise they fall through to selection.
- **SM7 (medium): next --wait shouts can hand out any item.** Files: `packages/activity/src/io/shouts.js`. Test: test/next-wait-shout-scope.test.js (new). Criterion: a shout ends next --wait with a shout asks you to act on #N only when #N is open in this seat's lane, claimed by this seat, or reservable by it; any other shout is printed and the wait continues.
- **SM8 (medium): landing jobs and freed gate drivers never reach done.** Files: `packages/drive/src/io/landing.js`, `packages/land/src/io/sequence.js`, `apps/cli/src/io/submit/handoff/worker.js`. Test: test/jobs-reach-done.test.js (new). Criterion: a failed landing run, a finish sequence stopped by LAND_PROOF_NOT_GREEN, and a gate driver freed by a signal each end with a failed or ended step and done, so no job row is left unowned and not done.
- **SM9 (medium): queued main-test jobs have no driver.** Files: `packages/landing/src/io/main/red/receipt.js`, `packages/drive/src/io/main/red.js`. Test: test/main-test-job-ends.test.js (new). Criterion: a main-test job queued by receiptComparison is driven to a receipt or ended within one dispatcher pass after its lease would lapse.
- **SM10 (medium): pullboard merged runs twice.** Files: `packages/store/src/io/board/merged.js`. Test: test/merged-twice.test.js (new). Criterion: merged on an item that already has item_merged_commit refuses ALREADY_MERGED unless it names the same commit, which writes nothing.
- **SM11 (medium): reland is an undeclared move.** Files: `packages/store/src/logic/board/reland.js`, `packages/state/src/logic/machine/declaration.js`. Test: `apps/cli/journeys/verify/machine.test.js`. Criterion: reland is declared in MOVES with its guards and a real proof check, and docs/lifecycle.md shows it.
- **SM12 (medium): machine acceptance skips the accept guards.** Files: `packages/verify/src/io/machine.js`. Test: test/machine-verification-guards.test.js (new). Criterion: acceptMachineSubmission passes the accept move's state and notBuilder checks, and refuses NOT_SUBMITTED for an item that left submitted.
- **SM13 (low): the red notice ignores a lapsed claim.** Files: `packages/store/src/io/queued/red.js`. Test: test/queued-red-notice-lease.test.js (new). Criterion: queuedReds reads the item through current(), and the notice says the claim lapsed when it did.
- **SM14 (low): a returned red is not tied to the current head.** Files: `packages/store/src/io/board/next.js`. Test: test/next-returned-red-head.test.js (new). Criterion: returnedRecord shows a red or infrastructure gate only when its commit and digest match the item's current head.
- **SM15 (low): board import accepts undeclared statuses.** Files: `packages/store/src/io/exchange.js`. Test: test/import-undeclared-status.test.js (new). Criterion: restoreDocument refuses UNDECLARED_STATE for any item_status not in STATES before it inserts.
- **SM16 (low): gate-verdict jobs never check their item.** Files: `packages/gate/src/io/main/verdict.js`. Test: test/gate-verdict-item-state.test.js (new). Criterion: finishAwaitingVerdicts ends a job whose item is no longer submitted at its candidate with a withdrawn step and writes no verdict.
- **SM17 (low): the P7 chaos gate is missing.** Files: test/durable-chaos-26.test.js (new). Test: test/durable-chaos-26.test.js (new). Criterion: the chaos test SPEC P7 names exists: it kills drivers and runner channels at random points and asserts every job finishes exactly once.
