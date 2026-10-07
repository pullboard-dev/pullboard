# RFC 0002: The relay and API v1

- Status: accepted, 7 October 2026
- Proposed: 7 October 2026, by Corey Olson
- Rows: A1 to A7, H1 to H12

## Summary

Pullboard gets one versioned API, served two ways: locally by `pullboard serve`, and by pullboard.dev for repos that opt in. With the relay on, every move on a board passes through pullboard.dev in one order, enforced by the CLI's own engine, so agents on any machine share one board and the person can see and run it from a phone. The relay holds board records, never code, and never writes to a repo.

## How it works for the person

1. Sign in at pullboard.dev with GitHub.
2. In a repo, run `pullboard relay on`. It signs the CLI in with a GitHub device code, links this repo's board, and uploads its records.
3. Agents work as before. Each move they make (claim, submit, verify, shout) goes through the relay, and the local board follows.
4. On a phone, open app.pullboard.dev: every linked board, live, with the view's actions.
5. What the person does there that changes the repo, such as approving a row, reaches the coordinator agent as a request, which `pullboard resume` shows first and the coordinator commits.
6. `pullboard relay off` unlinks. The local board is complete, so nothing is lost.

## The parts

**The engine.** The relay runs the same board code as the CLI (`src/board.js`, the lifecycle in `src/machine.js`, SQLite through `node:sqlite`), one database per board. It refuses exactly what the CLI refuses, with the same codes.

**API v1.** One shape for both servers. Locally, `pullboard serve` answers on 127.0.0.1 behind a per-session secret, as the view does today. On pullboard.dev, the same paths answer behind a GitHub session or an agent token.

| Method and path | What it does |
| --- | --- |
| `GET /api/v1/boards` | The boards this caller may see, with their projects |
| `GET /api/v1/boards/:board/state` | Items, verdicts, shouts, agents, spec and practice rows, as the view shows them |
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N; with `Accept: text/event-stream`, a live stream |
| `POST /api/v1/boards/:board/moves` | One move: `{verb, item, args, agent}`. Returns its event, or a refusal `{code, message, next}` |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator, such as approving a row |

Every response carries `version: 1`. Within version 1, fields are only added, never removed or changed. The view becomes a client of this API and nothing else, so any app, such as Quant's interface, can do what the view does.

The details, settled while building it:

- **Board ids.** A board's id is a random 128-bit value created with the board and stored in it; an older board gets one when it is upgraded. The id survives moving the repo, and the relay keeps it when the board links, so a client uses one id everywhere.
- **Agents.** A move's `agent` is a registered agent's name, and the move runs in that agent's worktree; without one it runs as the coordinator. Locally, the session secret may act as any agent on the board. On the relay, a token belongs to one agent.
- **Requests.** A request is a shout from the person to the coordinator, marked as a request. It stays open until the coordinator answers it done, or declined with a reason. `pullboard resume` and `pullboard inbox` show open requests first, and they never count toward the person's Needs-you.
- **Errors.** A refused call answers `{version: 1, error: {code, message, next}}`, with the HTTP status giving the kind: 400 for a malformed request, 401 for a missing or wrong secret or token, 403 for a token meant for another board, 404 for an unknown board, and 409 for a move the engine refuses, under the engine's own code.
- **Events.** Every change, shouts and answers included, appends its event in the same transaction, and a move returns the event it appended. In the live stream, each message's id is the event's sequence number and its data is `{version, event}`; a client that reconnects with `Last-Event-ID` resumes after that event.

**Ordering.** With the relay on, the relay is the board of record. A move goes to the relay, which applies it in one transaction and appends its event with the next sequence number. The CLI then applies that event to its local copy. Two agents claiming one item race at the relay, and one wins. A CLI that can't reach the relay reads its local copy and refuses moves until the relay answers, naming the relay as the reason.

**Identity.** Signing in gives the person a session. `relay on` issues a token for the board. Each agent that joins a linked board gets a token of its own, so a verdict records which agent gave it, not only a worktree path. Tokens are stored hashed, can be revoked one by one, and reach only their board.

**What the relay holds.** Board records: items, criteria, verdicts, shouts, events, agents, and the spec and practice rows as parsed, so the view can show them. Never source files, diffs or file contents. A board can be deleted from the relay at any time, and the local board keeps everything.

**Who sees what.** A signed-in person sees a board only if their GitHub account can read the repo it belongs to, checked through a GitHub App with read-only metadata permission. The app has no write permission to any repo.

**Hosting.** One Node 22 service on Railway, with one SQLite file per board on a volume and daily backups. pullboard.dev stays the static site; app.pullboard.dev serves the signed-in view and the API. If boards outgrow one process, the same engine can move to one Durable Object per board.

## Build order

1. API v1 locally: `--json` everywhere (A1), `pullboard serve` with live events (A2), the view on the API alone (A3).
2. The relay service: GitHub sign-in, boards, the engine as sequencer, board and agent tokens (A4, H1, H3, H4, H7, H8, H9, H2).
3. Relay mode in the CLI: `relay on|off`, moves sent to the relay, events applied locally, the offline refusal (H1, H3, H10).
4. The view on app.pullboard.dev, and requests that reach the coordinator (H5, H12).

## Open questions

- Pricing: free for personal boards to start. What a team plan holds is decided after people use it.
- Git sync (H11), for those who want one board across machines with no account, waits until the relay ships.
