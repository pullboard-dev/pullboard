# Design: use Pullboard from ChatGPT and Claude through an MCP connector

Status: design only. Nothing here is built. Rows: N26, A4, H1, H5, H12, H15, P6.

## Goal

A person adds one connector in ChatGPT or Claude and then asks their chat to read the board, capture ideas, claim and submit work, and verify. The chat acts as an agent, never as the person.

## What exists

- `pullboard mcp` serves the commands as MCP tools on the person's machine, over stdio.
- Its tools today: `board_status`, `show_item`, `shout`, `capture_idea`, `next`, `claim`, `submit`, `verify`, `resume`.
- The relay (pullboard.dev) serves the same API sealed (A4), and never reads boards (H15).
- Person moves (approving rows, answering decisions, sign-off) come only from the person (P6).

## Tools

| Tool | Chat use | Status |
|---|---|---|
| `board_status` | What is happening on my boards | today |
| `show_item` | Read an item's bar and thread | today |
| `shout` | Tell the coordinator or an owner | today |
| `capture_idea` | Turn a chat idea into a board idea | today |
| `next` | A chat acting as a worker | today |
| `claim` | Take a named item | today |
| `submit` | Hand in finished work | today |
| `verify` | Judge another agent's work | today |
| `resume` | Pick up where a session stopped | today |
| `list_boards` | Which boards can this chat reach | new |
| `list_decisions` | Open decisions waiting on the person | new, read only |
| `explain` | Plain-language summary of a board or item | new, read only |
| `request_approval` | Ask the person to approve a row or answer a decision | new, files a request |

No tool approves, answers or signs off.

## Sign-in and reaching a board

1. The person adds the connector's URL in ChatGPT or Claude.
2. The connector starts OAuth against pullboard.dev; the person signs in with GitHub (H1, H8).
3. The person picks the boards this chat may use; each gets a token scoped to one board (H9).
4. Passkeys stay the way the person approves (see Approvals); the chat never holds one.

### Where the key lives

The relay cannot read boards (H15). A remote connector has two ways to serve a board, and choosing one is an open decision:

- A. A paired machine of the person's runs the connector bridge and holds the key; the relay forwards chat calls to it. The board stays sealed. The machine must be on.
- B. The person gives the connector a board key held by pullboard.dev for chat use. It works with every machine off, and the relay can then read that board.

## What a chat agent may and may not do

May:
- read boards the person chose;
- capture ideas, shout, claim, submit and verify as a named agent with its own token (H2);
- file a request for the person.

May not:
- approve rows, answer decisions, sign off, hold or release lanes, or waive landing: person moves (P6);
- act on a board it was not given;
- write to a repo: pullboard.dev never writes to a repo (H12).

A refused move returns the refusal and its next step, the same as in a terminal.

## How approvals reach the person

1. The chat calls `request_approval`; the board records a request.
2. The person gets it in `pullboard view`, on their phone, or in their terminal.
3. The person approves there, with a passkey when the board asks for signed person moves.
4. The chat reads the result through `list_decisions` or `board_status`.

## Smallest first version

- One board, one person, read only: `list_boards`, `board_status`, `show_item`, `list_decisions`, `explain`.
- Option A for the key, so the relay learns nothing new.
- `capture_idea` and `shout` second; claiming and verifying later.

## Open decisions for the person

1. Option A (machine must be on, sealed) or option B (always on, relay can read) for the key.
2. Whether chat may claim and submit work, or only read and capture.
3. Whether every chat session needs a fresh sign-in, or a token lasts until revoked.
4. Whether ChatGPT and Claude get one connector URL or one each.

## Items building it would need

1. Remote MCP transport on the relay: OAuth, one token per board and chat.
2. The four new tools in `pullboard mcp`, with tests for the refusals.
3. The bridge for option A on a paired machine.
4. `request_approval` and its showing in `pullboard view`.
5. A per-chat revoke control in `pullboard view`.
6. Connector setup docs for each chat product.
