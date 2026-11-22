# Design: accounts sign-in and recovery, without pairing

Status: a design for #1252 (part of #1007). The person decided on 22 Nov that it ships in 0.9.5 as this page only. The screen, the vault endpoint and the flows below are not built. Each part is marked **built** (with the files that hold it) or **proposal**.

The "accounts-three-uses" design named on #1252's hold is not a file in this repo. This page does not restate it; it covers the sign-in chain that hold names (passkey vault, vault endpoint, recovery).

## The goal

A person signs in with GitHub on any browser, phone included, and every board linked to their account appears. No pairing step, no QR code, no terminal command, no device id. A browser that loses its storage regains access by signing in again. The relay still cannot read a board.

Today a phone pairs by QR code or link from a terminal (`docs/architecture.md`, "How pairing moves the board key"). That is what this design replaces.

## What exists today

| Piece | State | Where |
|---|---|---|
| GitHub sign-in on the relay (web and device flows), sessions kept as hashes, roles read from GitHub | built | `apps/relay/src/io/auth.js`, `apps/relay/src/io/github.js`, `apps/relay/src/io/auth/http.js` |
| Passkey registration and person grants over HTTP, session-only, refusing URL queries | built | `apps/relay/src/logic/http/passkey.js`, `apps/relay/src/io/passkeys.js` |
| 32-byte passkey PRF secret read from the credential, with refusals | built | `apps/relay/src/logic/browser/prf.js`, `prf-binding.js` |
| Credential vault: a signing root sealed under the PRF secret and, separately, under a recovery key | built as library code only | `packages/person/src/logic/vault.js`, proved by `packages/keys/tests/io/relay/enrollment.test.js` with a synthetic PRF input |
| Person-only moves signed with a passkey tap (#408) | built | `CHANGELOG.md` entry citing #343, #408, #1135; `packages/person/src/io/signing` |
| Board key wrapped to a phone's own key; pairing codes between machines | built | `docs/architecture.md`; `packages/person/src/io/pairing.js` |
| `pullboard relay revoke <device>` stops future key delivery | built | `apps/cli/src/logic/help/setup.js` |

I found no caller of `createCredentialVault` or `openCredentialVault` outside the person light door and the enrollment test. No served screen, no vault endpoint, and no recovery screen exist. The test #1252 names, `apps/view/tests/cockpit/account-setup.test.js`, is not in the repo.

## Flow 1: GitHub identity join

**Proposal.** The served page (phone or desktop) starts GitHub sign-in. The relay learns the immutable GitHub user id and login, drops the GitHub access credential at once, and opens a relay session. The page then lists the boards linked to that account.

- Built: the sign-in itself, the identity check and the immediate drop of the user token (`auth.js`, around the "Learn the immutable GitHub identity" function).
- Proposal: listing every linked board with no pairing step, and joining that identity to the unlock below.

GitHub proves who the person is. It never unlocks a board. A signed-in session with no credential sees board names the relay already knows, and no contents.

## Flow 2: verified credential unlock

**Proposal for the flow; built for the cryptography.**

1. The person taps a passkey on the device. The page reads the 32-byte PRF output.
2. The page fetches the account's vault record from the relay and opens the credential wrap with the PRF output, against the account, revision and public root the page already pins.
3. Opening proves the root by signing and verifying a probe, so a wrong or swapped vault is refused, not trusted.
4. The restored root is a non-extractable key held in the browser.

Built: steps 1 (PRF read), and 2 to 4 as `openCredentialVault`. The vault holds only ciphertext and public metadata, capped at 2048 bytes, so an untrusted relay can store it (`serializeCredentialVault`). The credential wrap and the recovery wrap use separate key ids, so one cannot open the other.

Proposal: the vault endpoint that stores and returns the record, the first-time vault creation on the page, and the screen. The endpoint must follow the same rule as the passkey routes: person session only, no data in the URL.

## Flow 3: native bootstrap (#408)

**Proposal for how it is used; built for the signing.**

Moves only a person may make are signed with a passkey tap (#408). After sign-in, the first native action on a new device is the bootstrap: the page proves the restored root can sign, and the account's public root is pinned for that device. Later person-only moves use the same signing path.

Built: person-only signing (#408). Proposal: making the vault root the identity the bootstrap pins on a device that never paired. This design does not change what #408 signs.

## Flow 4: the recovery key, shown once, kept outside Pullboard

**Proposal for the screen; built for the key.**

Built: `createCredentialVault` makes a random 32-byte recovery key, seals the root under it, and returns it to the caller next to the vault. The vault itself stores only the sealed wrap. Pullboard cannot recover the key from the vault.

Proposal:

- The page shows the key once, at account setup, and asks the person to save it somewhere Pullboard does not hold (a password manager or paper).
- The page confirms the save by asking for the key back before it finishes setup. It does not keep a copy.
- After that screen the key is gone from memory. The relay, the host and the board never see it.
- Losing both the passkey and the recovery key means the vault cannot be opened. Pullboard cannot reset it. The page says so before setup completes.
- Using the recovery key opens the recovery wrap (`openCredentialVault` with mode `recovery`). Then the page asks the person to register a new passkey and seals a new credential wrap. Rotation is a revision change, a proposal that needs its own bar.

## Flow 5: one online trusted key holder

**Proposal.**

Board keys never reach the relay in a usable form. A new device therefore needs one machine of the person's, online, that already holds the board key. That machine wraps the key to the new device's own key, as it does for a paired phone today (`docs/architecture.md`).

- Built: wrapping a board key to a device's own key, and the relay storing only the wrapped result.
- Proposal: the holder wraps for a newly signed-in device automatically, after the person's unlock proves the device's key, without a pairing code.
- Proposal: if no holder is online, the device waits and says why. It does not retry in a loop and does not ask for a pairing step.
- Recovering after total storage loss needs the same holder. The credential or recovery key restores the identity. A holder supplies the board keys. With no holder, the identity returns but the boards stay sealed, and the screen says that.

## Flow 6: new-device notices with revoke

**Proposal for the notice; built for revoke.**

- Built: `pullboard relay revoke <device>` stops future key delivery. Keys a device already received stay known to it; the help text says so, and this page does not claim otherwise.
- Built: a phone approval for native actions such as revoking a device (`docs/architecture.md`, "Phone approvals").
- Proposal: every machine and open page shows a "new device joined" notice with the device name, the time and the sign-in method, plus a revoke action next to it.
- Proposal: revoking also ends that device's relay session and withdraws any wrapped key the relay still holds for it. Revoking cannot take back a board key a device already holds. Where a key may have leaked, the person rotates the board key. That is a separate step and the notice says so.

## Flow 7: no secret material in logs, CLI output or URLs

**Mostly proposal; the existing pieces are built.**

Rules for every part of this design:

- The PRF output, the recovery key, the root scalar, board keys and wrapped-key plaintext never appear in a log line, a refusal message, CLI output, an error report or a URL.
- Secrets that must travel in a link ride in the fragment, which the browser does not send (the confirmation ticket in `apps/relay/src/io/auth/http.js` is the built example).
- Built: the passkey routes refuse any URL query (`passkey.js`), and the vault's refusal text is fixed and names no material (`vault.js`). The vault clears its secret and scalar buffers after use.
- Proposal: a test that signs in, creates a vault, recovers and revokes while scanning captured logs, CLI output and request URLs for the secrets used. A bar for the build must name it.

## Flow 8: clear refusals

A missing holder or credential must refuse with a message that says what to do. It must not look like a crash or an empty list.

| Case | State | Code and text |
|---|---|---|
| Passkey returns no PRF secret | built | `PRF_MISSING`: use a passkey that supports it (`prf.js`) |
| PRF secret is not 32 bytes | built | `PRF_LENGTH` (`prf.js`) |
| Wrong credential, wrong recovery key, or a changed vault | built | `PERSON_VAULT_AUTH`: use the original credential or saved recovery key (`vault.js`, `packages/state/src/logic/defaults.js`) |
| Session expired or device revoked | built | `AUTH_REQUIRED` (`auth.js`), `DEVICE_REVOKED` (`browser/page.js`, `store/device.js`) |
| No online key holder | proposal | a new code, to be named in the build item, saying to open Pullboard on a machine that holds the board |
| No credential and no recovery key | proposal | a new code saying the vault cannot be opened and Pullboard cannot reset it |

New codes need their recovery text in `packages/state/src/logic/defaults.js`, like the built ones.

## What the build item must prove

#1252 keeps its bar: a real browser, HTTP and crypto prove that the original boards open after storage loss, without pairing, in `apps/view/tests/cockpit/account-setup.test.js`. This page does not build that case. #1250 and #1251 come first, and #1007 also retires QR pairing from the hosted pages and docs, which waits until this works.

## Open questions

- Where the vault record lives on the relay, and how a changed revision is announced.
- Whether a device without PRF support gets a recovery-key-only path or a refusal.
- How the board key rotates after a revoke, and who is asked.
