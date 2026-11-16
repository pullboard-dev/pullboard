# Rigor

Rigor turns a repeated mistake into a rule the board keeps. It watches the failures the board already records. When the same cause shows up again, Rigor lists it, and the coordinator can draft a rule that checks for it. The person decides whether the rule becomes part of the project.

## What counts as a repeat

A cause repeats when it shows up on two items. It also repeats when one item fails twice at two different commits. A cause can also become a repeat at once when the person marks it never again.

Merge conflicts never count as a repeat. Two branches that touch the same lines collide, and no rule can prevent that.

## How a cause is named

Every cause has a key. The key comes from the structured fields of a failure, never from the free-text note, so the same mistake gets the same key each time. There are five kinds:

- `test:<file>::<title>` for a failing test
- `refusal:<CODE>` for a refusal the board gave
- `row:<id>` for a spec row
- `doctrine:<id>` for a doctrine row
- `sentinel:<name>` for a watch that went red

Name the cause when you send work back, so Rigor can read it. For example:

    pullboard verify <id> reject --reason TEST_FAILURE --note "what failed" --cause <key>
    pullboard reopen <id> --note "why" --cause <key>

Copy the key exactly as `pullboard rigor` prints it, so the failure joins the same line.

A reject or reopen without a cause still counts as a failure. Rigor just cannot read it, and the report says how many there are.

## How you use it

Start by looking at what has repeated:

    pullboard rigor

Each line shows the cause, whether it reads as work, product or both, how often it failed, and which items it touched. A line that says "never again (the person)" is one the person has already decided on.

The same report as one versioned document, for scripts:

    pullboard rigor --json

When a cause repeats, the board posts a notice to the coordinator with the next command. The coordinator then drafts the rule and proves it. The command takes a rule, a check, and two commits: one where the check fails, and one where it passes:

    pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit> [--section <letter>]

Rigor runs the check at both commits. If the check does not fail at the red commit and pass at the green one, the draft is refused. A cause that reads as work becomes a doctrine row whose check must count zero. A cause that reads as product becomes a spec row gated by its failing test. A cause that reads as both produces one of each, and the person picks which to keep.

A `test:` cause needs a literal `node --test <file>` check, and the named test must fail at the red commit and pass at the green one.

Drafting approves nothing. The person reviews each draft with its evidence and its proof. They approve or decline it in the Needs you list in `pullboard view`, or with:

    pullboard spec approve <ids> | decline <ids> --reason "why"

A repeated cause that a check can watch is drafted as a pending board watch instead, citing its repeats and the proof. It appears in Needs you with the other drafts, and it runs only after the person approves it.

Once a doctrine row is approved, every submit runs the doctrine check, so the rule holds from then on. Check the current rules and their counts with:

    pullboard doctrine check

## Marking a cause never again

Sometimes the person knows a mistake must never happen again, and does not want to wait for a second failure. The person records the cause as a fact and marks it never again:

    pullboard fact <id> root-cause "<why>" --cause <key> --never-again --as person

Only the person can do this, from the main checkout, through the terminal or the view. The cause lists in `pullboard rigor` at once, and the coordinator is asked to draft it.
