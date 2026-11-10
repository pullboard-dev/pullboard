/** Preserved receipts command-group help, composed in its original display order. */
export const receiptsHelp = `Receipts
  pullboard flow replay [--history <json>] [--policy <json>]  reproduce recorded flow or predict another item order and WIP limits
                                        --json includes text-free structural history; policy order is recorded or item ids, settings use modelled board line-control names (unsupported names are refused)
  pullboard stats [--since <date> | --window <duration> [--compare]]  proof numbers from the event log; --json for sites and tools
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
  pullboard ledger --since 2h [--item <id>]
                                        pipeline ledger: time per hop (p50, p90, sum, share), runner and coordinator
                                        compute, agent minutes and tokens per role and model, per landing; --json
  pullboard capacity [--window 14d]      carrying capacity with held-out error, plus test-work and conversion priority; --json
  pullboard test-value                   fourteen-day per-file runs, code-fixed catches, flakes, runtime, edits and value; --json
                                        report-only costs in pullboard.json testEconomics: costOfEscape 3600, costOfWaiting 1, costOfFalseRed 300
                                        runtime gaps remain unknown; no test admission policy changes
  pullboard gate-health [--since 2h]    queued gates in the window: count, total p50/p90, time per phase,
                                        top failure causes with hosts, and the 10 slowest with their dominant phase; --json
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

`;
