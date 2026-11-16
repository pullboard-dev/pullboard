# Design: hosted Pullboard instances

Status: a proposal for the person. Nothing here is built.

A hosted instance is a Pullboard board that runs on our side, so a person who does not code can start with nothing installed. Open-source Pullboard never forces a hosting choice; this is the hosted product built on the same core.

## Who it is for

A person who is put off by GitHub, even if they vibe code. They have an idea and a phone. They see the chat, their live floor and their running app. They never see git, a repo, a terminal or a worktree.

## First run with no install

1. They open a link or a chat app and say what they want.
2. The first message creates their instance. Nothing is configured: it is created on first use, sized by us and never tuned by them.
3. Their intent becomes spec rows, bars and items. Agents start building.
4. They watch the floor and approve in the chat.

## From a phone through ChatGPT and Claude

ChatGPT or Claude is the person's coordinator. They state intent in chat; the connector from #1494 turns it into board moves. Approvals happen in the same chat. A person move is refused unless it came from the person's own signed approval, the rule the board already enforces.

## Hosted and local

| Part | Where it runs |
|---|---|
| The board, its git history and the spec | Hosted, one per person |
| Agents and test runners | Hosted, sized by us |
| The running app they asked for | Hosted |
| Their own GitHub copy | Optional export, never required |
| Their own computer | Optional: they may pair it as a runner |

## Boards and agents

Each person has one board, created on first use. Agents run in hosted seats and follow the same loop as local ones: claim, build, submit, a second agent verifies. A board that sits idle sleeps and wakes on the next message. The person never starts or stops an agent.

## Identity and approvals

- Sign-in is a passkey; no password exists.
- Approvals are signed on the phone with the passkey. The relay carries sealed messages between the phone and the board, so the host cannot read or forge an approval.
- A lost phone is recovered with a second paired device, not by support.

## What it costs to run

The cost is mostly agent time and runner time, plus a small standing cost for each sleeping board. The design keeps a per-person cap on both, shown as one plain line in the chat. Prices are not set here.

## What stays private

- Boards, specs and code belong to the person; staff read them only with a recorded, person-approved access.
- Another person's board is never visible, and there is no shared runner state between boards.
- Nothing from a board trains anything or leaves it except to the agents the person's work needs.

## The smallest first version

One board per person, created from a chat message. One connector (ChatGPT or Claude, whichever #1494 ships first). Hosted agents on a fixed small pool. Passkey approval. No export, no paired computers, no sleeping: those follow.

## Items building it would need

- Item: create a board and its git history on first message, with no setup step.
- Item: the chat connector and its approval hand-off (#1494).
- Item: hosted seats and a runner pool, with a per-person cap.
- Item: passkey sign-in and signed approvals through the relay.
- Item: a live floor view that works on a phone.
- Item: export to the person's own GitHub, optional.

## Open decisions for the person

- Which chat app comes first, ChatGPT or Claude?
- Does an idle board sleep in the first version, or stay awake?
- Is staff access to a board ever allowed, and who approves it?
- Is export to GitHub in the first version or the second?
