# SPEC.md and DOCTRINE.md

## SPEC.md and DOCTRINE.md

Doctrine means the house rules for agentic development. New repos use `DOCTRINE.md`; existing `PRACTICE.md` files keep working. Rename a tracked legacy file with `git mv -- PRACTICE.md DOCTRINE.md`; for an untracked file, use `mv -- PRACTICE.md DOCTRINE.md`. Keeping both names is refused because they define the same repo doctrine. The configuration and API retain their `practice` field names; an explicitly configured custom path still works.

Both files use the shared row grammar in `packages/spec/src/logic/grammar.js`, whose version is `SPEC_GRAMMAR_VERSION`. Either file may declare the current version on its own line as `<!-- pullboard-grammar N -->`; without a marker, the file uses the current grammar. A marker inside a fenced code example is ignored. The parser accepts only the version it reads and refuses a mismatched or invalid marker with `A5_GRAMMAR_VERSION`; upgrade Pullboard or use a file written for its grammar. Pullboard does not rewrite these files during an upgrade.

A section begins with `## `; a row must be beneath a section and occupies one line:

```text
- ID [status[, tier]] requirement text | gate: <command> | serves: <ID, ID> | signers: <principal, principal>
```

The identifier expression, statuses and tiers below come from the parser:

<!-- id-pattern:start -->
| Identifier | Parser expression |
| --- | --- |
| `ID` | `^[A-Za-z]+\d+(?:\.\d+)*$` |
<!-- id-pattern:end -->

<!-- statuses:start -->
| Status | Meaning |
| --- | --- |
| `approved` | decided and in force |
| `draft` | proposed, not decided |
| `pending` | open question |
| `fact` | true today |
| `wont` | not building; the row stays permanent |
| `retired` | no longer in force; the row stays permanent |
<!-- statuses:end -->

<!-- tiers:start -->
| Tier | Meaning |
| --- | --- |
| `must` | An approved must row names a gate. Other statuses may omit it. |
| `aim` | An aim; no gate is required. |
<!-- tiers:end -->

After the requirement text, `gate:` names the check, `serves:` names comma-separated ids, and `signers:` names comma-separated SSH principals; each field may be omitted. Each signer is one unique principal with no spaces, commas or leading `#`; the list names the exact principals required for signed sign-offs. An approved row is met only when every listed principal has a verified SSH receipt for its current text; missing, stale or unverified receipts leave it unmet. A row may also carry `source:`, the reference a blueprint rule came from, written as its name, then its id and address when it has them (`| source: Example Framework OPS 8 https://example.com/ops-8`). The parsed row gains a `source` string only when the field is written, so a row without one parses exactly as before; an empty `source:` is an error. `spec show` prints the source and `spec --json` rows carry it. Other trailing keys are recorded as unknown and rejected by `spec check`. A malformed row-like line is an error, and rows inside fenced code blocks are examples rather than input. IDs are permanent: mark a cut row `wont` or `retired` instead of deleting it.

The row object returned by `parseSpec` has these fields:

### ID namespaces and collisions

A bare id names a row in `SPEC.md`. A doctrine row is cited as `doctrine:<id>` in item spec ids and commit headers, even when a row with the same bare id exists in `SPEC.md`. `spec check` compares the current rows in `SPEC.md` and `DOCTRINE.md` (or a legacy `PRACTICE.md`), and rows within either file. Collisions already present in the primary checkout's attached branch are reported as known warnings; adding a colliding row is an error that names both file paths and line numbers. A detached primary checkout cannot establish this baseline. A commit that cites a bare id shared with a doctrine row warns that the bare id resolves to `SPEC.md`; use the `doctrine:` prefix to cite the doctrine row.

`parseSpec` also returns `grammarVersion`, equal to `SPEC_GRAMMAR_VERSION` after the file's marker has been checked.

<!-- parser-fields:start -->
| Parsed field | Meaning |
| --- | --- |
| `id` | Stable row identifier. |
| `status` | One token from the status list. |
| `tier` | Optional second token: must or aim. |
| `text` | Requirement text before trailing fields. |
| `gate` | Check named by gate, or an empty string. |
| `serves` | Comma-separated ids named by serves, or an empty list. |
| `signers` | Comma-separated SSH principals named by signers, or an empty list. |
| `unknown` | Unrecognized trailing fields; spec check reports them. |
| `stakes` | Optional row stakes: low, team or critical. |
| `section` | Containing ## heading. |
| `line` | 1-based source line. |
<!-- parser-fields:end -->

### Blueprint rule sources

A blueprint is one JSON file (format 1, described at the top of `packages/blueprints/index.js`). Its `kind` is `product`, `architecture`, `practice` or `beyond-code`; a file that says `infrastructure`, the old name, loads as `architecture`. A rule may carry `source: { name, id, url }`: `name` is required, `id` and `url` are optional, each is one line without `|`, and `url` is an `http` or `https` address. `pullboard blueprint add` and `init --blueprint` copy it onto the drafted row's `source:` field; the row's text stays the rule and its reason. Every rule of an architecture blueprint names its source, since it paraphrases a known-good reference: a rule without one refuses the blueprint with `BLUEPRINT_NO_SOURCE`, naming the blueprint and the rule, when it is loaded or saved.
