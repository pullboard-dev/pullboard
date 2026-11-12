/** Preserved coordinator command-group help, composed in its original display order. */
export const coordinatorHelp = `Coordinator
  pullboard sweep --run "<checker>" --check "<checker on {file}>" [--route light] [--max 20] [--dry-run]
                                        file one item per file a linter, type checker or test reporter flags
  pullboard land [--max N] [--dry-run] [--adopt]  manual override: gate and land a durable batch of accepted items
  pullboard land --due [--dry-run]       manual override: use configured age/count; no --max or --adopt; explain when not due
  pullboard land --replay [--since <time>]  decide each recorded batch again from its record; no tests, merges or runners
  pullboard land --waive <test> --until <date> --reason \"why\"  the person records an expiring test waiver
  pullboard publish                     coordinator: run the whole suite on the trunk head; push it only when every test passes
  pullboard merged <id> <commit> [--gate-receipt <id>] [--items 1,2,3] [--forced "<why>" [--waive-proof "<why>"]]  record verified work with its native batch receipt; --forced records hand-landed work as landed without a verify, and needs a passing receipt for the item tip or --waive-proof
  pullboard withdraw <id> <reason>      drop an item nobody should build
  pullboard refreeze <id>               adopt a corrected criterion or changed spec rows
  pullboard reopen <id> [--withdraw-verdict] --note "why" [--cause <key>]
                                        withdraw your own accept before landing, or coordinator-return a submission
  pullboard reopen <id> --conflict <file> [--conflict <file>]
                                        return accepted work that conflicts with the trunk for a main merge
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <id> "reason" [--until verified|landed]  hold until the next named event on this item
  pullboard hold <lane|id> --off        lift a lane or item hold

`;
