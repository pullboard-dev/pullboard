# Design: a CLI with the least confusion

Status: a proposal for the person. Nothing here is built.

Pullboard has 105 top-level commands today. A new person cannot tell which ones are theirs. This page cuts the top level to eleven commands, moves the rest under one `admin` word, and puts every report under `stats`.

## The shape

- Eleven person commands at the top level: `init`, `add`, `list`, `show`, `next`, `submit`, `verify`, `stats`, `shout`, `inbox`, `view`.
- One agent loop: `next`, then `submit` or `verify`. Claiming, releasing and shipping become parts of that loop, not commands to learn.
- Everything that sets up, repairs or tunes the board lives under `pullboard admin <command>`. A coordinator uses it; a worker never needs it.
- Report views fold into `pullboard stats <view>`. `stats` with no word prints the board at a glance, as `status` does today.
- `shout` sends and `inbox` reads. There is no other messaging command.
- No singular and plural pairs: `lane` and `lanes`, `hook` and `hooks`, `sentinel` and `sentinels` each become one command that lists when given no argument.
- No aliases before v1. After v1, a renamed command keeps a deprecation for one version back: it still runs, prints the new name, and is deleted a version later.

## Command mapping

Every command that `pullboard help --all` prints, with its new place. The docs test checks that none is missing.

| Command | Fate | New place | Note |
|---|---|---|---|
| `add` | kept | `pullboard add` | File an item. |
| `agents` | folded into stats | `pullboard stats agents` | A report view. |
| `answer` | moved under admin | `pullboard admin answer` | Group: items. |
| `badge` | moved under admin | `pullboard admin badge` | Group: this machine. |
| `bar` | moved under admin | `pullboard admin bar` | Group: the spec. |
| `blueprint` | moved under admin | `pullboard admin blueprint` | Group: setup. |
| `capacity` | folded into stats | `pullboard stats capacity` | A report view. |
| `check` | moved under admin | `pullboard admin check` | Group: gate. |
| `claim` | moved under admin | `pullboard admin claim` | Group: work. |
| `compact` | moved under admin | `pullboard admin compact` | Group: this machine. |
| `companion` | moved under admin | `pullboard admin companion` | Group: items. |
| `contribute` | moved under admin | `pullboard admin contribute` | Group: gate. |
| `decisions` | folded into stats | `pullboard stats decisions` | A report view. |
| `digest` | folded into stats | `pullboard stats digest` | A report view. |
| `doctor` | moved under admin | `pullboard admin doctor` | Group: this machine. |
| `doctrine` | moved under admin | `pullboard admin doctrine` | Group: the spec. |
| `done` | removed | `pullboard submit` | An alias; no aliases before v1. |
| `edit` | moved under admin | `pullboard admin edit` | Group: items. |
| `escalate` | moved under admin | `pullboard admin escalate` | Group: items. |
| `export` | moved under admin | `pullboard admin export` | Group: board data. |
| `fact` | moved under admin | `pullboard admin fact` | Group: items. |
| `flakes` | folded into stats | `pullboard stats flakes` | A report view. |
| `flow` | folded into stats | `pullboard stats flow` | A report view. |
| `forget` | moved under admin | `pullboard admin forget` | Group: board data. |
| `gate` | moved under admin | `pullboard admin gate` | Group: gate. |
| `gate-health` | folded into stats | `pullboard stats gate-health` | A report view. |
| `handoff` | moved under admin | `pullboard admin handoff` | Group: seats. |
| `health` | folded into stats | `pullboard stats health` | A report view. |
| `heartbeat` | moved under admin | `pullboard admin heartbeat` | Group: seats. |
| `help` | kept | `--help` | Kept as `--help` on every command; it stops being a command. |
| `hold` | moved under admin | `pullboard admin hold` | Group: lanes. |
| `hook` | moved under admin | `pullboard admin hook` | Group: git hooks. |
| `hooks` | removed | `pullboard admin hook` | The plural twin goes; the singular lists with no argument. |
| `import` | moved under admin | `pullboard admin import` | Group: board data. |
| `inbox` | kept | `pullboard inbox` | Read the messages sent to me. |
| `init` | kept | `pullboard init` | Set up a repo. |
| `intake` | moved under admin | `pullboard admin intake` | Group: outside work. |
| `join` | moved under admin | `pullboard admin join` | Group: seats. |
| `labels` | folded into stats | `pullboard stats labels` | A report view. |
| `land` | moved under admin | `pullboard admin land` | Group: gate. |
| `lane` | moved under admin | `pullboard admin lane` | Group: lanes. |
| `lanes` | removed | `pullboard admin lane` | The plural twin goes; the singular lists with no argument. |
| `ledger` | folded into stats | `pullboard stats ledger` | A report view. |
| `lifecycle` | folded into stats | `pullboard stats lifecycle` | A report view. |
| `list` | kept | `pullboard list` | Open and active items. |
| `log` | folded into stats | `pullboard stats log` | A report view. |
| `loop` | moved under admin | `pullboard admin loop` | Group: this machine. |
| `maintenance` | moved under admin | `pullboard admin maintenance` | Group: this machine. |
| `map` | moved under admin | `pullboard admin map` | Group: this machine. |
| `mcp` | moved under admin | `pullboard admin mcp` | Group: this machine. |
| `merged` | moved under admin | `pullboard admin merged` | Group: gate. |
| `milestone` | moved under admin | `pullboard admin milestone` | Group: planning. |
| `move` | moved under admin | `pullboard admin move` | Group: items. |
| `next` | kept | `pullboard next` | The agent loop: claim, build or verify, whatever is next. |
| `pass` | moved under admin | `pullboard admin pass` | Group: items. |
| `patch` | moved under admin | `pullboard admin patch` | Group: items. |
| `prompt` | moved under admin | `pullboard admin prompt` | Group: role prompts. |
| `publish` | moved under admin | `pullboard admin publish` | Group: gate. |
| `push-receipts` | moved under admin | `pullboard admin push-receipts` | Group: gate. |
| `queue` | folded into stats | `pullboard stats queue` | A report view. |
| `red` | folded into stats | `pullboard stats red` | A report view. |
| `refreeze` | moved under admin | `pullboard admin refreeze` | Group: items. |
| `relay` | moved under admin | `pullboard admin relay` | Group: this machine. |
| `release` | moved under admin | `pullboard admin release` | Group: work. |
| `reopen` | moved under admin | `pullboard admin reopen` | Group: items. |
| `request` | moved under admin | `pullboard admin request` | Group: items. |
| `resources` | folded into stats | `pullboard stats resources` | A report view. |
| `resume` | moved under admin | `pullboard admin resume` | Group: seats. |
| `rigor` | folded into stats | `pullboard stats rigor` | A report view. |
| `roadmap` | folded into stats | `pullboard stats roadmap` | A report view. |
| `run` | moved under admin | `pullboard admin run` | Group: unattended runs. |
| `runner` | moved under admin | `pullboard admin runner` | Group: this machine. |
| `search` | removed | `pullboard list --like <words>` | Finding similar items is a way of listing. |
| `seats` | folded into stats | `pullboard stats seats` | A report view. |
| `sentinel` | moved under admin | `pullboard admin sentinel` | Group: this machine. |
| `sentinels` | removed | `pullboard admin sentinel` | The plural twin goes; the singular lists with no argument. |
| `serve` | moved under admin | `pullboard admin serve` | Group: this machine. |
| `settings` | moved under admin | `pullboard admin settings` | Group: this machine. |
| `shadow-batch` | moved under admin | `pullboard admin shadow-batch` | Group: gate. |
| `ship` | moved under admin | `pullboard admin ship` | Group: unattended runs. |
| `shout` | kept | `pullboard shout` | Send a message to an agent, a lane or the person. |
| `show` | kept | `pullboard show` | One item and its bar. |
| `skills` | moved under admin | `pullboard admin skills` | Group: setup. |
| `slice` | moved under admin | `pullboard admin slice` | Group: items. |
| `spec` | moved under admin | `pullboard admin spec` | Group: the spec. |
| `stats` | kept | `pullboard stats` | Every report view, with a subject word. |
| `status` | folded into stats | `pullboard stats` | The default `stats` page. |
| `submit` | kept | `pullboard submit` | Hand finished work to its gate. |
| `sweep` | moved under admin | `pullboard admin sweep` | Group: gate. |
| `sync` | moved under admin | `pullboard admin sync` | Group: gate. |
| `takeover` | moved under admin | `pullboard admin takeover` | Group: seats. |
| `test` | moved under admin | `pullboard admin test` | Group: gate. |
| `test-value` | folded into stats | `pullboard stats test-value` | A report view. |
| `tool-build` | moved under admin | `pullboard admin tool-build` | Group: gate. |
| `tour` | moved under admin | `pullboard admin tour` | Group: setup. |
| `trace` | folded into stats | `pullboard stats trace` | A report view. |
| `verify` | kept | `pullboard verify` | A second agent accepts or rejects. |
| `version` | kept | `--version` | Kept as `--version`; it stops being a command. |
| `view` | kept | `pullboard view` | The board in a browser. |
| `waits` | folded into stats | `pullboard stats waits` | A report view. |
| `watch` | folded into stats | `pullboard inbox --watch` | The wait for new messages is an option of `inbox`. |
| `whoami` | folded into stats | `pullboard stats whoami` | A report view. |
| `why` | folded into stats | `pullboard stats why` | A report view. |
| `withdraw` | moved under admin | `pullboard admin withdraw` | Group: items. |
| `worktree` | moved under admin | `pullboard admin worktree` | Group: seats. |

## Items building it would need

- Item: an `admin` dispatcher that routes the moved commands and prints the old command's new place when it is typed at the top level.
- Item: `stats <view>` as one command that owns every folded report, with `status` as its default page.
- Item: `inbox --watch` replaces `watch`, and `list --like` replaces `search`.
- Item: one version-back deprecation mechanism for renamed commands, switched on at v1.
- Item: the help pages, command-docs data, `docs/api.md` and the journeys renamed to the new places in one scripted change, in a freeze.
- Item: agent briefs, skills and refusal `next:` lines rewritten to the new names.

## Open decisions for the person

- Is eleven the right count, or should `view` and `inbox` move under `stats`?
- Is `admin` the right word, or `ops` or `board`?
- Should the unattended `run` and `ship` live under `admin`, or become options of `next`?
- Do old command names keep working in 0.9.x, or does the rename wait for v1 with no bridge?
