/** Preserved coordinator command-group help, composed in its original display order. */
export const coordinatorHelp = `Coordinator
  pullboard sweep --run "<checker>" --check "<checker on {file}>" [--level light] [--max 20] [--dry-run]
                                        file one item per file a linter, type checker or test reporter flags
  pullboard land                        manual override: offer a runner land job for the accepted items
  pullboard land --replay [--since <time>]  decide each recorded batch again from its record; no tests, merges or runners
  pullboard land --stats [--json]  count the last 7 days of landings by same-tree and re-proved, and the retest share per 100 (needs landing.composedEquality)
  pullboard land --waive <test> --until <date> --reason \"why\"  the person records an expiring test waiver
  pullboard publish                     coordinator: run the whole suite on the trunk head; push it only when every test passes
  pullboard merged <id> <commit> [--gate-receipt <id>] [--items 1,2,3] [--forced "<why>" [--waive-proof "<why>"]]  record verified work with its native batch receipt; --forced records hand-landed work as landed without a verify, and needs a passing receipt for the item tip or --waive-proof
  pullboard withdraw <id> <reason>      drop an item nobody should build
                                        with withdraw.review on: waits for another seat's withdraw <id> --confirm or --reject
  pullboard refreeze <id>               adopt a corrected criterion or changed spec rows
  pullboard reopen <id> [--withdraw-verdict] --note "why" [--cause <key>]
                                        withdraw your own accept before landing, or coordinator-return a submission
  pullboard reopen <id> --conflict <file> [--conflict <file>]
                                        return accepted work that conflicts with the trunk for a main merge
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <id> "reason" [--until verified|landed]  hold until the next named event on this item
  pullboard hold <id> "reason" --owner <seat|lane|person> [--deadline <ISO time>]  name who answers for the hold; the deadline defaults to a day out (holds.requireOwner makes --owner required)
  pullboard hold --list --owner <seat|lane|person>  list the open holds that name that owner, oldest deadline first
  pullboard hold <lane|id> --off        lift a lane or item hold
  pullboard clock [--dry-run] [--json] [--watch]  one clock pass: apply each due item's registered default move and log it as a clock_move event
  pullboard main-red-files [set <path> [<path> ...] | --clear]  print, replace or clear the gate's main-red file list (sorted, deduplicated repo paths)
  pullboard expedite <id> --reason "..."  mark an item expedited; at most jobs.expediteMax (default 3) at once, and an item stops counting when its gate settles

`;
