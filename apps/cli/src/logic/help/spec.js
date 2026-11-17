/** Preserved spec command-group help, composed in its original display order. */
export const specHelp = `Spec
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
  pullboard spec apply [--row <id> [--commit]]  coordinator applies recorded row decisions to the files (--row: one row only;
                                        --commit: commits it when spec.commitOnApply is on)
  pullboard doctrine check              each doctrine rule's check: its count, its committed count, whether it holds
                                        a rule row adds | gate: check <command> | count: N, and | files: <paths> to narrow it
                                        the command prints one line per problem and exits 0 or 1; anything else cannot count
                                        submit refuses a touched rule whose count rises; runs: nightly skips submit, mode: watch only counts

`;
