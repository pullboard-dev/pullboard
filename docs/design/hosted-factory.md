# Design: a hosted software factory one person can subscribe to

Status: a proposal for the person. Nothing here is built.

One person subscribes monthly and gets a working factory: a board, agents, runners and a live site that is checked. Prices, costs and margins are kept out of this page on purpose.

## What a subscriber gets

- A board with the spec, items and the second-agent verification the open-source product has.
- Agents that build and verify, started and stopped for them.
- Test runners that run their gates.
- A live site, deployed only from proven commits and checked after each deploy.
- A chat and a phone view, as in the hosted-instances design.

## Per-subscriber limits

Limits keep one subscription affordable. Each is a monthly number, shown to the subscriber:

| Limit | What it bounds |
|---|---|
| Agent hours | Time agents spend building and verifying |
| Runner minutes | Time the gates and tests run |
| Boards and items | How much one subscriber stores |
| Site traffic | What the live site may serve |

## Metering and caps

- Every agent hour and runner minute is recorded as a board fact, so the count is the board's own record.
- The subscriber sees usage in one plain line: used and left.
- At 80 percent of a limit the chat says so once.
- At the limit work pauses, never bills more. The subscriber chooses to wait for the reset or raise the limit themselves.
- No limit is exceeded by default, so there is no surprise bill.

## The smallest first version

One plan with the four limits above. Usage counted from the board's facts. A pause at the cap. A page that shows used and left. No add-ons, no teams, no overage.

## Items building it would need

- Item: a usage fact for each agent hour and runner minute.
- Item: a per-subscriber limit that pauses claims and runs at the cap.
- Item: the used-and-left line in the chat and on the board.
- Item: the 80 percent notice.
- Item: the live site's checked deploy for one subscriber.

## Open decisions for the person

- Which limits does the first plan have, and what are their sizes? (Kept in the person's private notes.)
- Does a paused subscriber wait for the reset, or may they raise the limit in the first version?
- Does the live site count against the same plan?
- When a subscriber stops, how long do we keep their board?
