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

The relay signs people in through a GitHub App whose only permission is repository Metadata, read-only (`githubAppManifest` in `relay/github.js`). It refuses a GitHub token that carries OAuth App scopes (`tokenResult` in `relay/github.js`). The GitHub user token is used once to learn the account's numeric id and login; only that id and login are stored (`signedIn` in `relay/auth.js`).

The relay asks GitHub for the person's repository role on every write, and caches read checks for under ten minutes (`access` and `ACCESS_WINDOW_MS` in `relay/auth.js`). It pins the repository's numeric id when a board is linked, so a different repository that takes the same name inherits nothing.

Browser sign-in uses one-use state, PKCE and a binding cookie (`beginWeb` and `finishWeb` in `relay/auth.js`). The session cookie, `pb_session`, is HttpOnly and SameSite=Lax, and Secure over HTTPS (`relay/auth-http.js`). The CLI signs in with GitHub's device flow. From an SSH shell, the relay first shows a page naming the board folder and the machine's host name, and the board links only after the person confirms it there (`beginDevice` and `confirmDevice` in `relay/auth.js`, `relayOn` in `src/relay.js`).

### Machines, agents, grants and devices hold Pullboard credentials

On top of the GitHub identity, the relay issues its own credentials. Each one is a prefix and 32 random bytes (`random` in `relay/auth.js`). The relay keeps only a SHA-256 hash of each, and checks expiry and revocation on every use (`issue` and `credential` in `relay/auth.js`).

| Credential | Who holds it | What it can do | Lifetime |
| --- | --- | --- | --- |
| `ps_` person session | The phone, in the `pb_session` cookie. The CLI holds one in memory while it links a board, and clears any saved copy (`loadLink` in `src/relay.js`). | Everything the person's GitHub role allows: link boards, issue `pm_` and `pa_`, approve phone requests, make person-only moves. | 7 days |
| `pm_` machine credential | One per board per machine, in `<git common dir>/pullboard/relay.json`, mode 600 (`linkFile` in `src/relay.js`). | Upload snapshots, register agent seats, publish phone approvals, upload key wraps for paired devices, issue `pa_` tokens and spend a `pg_` grant. It cannot make person-only moves. | 30 days |
| `pa_` agent token | One per agent seat, cached in `relay.json` or supplied as `PULLBOARD_RELAY_TOKEN` (`actorTransport` in `src/relay.js`). | Moves on one board as one named agent. | 1 day by default, 30 at most |
| `pg_` action grant | Issued to the phone after the person taps approve, then sealed to the machine's in-memory reply key (`nativePhoneAction` in `src/relay-phone.js`). | One exact native action, such as revoking a device or a token or deleting the relay copy, bound to its approval context. | 120 seconds at most, one use |
| `pd_` sign-in ticket | The CLI, during a device sign-in. The relay keeps its hash in memory. | Poll for or cancel one pending sign-in. | GitHub's device-code lifetime |
| `pc_` confirmation ticket | The person's browser, in the fragment of the confirmation link. The relay keeps its hash in memory. | Confirm or decline one board link. | The sign-in, plus 10 minutes after GitHub confirms |

A person session can revoke any of its account's credentials through `POST /auth/tokens/revoke`; a machine or agent credential can revoke only itself (`revoke` in `relay/auth.js`). Deleting a board's relay copy, or letting it expire, deletes every credential bound to it (`forgetBoard` in `relay/auth.js`). The relay keeps the hashes of the ones still live until they would have expired, so a machine that uses one later hears that the relay copy was deleted and keeps working locally.

The relay labels each record with a sender taken from the credential that sent it, and ignores any sender named in the request (`sender` in `relay/service.js`). Every client refuses a record its sender may not make: a machine credential may send snapshots, seat registrations, the coordinator seat and phone-approved moves, and an agent may act only as itself (`relaySenderProblem` in `src/relay-sender.js`). On the machine, a terminal that carries an agent marker or an SSH marker cannot take person actions, and the person uses the view or the phone instead (`requirePersonChannel` in `src/person.js`).

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
| `relay_action_grants` | `auth.sqlite` | Per approved action: grant hash, request id, account, the full approval context in clear, expiry, used flag. | No deletion path. |
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
| `journal_record` | `boards/<board>.journal.sqlite` | Per record: sequence, arrival time, kind (move or request), sealed payload, sender kind, sender account, agent or machine name. | The next snapshot covers it. |
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

Once a day the relay copies each journal into `backups/` and keeps each copy for 14 days; deleting a board deletes its copies at once (`relay/retention.js`). After 60 days without activity the relay warns on the next contact, and at 90 days it deletes the board.

Some state lives only in memory and ends with the process: machine-to-machine pairing packages, pending sign-ins with their GitHub device codes and board confirmations, GitHub App installation tokens, and the read-permission cache (`relay/pairing-store.js`, `relay/auth.js`, `relay/github.js`).

## What the relay can read

The relay sees who and when. It knows every GitHub account that signs in, every linked repository name, and for each record its sequence, arrival time, size, kind and sender: the person's account, a machine's id (`machine-` and a random UUID, from `src/relay-machine.js`) or an agent's seat name. From those it can tell how active each board is and which agents work on it. It knows which phones are paired to which account and which boards each phone has keys for, along with each phone's public key and its label, `Phone browser`. Like any web service, it receives the network address of every request.

It also reads phone approvals. A machine publishes each approval with its context in clear: account, boards, device, action, target (a repository name, device id or token id), machine id, the exact command text and the expiry (`approvalContext` in `src/relay-approval.js`). The relay keeps that context in `phone_approval` and again in `relay_action_grants`. When a board is linked from an SSH shell, the relay holds the machine's host name and the board's folder name in memory to show on the confirmation page.

## What only your devices can read

Board contents travel sealed: items, criteria, shouts, verdicts and spec rows. The machine seals each snapshot, move and request with AES-256-GCM under the board key, and the associated data binds the board id, the sequence and the kind (`seal` in `src/seal.js`). The relay checks only that a payload is canonical base64url, then stores the bytes unparsed (`sealed` in `relay/service.js`, `relay/journal.js`). Your repository's code stays on your machine; only board records go to the relay.

The relay never receives a board key in a form it can use. A phone gets it wrapped to the phone's own ECDH key, and another machine gets it sealed under a secret that exists only in the printed pairing code. The pairing secrets themselves stay off the relay: the phone's secret rides in the link's fragment, which the browser never sends (`relay/browser-devices.js`).

## How pairing moves the board key

**Linking a board.** `pullboard relay on` makes a 256-bit board key on the machine and keeps it in `~/.pullboard/relay-keys/<board>.key`, mode 600 (`generateBoardKey` in `src/seal.js`, `storeBoardKey` in `src/relay-key.js`). The person signs in and the relay records the link. The machine receives its `pm_` and uploads the board's first sealed snapshot.

**Pairing a phone.** The machine makes a one-time locator and secret, keeps the secret in its private `relay-machine/state.json`, and shows both in a QR code (`beginDeviceEnrollment` in `src/relay-machine.js`). The phone makes an ECDH P-256 key pair whose private half cannot be exported, and keeps it in IndexedDB (`createDeviceKeys` in `src/relay-device-keys.js`). It signs its public key with an HMAC derived from the secret and posts it through the relay (`signDeviceEnrollment`). The machine checks that MAC before it trusts the key, so the relay cannot slip in a key of its own (`acceptDeviceEnrollment` in `src/relay-machine.js`). The machine then wraps the board key to the public key it recorded itself (`wrapForRecordedDevice`) and uploads the wrap with its `pm_`. It wraps again on every sync (`deliverDeviceWraps` in `src/relay.js`). The phone unwraps it with its private key and keeps the board key in `localStorage` (`deviceBoardKeys` in `relay/browser-devices.js`, `relay/browser-client.js`).

**Pairing another machine.** `pullboard relay pair` prints a code made of the board id, a locator and a 256-bit secret. The machine seals the board key and a snapshot under that secret and posts the package (`sealPairingBundle` in `src/pairing.js`). The relay holds it in memory for ten minutes and hands it out once, to a caller who can read the board (`relay/pairing-store.js`, `relay/pairing-http.js`).

**Phone approvals.** For a native action that needs the person, such as revoking a device, the machine publishes the context and a sealed intent, authenticated with an HMAC under the board key so the relay cannot invent one (`phoneProposal` in `src/relay-phone.js`). The intent also carries the machine's host name and the board's name, sealed, so the phone can show them and the relay cannot read or change them (`proposalNames` in `src/relay-phone.js`). The phone shows the request. On a tap the relay issues a `pg_`; the phone seals it to the machine's in-memory reply key, and the machine spends it once (`issueActionGrant` and `consumeActionGrant` in `relay/auth.js`).

**One order for every move.** The relay gives each record the next sequence number atomically and refuses repeats and gaps (`insert` in `relay/journal.js`). Every client applies records in that order with the CLI's own rules.

## Redeploys

A new relay process on the same `/data` volume keeps every account, link, credential hash, paired phone, wrapped key, approval and journal; `test/relay-deploy.test.js` restarts the relay and proves that no one re-pairs. A restart ends what lives only in memory, so a half-finished sign-in or pairing starts again. The service runs as a single replica, since one writer owns these SQLite files (`relay/README.md`).

A phone pairs again when its browser storage is cleared, when it signs in as another account, or when the device is revoked. The hosted page can be installed to the Home Screen and asks the browser to keep its storage, since Safari on iPhone can clear a site's storage after seven days without a visit (`relay/browser-install.js`).

## Honest limits

The relay sees metadata. The section on what it can read lists all of it: accounts, repository names, record sizes and timing, seat names, machine ids, which phones hold which boards, and network addresses.

A compromised relay could serve a compromised page. Every script the phone runs comes from the relay (`relay/browser-page.js`), and nothing outside the relay pins or signs that code. Such a page could read the board keys the phone keeps in `localStorage`.

Approval context is in clear. The relay reads each requested action, its target, the machine id and the command text, and keeps them with no deletion path.

The sender of a record is the relay's word. The seal binds the board, the sequence and the kind, and leaves the sender outside it (`src/seal.js`), so a compromised relay could relabel a validly sealed move. The device key only agrees keys: it cannot sign, and no passcode or Face ID guards it. A phone approval proves a tap in a browser that holds the session cookie.

Agents on a machine share what is on disk. Every agent runs as the same operating-system user, so any of them can read the board key file and `relay.json`. The `pm_` there can issue a `pa_` for any seat name the relay is given (`issueToken` in `relay/auth.js`), and only the client checks that the name is a registered seat (`actorTransport` in `src/relay.js`).

Revoking a phone stops new wraps and deletes its stored ones, and the board keys it already received stay usable to whoever holds them. Board key rotation is a separate step.

Some rows have no deletion path: `relay_users`, `relay_action_grants`, `phone_approval`, `person_enrollment` and the `device` tombstones. A board that expires for inactivity leaves its `wrapped_key` rows behind.

RFC 0004 describes keeping the board key in the operating system's keychain. The code keeps it in a mode-600 file and moves any older keychain copy into that file (`src/relay-key.js`).
