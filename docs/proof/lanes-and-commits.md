# Proof audit: the lane and commit rows

The lane rows (L1 to L4) and the commit rows (C1 to C5) are enforced by git hooks. No accepted item vouched for them. This audit breaks each row's rule in `src/`, one change at a time, and checks that a test carrying the row's id goes red. Item #55 holds it; see also [verification.md](verification.md) and [board.md](board.md).

Re-run it with `node docs/proof/lanes-and-commits-mutants.mjs`. It uses the shared harness, `docs/proof/harness.mjs`, which works on a temporary copy of the repo's tracked folders. The harness checks each target test exists, matches exactly one test and is green before any change.

| Row | Rule | Change that breaks it | Test that must go red | Result |
|---|---|---|---|---|
| L1 | Lanes live in pullboard.json: folders owned, spec prefixes, when it starts. | a lane may own something other than a list; its specs or its start may be anything (three changes) | a config with a bad lane refuses and names the field | red, all three, **after this audit** |
| L1 | | a lane may be named all or coordinator | a config with a bad lane refuses and names the field | red |
| L1 | | the coordinator is listed last | lane names list the coordinator first | red |
| L2 | The longest owned prefix decides a path's lane; unowned paths are the coordinator's. | the first matching prefix decides; an unowned path belongs to no lane | the longest owned prefix decides a path's lane | red, both |
| L3 | In a lane's worktree, pre-commit refuses changes outside the lane, moves included. | a lane may commit outside its folders | a lane commits only inside its folders | red |
| L3 | | a move counts only where it lands, not where it left | a lane commits only inside its folders | red, **after this audit** |
| L4 | A worktree that has not joined a lane cannot commit. | a worktree that joined no lane may commit | a lane commits only inside its folders | red |
| C1 | Header: type(scope): subject [ids], 72 characters at most. | any length; an uppercase subject; a trailing period (three changes) | header format, length, case and period | red, all three |
| C1 | | a header of any type passes | header format, length, case and period | red, **after this audit** |
| C2 | Cited ids exist; feat and fix cite at least one. | cited ids need not exist; feat and fix may cite nothing | feat and fix cite ids; cited ids exist and are not retired | red, both |
| C3 | Pre-push runs the gate, unless this exact tree already passed it. | pre-push never runs the gate | pre-push runs the gate once per tree | red |
| C3 | | pre-push runs the gate again on a tree that passed | pre-push runs the gate once per tree | red, **after this audit** |
| C3 | | pre-push lets through a commit that is not checked out | pre-push runs the gate once per tree | red |
| C4 | Every refusal says what to do and shows what it saw. | a refused merge header does not point to the exempt message | a refused merge message points to the message git writes | red |
| C4 | | a refused header does not show what it saw | header format, length, case and period | red, **after this audit** |
| C4 | | a blocked hook drops its note on what to do | a lane commits only inside its folders | red, **after this audit** |
| C5 | Pre-commit runs the fixers on fully staged files and restages what they fix. | no fixer runs; a partly staged file is fixed anyway; what a fixer fixed is not restaged | pre-commit runs the fixers on fully staged files | red, all three |

## What the audit changed

- **L1:** the bad-lane test used names that fail the name rule first, which returns before the fields are read. So a lane could own a string, cite a string or start at a number, and the test still passed. It now gives a well-named lane three bad fields, checks each is named, and carries L1.
- **L3:** the move test moved a file out of the lane, which its destination catches. A file moved in from another lane, which only its source catches, was never tried. It is now.
- **C1:** the unknown-type case, `Added the page`, also fails on its capital and its missing colon. A type outside the list, `feature: …`, is now tried on its own.
- **C3:** a second push of a tree that passed was never shown to skip the gate. The test now checks the skip message.
- **C4:** "shows what it saw" and "says what to do" were printed but never asserted. Both are now: the header refusal quotes the header, and a blocked hook ends with its note.

C4 says every refusal does this. The audit tests the hook refusals it changed, not every refusal in the CLI.
