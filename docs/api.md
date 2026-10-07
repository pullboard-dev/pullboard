# CLI JSON API

Add `--json` to a Pullboard command to receive one JSON document on stdout. The document has `version: 1`; diagnostics stay out of stderr. The flag may appear with command options before `--`. A flag after `--` is an argument to the command, not an output-mode switch.

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

A successful command returns the fields listed below. `version` is always the number `1`. The catalog lists required top-level fields; nested objects and arrays are command data, and optional top-level fields may be added.

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `id:string`, `lane:string`, `path:string` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `list` | `version:number`, `items:array` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array` |
| `status` | `version:number`, `me:object`, `mine:array`, `stats:object`, `unread:number` |
| `inbox` | `version:number`, `shouts:array` |
| `decisions` | `version:number`, `decisions:array` |
| `ledger` | `version:number`, `items:array`, `stats:object` |
| `log` | `version:number`, `events:array` |
| `add` | `version:number`, `item:object` |
| `edit` | `version:number`, `item:object` |
| `escalate` | `version:number`, `id:number`, `from:string`, `to:string` |
| `run` | `version:number`, `messages:array` |
| `sweep` | `version:number`, `messages:array` |
| `next` | `version:number`, `item:object`, `review:boolean`, `held:boolean`, `shared:array` |
| `check` | `version:number`, `id:number`, `green:boolean`, `seconds:number`, `check:string`, `report:string` |
| `claim` | `version:number`, `id:number`, `renewed:boolean`, `leaseUntil:string`, `digest:string` |
| `hold` | `version:number`, `lane:string`, `held:boolean` |
| `release` | `version:number`, `id:number` |
| `submit` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `done` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `verify` | `version:number`, `id:number`, `decision:string`, `reason:string` |
| `merged` | `version:number`, `id:number`, `commit:string` |
| `withdraw` | `version:number`, `id:number`, `reason:string` |
| `refreeze` | `version:number`, `id:number`, `after:string` |
| `shout` | `version:number`, `id:number`, `decision:boolean` |
| `answer` | `version:number`, `id:number`, `answers:number` |
| `tour` | `version:number`, `messages:array` |
| `lifecycle` | `version:number`, `markdown:string` |
| `view` | `version:number`, `url:string`, `port:number` |
| `forget` | `version:number`, `root:string` |
| `prompt` | `version:number`, `role:string`, `text:string` |
| `gate` | `version:number`, `green:boolean`, `report:string` |
| `spec` | `version:number`, `rows:array` |
| `spec check` | `version:number`, `rows:array` |
| `spec view` | `version:number`, `path:string` |
| `spec show` | `version:number`, `row:object`, `standing:object` |
| `spec unmet` | `version:number`, `rows:array` |
| `spec signoff` | `version:number`, `count:number`, `by:string`, `ids:array`, `evidence:array` |
| `hook pre-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
<!-- api-command-shapes:end -->

## Refusals

A refusal keeps the command's existing exit status and prints exactly one versioned document to stdout. In JSON mode stderr stays empty. The command-specific `code` identifies the rule; `message` explains what happened; `next` gives the next step.

```json
{
  "version": 1,
  "error": {
    "code": "NODE_TOO_OLD",
    "message": "this is Node 20.11.1, and pullboard needs Node 22.13 or newer",
    "next": "install Node 22.13 or newer, then run the command again"
  }
}
```

<!-- api-refusal-shapes:start -->
| Part | Required fields |
| --- | --- |
| `envelope` | `version:number`, `error:object` |
| `error` | `code:string`, `message:string`, `next:string` |
<!-- api-refusal-shapes:end -->

The result and refusal tables are checked against `JSON_SHAPES` in `src/json.js` by `docs/api.test.js`.
