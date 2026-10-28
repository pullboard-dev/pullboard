/** Preserved coordinator command-group help, composed in its original display order. */
export const coordinatorHelp = `Coordinator
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

`;
