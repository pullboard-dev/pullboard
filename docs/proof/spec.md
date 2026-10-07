# Proof audit: the spec rows

S1 to S9 govern SPEC.md and PRACTICE.md themselves:
- the row format;
- ids that are unique and permanent;
- serves links;
- gates on approved must-rows;
- sign-offs that hold the text they approved;
- the offline spec view;
- rows marked wont.

No accepted item vouched for them. This audit breaks each row's rule in `src/`, one change at a time, and checks that a test carrying the row's id goes red. Item #57 holds it; see also [verification.md](verification.md), [board.md](board.md) and [lanes-and-commits.md](lanes-and-commits.md).

Re-run it with `node docs/proof/spec-mutants.mjs`. It uses the shared harness, `docs/proof/harness.mjs`, which works on a temporary copy of the repo's tracked folders.

| Row | Rule | Change that breaks it | Test that must go red | Result |
|---|---|---|---|---|
| S1 | One row per line: id, status, text, gate, what it serves. | a row that does not parse is dropped silently | a row-like line that does not parse is an error, never dropped | red |
| S1 | | a row loses what it serves; a row loses its gate | rows parse with id, status, tier, text, gate, serves, section and line | red, both |
| S2 | Ids are unique forever; retired rows stay, so no id is reused. | a duplicate id passes | ids are unique, retired ones included | red |
| S2 | | a new row may reuse a retired row's id | ids are unique, retired ones included | red |
| S2 | | a retired row may repeat a live id | ids are unique, retired ones included | red, **after this audit** |
| S3 | Serves links name real ids and never cycle. | serves may name a missing id; serves links may cycle | serves links must name real ids and never cycle | red, both |
| S4 | Approved must-rows name their gate. | an approved must-row may leave out its gate | approved must-rows name their gate | red |
| S5 | A sign-off keeps the text it approved; changing the row makes it stale. | a sign-off counts whatever the row says now; it records no text; a row that is not approved can be signed | a sign-off holds the text it approved; changing the row makes it stale | red, all three |
| S6 | PRACTICE.md uses the same format; spec check lints both. | spec check lints SPEC.md only | spec check lints both files | red |
| S7 | `pullboard spec view` renders spec, questions, sign-offs and practice as one offline page. | the page leaves out its practice tab | one self-contained page with every tab and every row | red |
| S8 | Ids are permanent: commit refuses a deleted row; spec check finds ids once committed or cited, now gone. | a committed id may leave; a cited, never-committed id passes | an id once committed or cited never leaves the spec | red, both |
| S8 | | commit lets a row be deleted | a deleted spec row is refused at commit | red |
| S9 | A wont row stays with its id, out of the counts; nothing new may cite it. | a wont row can be cited; a wont row counts as unmet | a row marked wont stays with its id, drops out of the counts | red, both |

## What the audit changed

The spec rows were the best tested of the four audits so far: 19 changes, and only one slipped at first. The S2 test covered a retired id reused by a new row. It never tried the other order, a retired row that repeats an id still live. Both break "ids are unique forever", so the test now covers both. The audit also targets reuse itself with a change that skips recording retired ids. The test catches that change, as it always would have.
