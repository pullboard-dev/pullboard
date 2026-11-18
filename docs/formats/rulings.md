# Proposed rulings and resume doctrine notes

## Proposed rulings and resume doctrine notes

The coordinator proposes a standing ruling with `pullboard spec draft "<rule>" --doctrine --source "chat, 2026-10-16"` (or a shout reference such as `"shout 42"`). A source is required. The draft lives in the configured doctrine file, with `Source: ...` in its text, and the returned id is qualified as `doctrine:DR1`. The person approves or declines that id through the existing `spec approve` or `spec decline` commands; the coordinator runs `spec apply`.

`resume --json` includes `doctrineNotes`, an array of newly seen approved repo rules, each with `id`, `text` and `gate`. Drafts and pending applications are excluded. Text resume prints the same rules. Each checkout records its own displayed rule text under its Git directory, so a second checkout receives its own notice. Repeated resumes return an empty array until an approved rule changes.

Resume and criterion freezing use the primary branch's committed doctrine together with the person's applied exact-row decisions. An older agent checkout can therefore read an approved ruling and detect that a frozen citation is stale without changing its branch or local doctrine file. Proposed or unapplied changes do not replace the in-force rule.
