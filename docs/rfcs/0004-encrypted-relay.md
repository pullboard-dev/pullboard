# RFC 0004: An encrypted relay, and what it keeps

- Status: accepted, 7 October 2026
- Proposed: 7 October 2026, by Corey Olson
- Amends: RFC 0002 (the relay). Rows: A4, H4 (retired into H16), H5, H15 to H18

## Summary

pullboard.dev can't read the boards it relays. The CLI seals every move and every snapshot of a board with a key that never leaves the person's devices; the relay stores and orders sealed blobs it can't open. The relay keeps a board only while it is linked, and briefly after.

## Sealed boards

`pullboard relay on` makes a board key and keeps it on the machine: in the operating system's keychain where there is one, otherwise in `~/.pullboard`, readable only by its user. Before anything leaves the machine, the CLI seals it with that key: each move, each request and each snapshot of the board's state. The relay sees a board id, a GitHub repository (to check who may reach it), who signs in, and when sealed blobs arrive and how large they are. It never sees what they say.

The relay still puts moves in one order (H3). It can't check a move it can't read, so every client does: each CLI applies the moves in the relay's order with the CLI's own engine, so each refuses exactly what the CLI refuses, and a claim is still won once, everywhere. A CLI learns whether its move applied by reading the order back. Clients refuse a sealed move from a newer engine than theirs, naming the version, rather than guess.

## Pairing

A device that can read a board holds its key. A linked machine hands the key to a new device without letting the relay read it:

- **A phone or a browser:** `pullboard relay on` and `pullboard relay pair` print a QR code and a link to app.pullboard.dev with the key after the `#`. Browsers never send that part of an address to a server. The page reads the key there, keeps it in the browser, and unseals the board on the device.
- **Another machine:** `pullboard relay pair` prints a code carrying a single-use, expiring 256-bit secret. `pullboard relay join <code>` sends the key through the relay sealed under that secret; the secret never reaches the relay, so it can carry the key but cannot read it.
- **An agent that can't pair**, such as a cloud session: the key comes from an environment variable, beside its relay token.

Signing in with GitHub decides who may fetch a board's sealed blobs; holding the key decides who can read them. Both are needed.

A person never handles a key by hand. If every device loses it, nothing is lost: the local board is complete (H7), and `pullboard relay on` seals it again under a new key.

## What the relay keeps

- A board, only while it is linked. `pullboard relay off` deletes it from the relay at once.
- A linked board with no activity for 90 days is deleted, after notice to whoever linked it.
- Old moves fold into the latest sealed snapshot, so the relay doesn't keep a board's full history.
- Backups last 14 days.

## The honest limits

- The phone's page comes from app.pullboard.dev. A compromised server could serve a page that reads the key. Every encrypted web app shares this limit; the page's code is open source and can be checked against the release.
- The relay sees metadata: which repositories are linked, who signs in, and when and how much each board changes.
- Nothing on the server can search or summarize a board. Anything like that runs on the person's devices.

## Rows

- A4 now reads: the relay serves the same API, sealed, so a client holding the key works the same against a local board or pullboard.dev.
- H4 retires into H16: every client, not the relay, applies moves in the relay's order with the CLI's engine.
- H5 now reads: signed in and paired, you see and act on your boards live, on phone or desktop.
- H15: the relay can't read boards. H16: clients apply moves in the relay's order. H17: pairing. H18: what the relay keeps.
