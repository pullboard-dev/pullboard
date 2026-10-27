/** Help declarations and command phrases stay independent of CLI/server initialization [N26]. */
import packageData from '../package.json' with { type: 'json' };
import { lifecycleHelp } from './machine.js';
import { DEFAULT_VIEW_PORT } from './view-port.js';

export const VERSION = packageData.version;

const ALL_HELP = `pullboard ${VERSION}: the local-first work board for teams of coding agents.
Nothing ships until a second agent verifies it.

Outside contributions
  pullboard intake <GitHub PR URL> --criterion "behavior" --check "command" [--lane <lane>]  record exact outside author/commit, already submitted; never execute it here
  pullboard intake <GitHub issue URL>  record author, source state and maintainer reply; repeating intake refreshes metadata
  pullboard verify <id> accept [--sandbox] --note "proof"  configured Docker only, no network/credentials, Node22.13 and24; required for outside items; missing provider refuses
  pullboard intake approve <id>        owner/person approval for the exact sensitive outside commit; every PR result post still needs separate person OK

Set up
  pullboard tour                        see it work: a reject and its rework, scripted, in thirty seconds
  pullboard init [--model <name>] [--blueprint <name or file>]... [--no-permissions] [--no-hooks] [--yes] [--verbose]  --no-hooks skips agent nudges; --yes commits only setup's own files with your Git identity
  pullboard worktree <lane> --model <name> [--route light] [--family <name>]   make and join a worktree for a new agent
                                        pullboard.json worktrees: inside or beside; init defaults to inside
  pullboard join <lane> --model <name> [--route light] [--family <name>] [--parent <session-id>]  register this worktree and its parent session
                                        A model is required (or set PULLBOARD_MODEL); family is a separate declaration
  pullboard join coordinator --model <name>                                 declare the main checkout's coordinator model
                                        pullboard.json agents.names: suffix (default) or prefix
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard agents                      each agent with its seats and helpers, and what each holds
  pullboard lane add <name> --owns <path>[,<path>]   add a lane that owns those folders to pullboard.json
                                        refuses a lane name or a path that is already owned, naming the owner
  pullboard takeover                   rebind this checkout when the same agent starts a new session
                                        in a linked main checkout it also takes the board's coordinator here
  pullboard resources                  local resource holders and their FIFO queues
  pullboard settings line [<name> <value> --reason "why" --window <json>]  read or record board controller inputs; all off by default
      value is on, off, or a number within the setting range
                                        names: order, reviewsFirst, wipPerReviewer (1.5-3), barReady, bar.check, takeoverMinutes (15-60), collisionFreeBatch, landingBatchSize (1-8), landingCadenceMinutes (5-30)
  pullboard settings [gateSlots <n> | browserSlots <n> | gate.runnersFirst on|off]  view or set machine gate policy and capacity (gate default 2; browser default 1)
                                        browser-free check slots are opt-in: gate.browserFreeChecks in ~/.pullboard/settings.json (default false)
                                        a test file takes a browser slot only if it launches Chrome: gate.browserByLaunch (default false)
                                        reviews-first queue order is opt-in: gate.queue.reviewsFirst (default false), gate.queue.agingMinutes (default 30)
                                        release priority is opt-in: gate.queue.currentReleaseFirst (default false), within each board's otherwise-tied positions
                                        memory hold is opt-in: gate.memoryFloorMB in ~/.pullboard/settings.json holds the queue under that many MB free or critical pressure (default off)
                                        short slots for runs that name their test files are opt-in: pullboard settings gate.shortSlots <n> (default 0)
                                        signed person moves are opt-in: pullboard settings person.signed on makes each wait for your passkey; only the passkey turns it off
                                        runner-first dispatch is opt-in: pullboard settings gate.runnersFirst on|off (default off)
                                        runner admission deadline: pullboard settings gate.runnerWaitMs <n> (default 300000ms)
  pullboard runner add <ssh-host> --slots <n> --browser <n> [--node <remote-path>] [--root <remote-path>]
                                        register SSH test capacity; no runner sign-in; root defaults to ~/.pullboard-runner
  pullboard runner list                 each runner's registered slots and browsers, which it runs at
  pullboard view [--project] [--port N] [--no-open]  every project on this machine in your browser; default http://127.0.0.1:${DEFAULT_VIEW_PORT}
  pullboard view --lan                  a private link for a phone on the local IPv4 network
                                        items, shouts, doctrine, agents and activity; --port 0 chooses a free port
                                        --project limits this view to the registered project for this repository
                                        add items, shout and hold lanes from it
  pullboard view --export <dir>         a read-only snapshot with event replay, for any static host
  pullboard serve [--port N]           local API v1: boards, state, moves, requests and live events,
                                        behind the session secret in its printed address
  pullboard mcp                        MCP tools over stdio for this worktree's agent, started by its MCP client:
                                        board status, show, shout and capture an idea; a person's move is refused
  pullboard relay [status|on|off|pair|join <code>] [--url <address>] [--name <computer>]  link, inspect or unlink this board's sealed relay
                                        on signs in through GitHub; the address defaults to https://app.pullboard.dev
                                        pair prints a one-use machine code; join stores it in another clone
  pullboard relay members set <login> [<login> ...] | clear  publish an approver-signed membership list
  pullboard relay pair --new-browser    sign in and pair one more browser; existing browsers stay paired
  pullboard relay canary [on|off|status|run|watch]  opt this linked seat into minute sealed round-trip monitoring
  pullboard relay on --all [--url <address>] [--name <computer>]  link every registered project after one sign-in; pair the phone once
                                        keep this command open until pairing finishes; later projects link on registration
  pullboard relay devices [--verbose]   paired phones and joined computers by name, with paired date, last seen and boards
                                        --verbose adds each id and phone key fingerprint
  pullboard relay revoke <device>       stop future key delivery; already received keys remain known
                                        approve on another paired phone, or sign in again with GitHub
  pullboard relay tokens                list this board's agent token ids, agents and expiry, never credentials
  pullboard relay revoke <token-id>     revoke one token from that list; other agents keep working
  pullboard relay recover --skip <sequence>  person-only recovery of one blocked next relay position
  pullboard handoff [--take <id>]        write or take an agent hand-off; keep questions on its item
  pullboard heartbeat                 record this seat's local session activity; no board move
  pullboard resume [--diagnostics]      where you are: your claim, branch, what came back,
                                        unread shouts, what to do next; run it to start any session
  pullboard badge                       write board-derived Shields endpoint JSON to docs/badges/
  pullboard hooks [uninstall]           install Git hooks and agent nudges; uninstall removes only Pullboard's agent nudges
  pullboard hook SessionStart|Stop|SessionEnd     native agent nudges; errors/timeouts warn and never block

Work
  pullboard map [<module or function>] [--for <item>] [--budget <tokens>]  source map for main, a card, or an item's one-hop slice
                                        slices default to 4k tokens and cap at 8k; effects the scan cannot see say "not detected"
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>] [--private]
                [--brief "..." | --brief-file <file>] [--route light|mid] [--review-family <family>]
                                        --after: ids or repo#id; claiming waits for verified items on their own boards
                                        --review-family: require that declared family; case-insensitive, never guessed from model
                                        --brief: what a cold agent needs; --route light: any model can build it
                                        --private: keep this item in your device-local board for this repo
  pullboard move <handle#id|owner/handle#id|~handle#id|id> --to <handle|owner/handle|~handle> [--private]
                                        --private makes a bare item ID refer to this repo's device-local board
                                        move one open or verified item between this repo's team and private boards; old IDs forward
                                        private references start with ~; ambiguous bare handles require owner/handle
                [--check "<command>"] [--wait]   the command that proves it; --wait waits for its main baseline
                                        with --criterion and a brief, --check is needed below strong
  pullboard edit <id> [--brief "..." | --brief-file <file>] [--route light|mid|strong] [--criterion "..."] [--check "..."]
                [--review-family <family>]   require the declared reviewer family
                [--wait]                wait for a new check's baseline; otherwise it runs in the background
                [--reason "what the old bar got wrong"]   needed to change the criterion or check of an item
                                        that was ever claimed; show and stats list each correction
  pullboard escalate <id> --note "what was tried and how it failed"   hand it one tier up
  pullboard run --agent "<command>" [--attempts 3] [--minutes 15] [--items N] [--wait M]
                                        build routed items unattended in this worktree: the agent command reads
                                        the context pack at $PULLBOARD_PACK (and $PULLBOARD_CHECK, $PULLBOARD_ITEM,
                                        $PULLBOARD_ATTEMPT, $PULLBOARD_TIER); green work is submitted, red escalated
                [--agent-light "..."] [--agent-mid "..."] [--agent-strong "..."]   a command per tier
  pullboard list [lane] [--all] [--route light|mid|strong]   open and active items; --all adds closed ones
  pullboard queue                       the work queue in pull order: releases, then route, lane, holder, waits,
                                        and each item's unblock count, effort and why it sits there
  pullboard roadmap                     ordered milestones, N/M landed, targets, and each item as landed,
                                        accepted or its status
  pullboard milestone add <name> [--note ...] [--items 1,2,3]   create a milestone and optionally add items
  pullboard milestone items <name> --add ids [--swap id]   add items; --swap replaces an existing item
  pullboard milestone items <name> --remove ids            remove items from the milestone
  pullboard milestone order <name> <ids>                       rank these items within their milestone (agents)
  pullboard milestone pin|sink <name> <ids> --reason "<why>"   hold items above or below the queue's own order
  pullboard milestone lift <name> <ids>                        return pinned or sunk items to the queue's order
  pullboard milestone move <name> --before <other>             reorder a milestone
  pullboard milestone edit <name> [--name <new>] [--note <text>] [--target <date and time>|none] [--limit <n>|none]
                                        rename, update a note, or set a shipping target or item limit
  pullboard milestone ship <name> [--next <name>]              record it shipped at main's commit and move
                                        its unlanded items into the next milestone (or --next)
  pullboard milestone remove <name>                            remove a milestone without changing its items
  pullboard doctor                     check board integrity without changing it
  pullboard health                     every stuck item: why, since when, the next step and who takes it
  pullboard sentinel propose <name> --check "<command>" --every 10m|hourly|daily --owner <seat or lane> [--directory <path>] [--timeout <milliseconds>] [--next "<step>"]
                                        propose an exact board watch; only the person may approve it
  pullboard sentinel approve <name>     person: approve this command, directory and schedule
  pullboard sentinel run [--health-only]  run due approved watches, or only scan board health
  pullboard sentinel decline <name> --reason "<why>"   person: prevent future runs
  pullboard sentinels                   approvals, owners and the last result; does not run checks
  pullboard loop declare <name> --every 10m --owner <seat or lane>   coordinator: declare a recurring job's cadence
  pullboard loop ran <name>             record that a recurring job just ran; health flags one silent for 1.5 cadences
  pullboard loop                        list the recurring jobs and their last runs
                                        reads the board and changes nothing; exits 1 when something is stuck
                                        pullboard.json health.stuck (default 1h), health.holds (1d), health.release (1d)
  pullboard skills --update            refresh unchanged Claude Code skills from shipped versions
  pullboard patch attach <item> <file> --key <key> --author <seat> [--source <submittedSHA>]
                                        coordinator: bind a companion patch to the exact submitted source
  pullboard patch list <item>            read its ordered native patches and patch-set digest
  pullboard patch remove <item> <key>    coordinator: stop applying a patch; retain its author history
  pullboard companion <parent> <lane> "<title>" --key <key> [--criterion "<criterion>"] [--specs <ids>]
                                        create one child in another lane; repeat the same parent, lane and key to find it
                                        --brief "<brief>"; --route strong|mid|light; only the coordinator sets --check "<command>"
  pullboard show <id> [--history]       an item, the criterion frozen at claim, its verdicts: the latest in full,
                                        earlier ones as one line; --history prints every note in full
  pullboard fact <id> <kind> <text> [--answers <bar-check-fact-id>] [--supersedes <fact-id>] [--ref path:lines@full-sha] [--implies <ids>]
                                        append item notes (question, answer, plan, risk), evidence or authorised judgements
                                        a bar-answer uses --answers to name the bar-check fact it reviewed
                                        --implies 12,13: each named item gets a fact citing this decision,
                                        and is told again when the decision is superseded
                                        the person adds --cause <key> --never-again --as person: rigor lists it at once
  pullboard why <id>                    the decisions that imply an item, newest first, and what superseded them
  pullboard why <file>[:<line>]         the decisions, rows and items behind a file or line, each with its origin
  pullboard next [--wait <minutes>]     offer an eligible review when reviews pile up, otherwise claim work
  pullboard next --take                 reserve an independent review first, otherwise claim eligible work in this seat
  pullboard next --build                claim a build explicitly, recording a skipped review offer
  pullboard next --verify               reserve the next submitted item you can check;
  pullboard next --verify <id>          reserve that submitted item instead
                                        in the main checkout, verifying needs --as coordinator
  pullboard check [id] [--yes]          show and run your item's check; --yes confirms a check set by someone else
                                        the command and its author print first; the project gate is pullboard gate
  pullboard test <files>                run named test files on the runner pool with the per-file timeout, uncommitted
                                        changes included; a red file is compared with main and named known or new
                                        --affected selects the change and its accepted registry guards; no files needed
  pullboard check accept <id>           the person accepts an item's check that already passes on main, as it reads now;
                                        with checks.provesNothing "hold", claim and submit refuse that item until then
  pullboard bar ready [on|off]           coordinator: opt in to ready bars; existing frozen work needs no backfill
  pullboard bar sign <id> --note "..." [--coverage-file <json>]  another parent judges buildability and repeatable grading; edits clear the signature
                                        claim.barTestFiles configures project test-path globs (Node test/spec files by default)
                                        coverage rows retain whole-file observations; slow files require named checks and explicit landing coverage
  pullboard bar <id>                    show missing prerequisites and the current revision
  pullboard claim <id>                  take or renew a lease; the first claim freezes the criterion
  pullboard release <id> [--stale --note "why"]  hand it back; coordinator --stale requires measured inactivity and a note
  pullboard submit <id>                 needs a clean tree, item check and affected tests green at HEAD (alias: done)
                                        --infra "<why>": required when the change edits an existing test or gate file; the reviewer reads it in show
  pullboard verify <id> accept --note "what you broke or which edge you tried, and what happened"
  pullboard verify <id> reject --reason TEST_FAILURE --note "what failed" [--cause <key>]
                                        a cause is test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>
                                        a verdict takes --implies <ids>; a later verdict on the item supersedes it
                                        any --note can be --note-file <file>, which keeps quotes, $ and backticks intact
  pullboard shout <lane|agent|person|all> <text>  pullboard inbox
  pullboard inbox --acted-on <interrupt-ids>     acknowledge comma-separated ids only after acting; reading is not acting
  pullboard shout --item <id> <text>             message the item builder, reviewer and coordinator
  A seat shout to all reaches only coordinator and person; their broadcasts reach everyone.
  pullboard shout coordinator <text> --kind question|blocker --decision  route through a named lane lead
  pullboard lanes lead <lane> <seat|off>          coordinator names or removes the existing lane seat
  pullboard shout all <text> --news              coordinator/person release or focus news, digested at session start
  Inbox combines direct coordination with item/dependency, file and cited-row activity; other lane activity is summarized.
  pullboard shout [<to>] <text> --decision       ask for a decision; defaults to your coordinator or the person
  pullboard shout coordinator <question> --item <id> --decision --options <json>
  pullboard shout coordinator <question> --decision --effects <json>
    Concrete effects compute whose call it is from current rows; declarations grant no execution authority.
                                        ask an item decision with choices, as --options '["first","second"]'
  pullboard shout <to> <text> --evidence attempt|receipt --outcome <word> --item <id> --commit <rev>
  pullboard answer <shout-id|repo#id> <text> [--as person]
                                        answer your decision; person mode is main-checkout only
                                        repo#id answers a sibling repo's decision on its own board
                                        Other options: [--implies <ids>] [--supersedes <answer-id>]
                                                      [--origin person-relayed|agent|inherited] [--rationale <why>]
                                        --supersedes tells the items an earlier answer implied; only the person
                                        supersedes the person's answer
  pullboard pass <shout-id> <note>                lead escalates to coordinator; coordinator passes to person
  pullboard request reopen|hold|withdraw|reroute <id> --cause <key> [--route light|mid|strong] [--note "why"]
                                        queue a typed coordinator move; reroute needs --route
                                        Causes: routing-assignment, bar-ambiguity, proof-red-tests, design-choice,
                                                conflicting-rulings, person-authority, tool-defect
  pullboard request list [--all]        list pending requests; --all includes answered requests
  pullboard request answer <ids> done|declined [--note "why"] [--acted-on <event-ids>]
                                        coordinator answers a comma-separated batch atomically; declined needs a note
                                        done needs matching native move event IDs in request order; it never executes a move
  pullboard decisions [--as person]               shouts waiting for you; main checkout defaults to coordinator
                                        as the person, a project's repos list together as repo#id
  pullboard watch [--to <agent|lane|all>] [--kinds <kinds>] [--item <id>] [--since <sequence>] [--json]
                [--work <lane>] [--review-wait <minutes>]
                                        follow the board's live events, one line each as it happens, with or without the view
                                        --work also says when an item there becomes claimable, a review waits longer than
                                        --review-wait minutes (default 20), or main moves; Ctrl-C stops it
  pullboard export                              print the whole board as versioned JSON
  pullboard digest [--out <file>] [--watch]     a short Markdown briefing of this board for a person or a chat assistant;
                                        secrets redacted; --out replaces a file, --watch rewrites it after every move
  pullboard import <file>                       restore a versioned export into an empty board
  pullboard sync                               opt in to sharing one board through origin without an account
                                               reads work offline; moves need remote acknowledgement

Coordinator
  pullboard sweep --run "<checker>" --check "<checker on {file}>" [--route light] [--max 20] [--dry-run]
                                        file one item per file a linter, type checker or test reporter flags
  pullboard land [--max N] [--dry-run] [--adopt]  gate and push a durable batch of verified items
  pullboard land --due [--dry-run]       coordinator: use configured age/count; no --max or --adopt; explain when not due
  pullboard land --waive <test> --until <date> --reason \"why\"  the person records an expiring test waiver
  pullboard publish                     coordinator: run the whole suite on the trunk head; push it only when every test passes
  pullboard merged <id> <commit>        record where verified work landed
  pullboard withdraw <id> <reason>      drop an item nobody should build
  pullboard refreeze <id>               adopt a corrected criterion or changed spec rows
  pullboard reopen <id> [--withdraw-verdict] --note "why" [--cause <key>]
                                        withdraw your own accept before landing, or coordinator-return a submission
  pullboard reopen <id> --conflict <file> [--conflict <file>]
                                        return accepted work that conflicts with the trunk for a main merge
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <id> "reason" [--until verified|landed]  hold until the next named event on this item
  pullboard hold <lane|id> --off        lift a lane or item hold

Receipts
  pullboard flow replay [--history <json>] [--policy <json>]  reproduce recorded flow or predict another item order and WIP limits
                                        --json includes text-free structural history; policy order is recorded or item ids, settings use modelled board line-control names (unsupported names are refused)
  pullboard stats [--since <date> | --window <duration>]  proof numbers from the event log; --json for sites and tools
                                        --window 6h (also 30m or 1d): landed-item stage quartiles, tails and excess over targets;
                                        includes all attempts and sent-back idle; missing intervals stay unmeasured;
                                        stage averages/medians count ends inside the inclusive UTC window;
                                        build: first claim to final submit (including rework);
                                        review wait: final submit to the closing review reservation;
                                        released/expired reservations remain wait, not review;
                                        review: closing reservation to verdict; merge wait: accept to first merge
                                        unfinished stages are omitted; missing legacy reservations are unmeasured
                                        flow.report is all-time, even with --since or --window; its disjoint stages are
                                        ready, later, build, reviewWait, review, mergeWait and rework;
                                        initial focus/dependency/hold delays are later; returned work is rework until claim;
                                        firstTry measures acceptance of the first submission; size buckets use that submission:
                                        under 100, 100-299, 300-799, 800+ changed lines; missing history stays unknown
                                        JSON flow.asOf records one observation clock; oldest.since records its origin;
                                        ageMinutes = (asOf - since) / 60000 for every queue age
                                        queues include all current work, even added before --since;
                                        open age restarts on add, reopen, reject, release or claim lapse;
                                        claimed age starts at claim (not renewal), submitted at final submit,
                                        accepted-not-merged at accept; oldest ties use the lower item id
                                        daily additions and first merges use UTC dates; repeated merge receipts count once
                                        active agents moved in the last 60 minutes (inclusive), by role and lane;
                                        role is latest role-bearing move, falling back to earlier history or unknown:
                                        claim/submit/build release = builder; reserve/verdict/review release = verifier;
                                        the coordinator is coordinator; shouts and joins never imply a role
                                        bottleneck: largest summed stage share over fully measured first-merge cycles;
                                        ties: build, review wait, review, merge wait; print fully measured/total cycles;
                                        fewer than half fully measured means low confidence; no measured cycles means no action
                                        one action, first matching rule:
                                        review wait + fewer than 1 verifier per 4 active builders: add a verifier
                                        review wait otherwise: review the oldest submission first (#N)
                                        build + more than 30% sent back: tighten criteria or briefs: N of M submissions were sent back
                                        build otherwise: add a builder in the lane with most open items (lane-name tie)
                                        review: reviews are slow (median X min): check how long the frozen checks take
                                        merge wait: land the accepted items: #A, #B
                                        when that queue is empty, the action says none waiting or waits for open work
  pullboard ledger                      markdown: what was built, by whom, verified by whom
  pullboard test-value                   fourteen-day per-file runs, code-fixed catches, flakes, runtime, edits and value; --json
                                        report-only costs in pullboard.json testEconomics: costOfEscape 3600, costOfWaiting 1, costOfFalseRed 300
                                        runtime gaps remain unknown; no test admission policy changes
  pullboard log [id]                    every move, in order
  pullboard flakes                      recorded failures, their first and last sightings, counts and repair status
  pullboard flakes rerun on|off          coordinator: opt into one diagnostic pair per failed test; off by default
  pullboard flakes quarantine on|off     coordinator: let a proven flake stop blocking landings until its repair item is verified; off by default
                                        commit pullboard.json to apply; a passing diagnostic never turns the original red green
  pullboard rigor                       failure causes that repeated: on 2 items, or 1 item at 2 commits;
                                        each with its items and whether it reads as work, product or both
  pullboard rigor --draft-splits        coordinator on main: draft review-gated split proposals for files colliding on 2 items in 14 days; only the person approves
  pullboard rigor quality [--base <commit>] [--head <commit>] [--rule <key>] [--budget <lines>]
                                        the person's quality rules broken by this change since main, as path:line: rule: what broke
                                        rules: fix-test, fails-closed, silent-catch, guard-mutation, size-budget, root-cause-control
  pullboard rigor --draft-quality       coordinator on main: draft each quality rule as a Doctrine row with its check; only the person approves
  pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit> [--section <letter>]
                                        --red is a noticed failure commit; prove its check red, then green at --green
                                        draft Doctrine (work), spec (product) or both; only the person approves
                                        test: causes need literal node --test <file> and the named test actually failing, then passing

Spec
  pullboard spec --json                 parsed SPEC.md and doctrine rows as JSON
  pullboard forget <path>               remove a repo from this machine's project list
  pullboard spec check                  lint SPEC.md and the doctrine (house rules for agentic development)
  pullboard spec view [--out file]      the spec, open questions, sign-offs and doctrine as one page
  pullboard spec show <id> | unmet [--must] | signoff <ids> [--by <principal>]
  pullboard spec verify <id> accepted|rejected --reason "why"  record an outside-parent verdict
                                        signoff: --note "what was checked" stays with the receipt
  pullboard spec draft <text> [--section <letter>] [--aim] [--gate "<gate>"]  any agent appends a draft row; never approves it
  pullboard spec draft <text> --revises <id> --reason "why" [--gate "<gate>"] [--status <status>]  propose an approved-row change in Needs you
                [--doctrine --source "<shout id or chat, date>"]  the coordinator proposes a sourced doctrine ruling
                                        --section chooses the section prefix; defaults to G, or DR with --doctrine
                                        Defaults to must and gate review.
  pullboard blueprint add <name or file> [--blueprint <name or file>]...  add a blueprint's rules and questions as drafts, and its starter items
                                        bundled: web-app; nothing is approved, and a repeat adds nothing
                                        several land in order: one product, one architecture, any practice; a shared rule is drafted once
  pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]  propose this repo's fit; nothing applies yet
  pullboard spec fit [approve <batch>] | fit edit <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]  the person's fit batch
  pullboard blueprint save [file] [--name <name>] [--title "<title>"]  write approved rules and answered questions as a blueprint
                                        never items, notes, paths, emails or names; file defaults to <project>.blueprint.json
  pullboard blueprint starters <name or file>  list a blueprint's starter items and whether each is filed
                                        a filed starter shows its item id and status; add links each starter it files with a note fact
  pullboard spec signers add [--key <path>] [--by <principal>]  opt into SSH-signed sign-offs
                                        principal defaults to Git user.email; --by overrides it
  pullboard spec approve <ids> | decline <ids> --reason "why"  the person's exact-row decision
                                        approve <id> --text "new wording" approves an exact rewrite
  pullboard spec answer <id> "<choice or text>"  the person's answer to a pending question
                                        a listed choice, or their own words added as the last choice
  pullboard spec apply                  coordinator applies recorded row decisions to the files
  pullboard doctrine check              each doctrine rule's check: its count, its committed count, whether it holds
                                        a rule row adds | gate: check <command> | count: N, and | files: <paths> to narrow it
                                        the command prints one line per problem and exits 0 or 1; anything else cannot count
                                        submit refuses a touched rule whose count rises; runs: nightly skips submit, mode: watch only counts

Role guides
  pullboard prompt decompose|plan|signoff|review|verify|run|triage   how to do each role; Claude Code gets them as skills

Gate and hooks
  pullboard push-receipts               additive check of Git pre-push stdin, native receipts and accepted-policy smoke; does not replace the active hook
  pullboard gate [--landing]            run the configured gate; prioritize a trunk landing in the machine queue
  pullboard gate set "<command>"         record the project gate in the main checkout; commit it before running the gate
  pullboard hook pre-commit|pre-merge-commit|commit-msg|pre-push   git runs these

${lifecycleHelp()}

Reject reasons: TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER.
--json prints one versioned document for every command, and one per line for watch; refusals include their code and next step.`;

const HELP_GROUPS = [
  ['Start', ['tour', 'init', 'worktree']],
  ['Work', ['add', 'list', 'claim']],
  ['Review', ['submit', 'next', 'verify']],
  ['See', ['status', 'view', 'log']],
];

// The add example runs as pasted on a board init just made, which has no web lane and no G1 row (#721).
const ADD_EXAMPLE = ['pullboard lane add web --owns src/web', 'pullboard spec draft "A person can upload a page"',
  'pullboard add web "Upload page" --specs G1'].join('\n');

const HELP_EXAMPLES = {
  'settings line': `pullboard settings line reviewsFirst on --reason "reviews are waiting" --window '{"windowMinutes":60}'`,
  'spec approve': 'pullboard spec approve G1',
  'spec decline': 'pullboard spec decline G1 --reason "The requirement needs revision"',
  'sentinel propose': 'pullboard sentinel propose "Run the checks" --check "npm test" --every hourly --owner web',
  tour: 'pullboard tour', init: 'pullboard init --blueprint web-app', worktree: 'pullboard worktree web --model "my-model"',
  join: 'pullboard join web --model "my-model"', resume: 'pullboard resume',
  intake: 'pullboard intake https://github.com/owner/repo/pull/7 --criterion "behavior" --check "npm test"',
  patch: 'pullboard patch list 12',
  companion: 'pullboard companion 12 api "Provide the API" --key api-part',
  add: ADD_EXAMPLE, move: 'pullboard move ~web#3 --to web', list: 'pullboard list web', show: 'pullboard show 12',
  claim: 'pullboard claim 12', submit: 'pullboard submit 12', 'next --verify': 'pullboard next --verify',
  fact: 'pullboard fact 12 measurement "The check passes in 8 seconds"',
  why: 'pullboard why 12',
  flakes: 'pullboard flakes', 'flakes rerun': 'pullboard flakes rerun on', 'flakes quarantine': 'pullboard flakes quarantine on',
  verify: 'pullboard verify 12 accept --note "removed the fix; the test failed"',
  request: 'pullboard request hold 12 --cause routing-assignment --note "Wait for the prerequisite"',
  watch: 'pullboard watch --to web', answer: 'pullboard answer 12 "done"', pass: 'pullboard pass 12 "please decide"',
  status: 'pullboard status', view: 'pullboard view', digest: 'pullboard digest --out briefing.md', mcp: 'pullboard mcp', flow: 'pullboard flow replay --json', stats: 'pullboard stats --since 2026-10-08', log: 'pullboard log 12', ledger: 'pullboard ledger',
  relay: 'pullboard relay on --all', 'relay recover': 'pullboard relay recover --skip 12', sync: 'pullboard sync',
  'lane add': 'pullboard lane add web --owns apps/web/', lane: 'pullboard lane add web --owns apps/web/',
  queue: 'pullboard queue', roadmap: 'pullboard roadmap', rigor: 'pullboard rigor', 'rigor quality': 'pullboard rigor quality --rule silent-catch', 'rigor draft': 'pullboard rigor draft "refusal:MERGE_LOST" "Merges keep every hunk" --check "node bin/checks/merges.js" --red 0123456 --green 89abcde', milestone: 'pullboard milestone add "0.7.0" --items 12,13',
  'milestone order': 'pullboard milestone order "0.7.0" 13,12',
  'milestone pin': 'pullboard milestone pin "0.7.0" 13 --reason "the release notes need it first"',
  'milestone sink': 'pullboard milestone sink "0.7.0" 12 --reason "waits on a design answer"',
  'milestone lift': 'pullboard milestone lift "0.7.0" 12,13',
  runner: 'pullboard runner add studio --slots 2 --browser 1', 'runner add': 'pullboard runner add studio --slots 2 --browser 1',
  edit: 'pullboard edit 12 --brief "Add the upload page"', release: 'pullboard release 12',
  land: 'pullboard land --max 4',
  map: 'pullboard map',
  publish: 'pullboard publish',
  handoff: 'pullboard handoff --take 12',
  health: 'pullboard health',
  reopen: 'pullboard reopen 12 --note "correct the frozen criterion"',
  escalate: 'pullboard escalate 12 --note "needs a manual step"', next: 'pullboard next',
  run: 'pullboard run --agent "node agent.js"', 'view export': 'pullboard view --export ./site',
  'spec check': 'pullboard spec check',
  doctrine: 'pullboard doctrine check', 'doctrine check': 'pullboard doctrine check',
  'spec view': 'pullboard spec view', 'spec show': 'pullboard spec show G1',
  'spec draft': 'pullboard spec draft "Describe the first requirement"', 'blueprint starters': 'pullboard blueprint starters web-app',
  'blueprint add': 'pullboard blueprint add web-app', 'blueprint save': 'pullboard blueprint save',
  'blueprint fit': 'pullboard blueprint fit web-app G1 keep --reason "the repository already meets this row"',
  'spec fit': 'pullboard spec fit',
  'spec unmet': 'pullboard spec unmet', 'spec signoff': 'pullboard spec signoff G1',
  'spec signers add': 'pullboard spec signers add', help: 'pullboard help claim', version: 'pullboard --version',
};

const HELP_ALIASES = {
  help: { usage: 'pullboard help', source: null },
  version: { usage: 'pullboard version', source: null },
  whoami: { usage: 'pullboard whoami', source: 'whoami' },
  lanes: { usage: 'pullboard lanes', source: 'whoami' },
  agents: { usage: 'pullboard agents', source: 'whoami' },
  lane: { usage: 'pullboard lane add <name> --owns <path>[,<path>]', source: 'lane add' },
  status: { usage: 'pullboard status [--all]', source: 'whoami' },
  done: { usage: 'pullboard done <id>', source: 'submit <id>' },
  inbox: { usage: 'pullboard inbox', source: null, extraFlags: ['--acted-on <interrupt-ids>'] },
  'check accept': { usage: 'pullboard check accept <id>', source: 'check accept' },
  relay: { source: 'relay', every: true },
  lifecycle: { usage: 'pullboard lifecycle', source: null },
  escalate: { usage: 'pullboard escalate <id> --note "..." [--note-file <file>]', source: 'escalate <id> --note "what was tried and how it failed"', extraFlags: ['--note-file <file>'] },
  'view export': { usage: 'pullboard view --export <dir>', source: 'view' },
  blueprint: { usage: 'pullboard blueprint add <name or file>, then a seat runs pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer, then the person runs pullboard spec fit approve <batch>', source: 'blueprint add' },
  'blueprint add': { usage: 'pullboard blueprint add <name or file> [--blueprint <name or file>]...', source: 'blueprint add' },
  'blueprint fit': { usage: 'pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]', source: null, onlyFlags: ['--text', '--reason'] },
  'spec fit': { usage: 'pullboard spec fit [approve <batch>] | fit edit <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]', source: null, onlyFlags: ['--text', '--reason'] },
  'spec check': { usage: 'pullboard spec check', source: 'spec check' },
  'spec view': { usage: 'pullboard spec view [--out file]', source: 'spec view' },
  'spec show': { usage: 'pullboard spec show <id>', source: 'spec show', onlyFlags: [] },
  'spec approve': { usage: 'pullboard spec approve <ids>', source: 'spec approve', onlyFlags: [] },
  'spec decline': { usage: 'pullboard spec decline <ids> --reason "why"', source: 'spec approve', onlyFlags: ['--reason'] },
  'spec unmet': { usage: 'pullboard spec unmet [--must]', source: 'spec show', onlyFlags: ['--must'] },
  'spec signoff': { usage: 'pullboard spec signoff <ids> [--by <principal>] [--note "..."] [--note-file <file>]', source: 'spec show', onlyFlags: ['--by', '--note', '--note-file'], extraFlags: ['--note-file <file>'] },
  'spec signers': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  'spec signers add': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  doctrine: { usage: 'pullboard doctrine check', source: 'doctrine check' },
  hook: { usage: 'pullboard hook SessionStart|Stop|SessionEnd|pre-commit|pre-merge-commit|commit-msg|pre-push', source: 'hook' },
  'gate set': { usage: 'pullboard gate set "<command>"', source: 'gate set' },
  'hook pre-commit': { usage: 'pullboard hook pre-commit', source: 'hook' },
  'hook pre-merge-commit': { usage: 'pullboard hook pre-merge-commit', source: 'hook' },
  'hook commit-msg': { usage: 'pullboard hook commit-msg <file>', source: 'hook' },
  'hook pre-push': { usage: 'pullboard hook pre-push', source: 'hook' },
};

const HELP_FLAG_EXPLANATIONS = {
  '--take': 'next: take one eligible item in this seat; handoff: take the named existing hand-off',
  '--after': 'ids or repo#id; claiming waits for verified items on their own boards',
  '--blueprint': 'start from a bundled blueprint or a JSON file; repeat it for one product, one architecture and any practice blueprints',
  '--brief': 'what a cold agent needs',
  '--check': 'the command that proves it',
  '--conflict': 'one conflicting file, exactly as Git names it; repeat it for each file',
  '--doctrine': 'proposes a doctrine ruling; only the person can approve it',
  '--family': 'records the family name',
  '--model': 'identifies the agent model; required unless PULLBOARD_MODEL is set',
  '--implies': 'each named item gets a fact citing this decision',
  '--landing': 'prioritizes a trunk landing in the machine gate queue',
  '--json': 'prints one versioned document',
  '--note': 'what was checked stays with the receipt',
  '--note-file': 'keeps quotes, $ and backticks intact',
  '--private': 'keeps an added item in this device-local repo board, or selects that board for move IDs',
  '--route': 'sets which work the model can take',
  '--source': 'where the person gave the ruling; required with --doctrine',
};

/** Lines a command's own help adds after its example. */
const HELP_NOTES = {
  status: [
    'Counts include live, idle and gone identities; plain text lists only live and idle seats.',
    '--all includes gone seats. JSON retains the full identity history and presence counts.',
  ],
  resume: [
    'Ordinary resume reads the current work card and recorded health without running diagnostics or watches.',
    'Use --diagnostics explicitly for setup, hooks, dirty files and stale-work checks.',
  ],
  'sentinel run': [
    'Schedule this command with cron on a server or a scheduled CI job that already has ordinary board access.',
    'For example: 0 * * * * cd /path/to/project && pullboard sentinel run',
    'Each run prepares committed local trunk; resume and the background view never execute watch commands.',
    'It also refreshes work-health findings; resume shows only the indexed findings and their recorded time.',
  ],
  watch: [
    'Claude Code: run pullboard watch --to <your id> under the Monitor tool, and each event line wakes the seat.',
    'Any other harness: run it as a long-running command and treat each stdout line as an event.',
  ],
};

/** Build command-specific help rows from the preserved full list so its syntax stays authoritative. */
function commandHelpRows(fullHelp, commandNames) {
  const lines = fullHelp.split('\n');
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('  pullboard ')) continue;
    const details = [lines[index].trim()];
    for (let next = index + 1; next < lines.length && lines[next].startsWith(' ') && lines[next].trim() && !lines[next].startsWith('  pullboard '); next += 1) details.push(lines[next].trim());
    rows.push({ usage: lines[index].trim().slice('pullboard '.length).split(/\s{2,}/, 1)[0].trim(), details });
  }
  const names = [...new Set([
    ...commandNames,
    ...Object.keys(HELP_ALIASES),
    ...Object.keys(HELP_EXAMPLES).filter((name) => /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u.test(name)),
    ...rows.map((row) => commandWords(row.usage)[0]).filter(Boolean),
    // Every printed subcommand phrase (milestone items, relay devices) is a name too, so its help exists [N2].
    ...lines.filter((line) => line.startsWith('  pullboard ')).flatMap((line) => usagePhrases(line.trim())).filter((phrase) => phrase.includes(' ')),
  ])];
  const entries = Object.fromEntries(names.map((name) => {
    const parts = name.split(' ');
    const alias = HELP_ALIASES[name];
    const matches = alias?.source ? rows.filter((row) => row.usage === alias.source || row.usage.startsWith(`${alias.source} `)) : alias ? [] : rows.filter((row) => {
      const tokens = row.usage.split(/\s+/u);
      if (!parts.every((part, index) => tokens[index] === part)) return false;
      const next = tokens[parts.length];
      return !next || next.startsWith('--') || next.startsWith('<') || next.startsWith('[') || next === '|';
    });
    const usages = alias && !alias.every ? [alias.usage] : matches.length ? [...new Set(matches.map((row) => `pullboard ${row.usage}`))] : [`pullboard ${name}`];
    const foundFlags = [...matches.flatMap((row) => row.details.flatMap((line) => line.match(/--[a-z][a-z-]*(?:\s+(?:<[^>]+>|"[^"]*"|\[(?!-)[^\]]+\]|[A-Za-z][A-Za-z0-9|_-]*))?/gu) ?? [])), ...(alias?.extraFlags ?? []), '--json', '--help', ...(name === 'help' ? ['--all'] : [])];
    const flagMap = new Map();
    for (const flag of foundFlags) {
      const key = flag.split(/\s/u, 1)[0];
      if (alias?.onlyFlags && !alias.onlyFlags.includes(key) && !['--json', '--help'].includes(key)) continue;
      if (!flagMap.has(key) || flagMap.get(key).length < flag.length) flagMap.set(key, flag);
    }
    const flags = [...flagMap.values()].map((flag) => {
      const explanation = HELP_FLAG_EXPLANATIONS[flag.split(/\s/u, 1)[0]];
      return explanation ? `${flag} — ${explanation}` : flag;
    });
    const example = exampleFor(name, usages[0]);
    return [name, Object.freeze({ usages, flags, example, notes: HELP_NOTES[name] ?? [] })];
  }));
  return { ...entries, ...settingFormHelp(entries) };
}

/** Render the short first-run overview, with command names grouped by when a person needs them. */
function overviewHelp(groups, firstRun = false) {
  const pointer = 'New here? pullboard tour, then pullboard init.';
  const description = 'Pullboard is a local-first work board for coding agents; nothing ships until a second agent verifies it.';
  const lines = [
    ...(firstRun ? [pointer, description] : [description, pointer]),
    '',
  ];
  for (const [group, names] of groups) lines.push(group, ...names.map((name) => `  pullboard ${name}`));
  lines.push('', 'More: pullboard help <command>; pullboard help --all for the full list.');
  return lines.join('\n');
}

/** The settings forms settingsCommand dispatches with a value; each gets its own help, from this list (N2). */
export const SETTING_FORMS = Object.freeze(['gateSlots', 'browserSlots', 'gate.shortSlots', 'gate.runnersFirst', 'gate.runnerWaitMs', 'landing.pool']);

/** Help for each settings form the printed usage did not already name, so each form is covered (N2). */
function settingFormHelp(commands) {
  return Object.fromEntries(SETTING_FORMS.filter((form) => !commands[`settings ${form}`]).map((form) => [`settings ${form}`, Object.freeze({
    usages: [`pullboard settings ${form} ${form === 'landing.pool' ? 'on|off' : '<n>'}`], flags: [],
    example: `pullboard settings ${form} ${form === 'landing.pool' ? 'on' : '2'}`, notes: [],
  })]));
}

/**
 * Build help from the actual command declarations, preserving the printed overview and full list.
 *
 * @param {string[]} [commandNames]
 * @returns {Readonly<object>}
 */
export function buildHelp(commandNames = []) {
  return Object.freeze({
    overview: overviewHelp(HELP_GROUPS),
    firstRun: overviewHelp(HELP_GROUPS, true),
    all: ALL_HELP,
    groups: HELP_GROUPS,
    commands: Object.freeze(commandHelpRows(ALL_HELP, commandNames)),
  });
}

/** Browser consumers read pure help declarations without initializing the CLI or server. */
export const HELP = buildHelp();

/** Replace help placeholders with ordinary values so every command receives a usable example. */
function exampleFor(name, usage) {
  if (HELP_EXAMPLES[name]) return HELP_EXAMPLES[name];
  return usage.split(/\s+\|\s+/u, 1)[0]
    .replace(/\s+\[[^\]]+\]/gu, '')
    .replace(/<lane>/gu, 'web')
    .replace(/<title>/gu, '"Example"')
    .replace(/<id>/gu, '12')
    .replace(/<file>/gu, 'board.json')
    .replace(/<path>/gu, 'src/cli.js')
    .replace(/<commit>/gu, '0123456')
    .replace(/<principal>/gu, 'person@example.invalid')
    .replace(/<[^>]+>/gu, 'value')
    .replace(/\|[^\s|]+/gu, '');
}

/** Read literal command words before an argument, flag or optional segment. */
function commandWords(usage) {
  const words = [];
  for (const word of usage.trim().split(/\s+/u)) {
    if (!/^[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*$/u.test(word)) break;
    words.push(word);
  }
  return words;
}

/** Expand literal alternatives in a command phrase without including argument values. */
function expandWords(words) {
  let phrases = [''];
  for (const word of words) phrases = phrases.flatMap(prefix => word.split('|').map(choice => (prefix + ' ' + choice).trim()));
  return phrases.filter(Boolean);
}

/** Read one printed usage, including sibling commands and optional literal subcommands. */
function usagePhrases(usage) {
  const row = usage.replace(/^pullboard\s+/u, '').split(/\s{2,}/u, 1)[0];
  const branches = row.split(/\s+\|\s+/u);
  const first = commandWords(branches[0]);
  const shared = branches.length > 1 ? first.slice(0, -1) : [];
  const phrases = [];
  for (const [index, branch] of branches.entries()) {
    const inherited = index && !/^pullboard\s/u.test(branch) ? shared : [];
    const command = branch.replace(/^pullboard\s+/u, '');
    const words = [...inherited, ...commandWords(command)];
    phrases.push(...expandWords(words));
    const optional = command.match(/^(.*?)\[([^\]]+)\]/u);
    if (optional && optional[2].includes('|') && !optional[2].trim().startsWith('-')) {
      const prefix = [...inherited, ...commandWords(optional[1])];
      for (const choice of optional[2].split('|')) phrases.push(...expandWords([...prefix, ...commandWords(choice)]));
    }
  }
  return phrases;
}

/** Derive every printed command phrase and declared alias, with longer phrases before prefixes. */
export function commandPhrases(help = HELP) {
  const phrases = new Set();
  for (const line of help.all.split('\n')) {
    if (line.startsWith('  pullboard ')) for (const phrase of usagePhrases(line.trim())) phrases.add(phrase);
  }
  for (const [name, declaration] of Object.entries(help.commands)) {
    phrases.add(name);
    for (const usage of declaration.usages) for (const phrase of usagePhrases(usage)) phrases.add(phrase);
  }
  return [...phrases].sort((left, right) => right.length - left.length || left.localeCompare(right));
}
