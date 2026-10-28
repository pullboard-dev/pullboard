/** Preserved work command-group help, composed in its original display order. */
export const workHelp = `Work
  pullboard map [<module or function>] [--for <item>] [--budget <tokens>]  source map for main, a card, or an item's one-hop slice
                                        slices default to 4k tokens and cap at 8k; effects the scan cannot see say "not detected"
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>] [--private]
                                        --sensitive or --review-family <family> selects Strict review; edit can set them while open
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
  pullboard release <id> [--no-next] [--stale --note "why"]  hand it back; coordinator --stale requires measured inactivity and a note
  pullboard submit <id> [--wait] [--no-next]        needs a clean tree, item check and affected tests green at HEAD (alias: done)
                                        --infra "<why>": required when the change edits an existing test or gate file; the reviewer reads it in show
  pullboard verify <id> accept [--no-next] --note "what you broke or which edge you tried, and what happened"
  pullboard verify <id> reject [--no-next] --reason TEST_FAILURE --clause "failing frozen requirement" --note "what failed" [--cause <key>]
                                        two rejects of the same frozen clause hold the item for a sharper bar
                                        submit, release and verdict take native next work; --no-next leaves the seat empty
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

`;
