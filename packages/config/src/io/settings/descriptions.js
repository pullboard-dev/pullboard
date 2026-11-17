/** A plain label, one sentence, group and display unit for every setting in the settings inventory [O5,O6,N26]. */
import { Refused } from '../../../../kernel/light.js';
import { PERSON_SET } from '../../logic/settings.js';

// [key, label, one sentence on what it does, group, unit, compatibility?]. Wording is checked against each setting's reader in src/.
// A compatibility toggle keeps an old behaviour and ends `{ compat: true, removeBy: 'YYYY-MM-DD' }`, one row per line [O6,C7].
const ROWS = [
  ['exitRules.calls', 'Tool calls per claim', 'Distinct native tool-call IDs since the claim; streamed duplicates count once and unknown usage never triggers a stop.', 'Order', 'count'],
  ['exitRules.enabled', 'Session exit rules', 'Off by default; stop a claim at its known native budget or repeated failure and require a same-family handoff.', 'Order', 'on/off'],
  ['exitRules.tokens', 'Tokens per claim', 'Input plus output tokens, including cached reads as recorded; unknown usage never triggers a stop.', 'Order', 'count'],
  // This machine: Capacity
  ['browserSlots', 'Browser checks at once', 'How many runs that need a real browser go at the same time on this computer; 0 needs a registered runner.', 'Capacity', 'count'],
  ['gate.boardOpensCheck', 'Refuse new file-board opens', 'Off (default) refuses nothing. On, a changed test that adds a file-board open without naming why is refused by the static checks on every gate, even when no test is selected.', 'Capacity', 'on/off'],
  ['gate.browserByLaunch', 'Browser work by real launches', 'Counts a test file as browser work only if it actually launches Chrome, not when it merely looks like a browser test.', 'Capacity', 'on/off'],
  ['gate.browserFreeChecks', 'Browser-free checks skip the browser slot', 'A check that never opens a browser takes an ordinary slot instead of waiting for a browser slot.', 'Capacity', 'on/off'],
  ['gate.contractAudit', 'Audit contract gaps and mismatches', 'Off (default) audits nothing. On, an export whose shape differs from its declared contract is refused CONTRACT_SHAPE_MISMATCH, and an export with no declared contract gets a draft contract file for its owner to review.', 'Capacity', 'on/off'],
  ['gate.contractWeakening', 'Refuse a weakened contract without the owner', 'Off (default) refuses nothing. On, a change that narrows an export\'s shape (an export removed, a parameter dropped or the return changed) is refused CONTRACT_WEAKENED unless the owning cell\'s approval is recorded.', 'Capacity', 'on/off'],
  ['gate.diskFloorMB', 'Runner disk floor', 'A runner refuses new jobs when less than this much disk is free after its sweep; an absolute amount, never a percentage.', 'Capacity', 'MB'],
  ['gate.junitReport', 'JUnit report', 'The path of a JUnit XML report the gate can read test case outcomes from; blank (default) reads none.', 'Capacity', 'path'],
  ['gate.loadAwareDispatch', 'Prefer quieter runners', 'On by default once a runner is measured: dispatch skips a runner above 1.5x its cores and picks the most headroom by runner-reported load.', 'Capacity', 'on/off'],
  ['gate.localLoadShare', 'Local runner load share', 'With no registered runners, the local runner takes a job only while this machine\'s one-minute load is under this share of its cores (default 1.0 per core); the job waits in the queue otherwise.', 'Capacity', 'number'],
  ['gate.localRunner', 'Local runner', 'On (default): with no registered runners, the first pull submit starts one runner serve on this machine against the board API on loopback, so gates and landings need no setup; off leaves pulled jobs for other runners.', 'Capacity', 'on/off'],
  ['gate.mainComparison', 'Compare red runs with main', 'on-red (default) compares a red submit or review run with main to tell known main reds from new ones; off treats a red gate as red, with no main comparison and no carried-red acceptance.', 'Capacity', 'on-red/off'],
  ['gate.memoryFloorMB', 'Memory floor', 'The queue holds new checks while free memory is below this; blank means it never waits for memory.', 'Capacity', 'MB'],
  ['gate.namedImportSelection', 'Select tests by the names they import', 'Off (default) selects every test that imports a re-exporting door when any module behind it changes. On, a test that imports only plain names from the door is selected only if one of them comes from the changed module; a star, namespace, default, dynamic or unreadable import still takes the whole door.', 'Capacity', 'on/off'],
  ['gate.refuseMissingCheckFile', 'Refuse a submit whose check names a missing test file', 'When enabled, submit refuses at once, before queuing a gate, if a test file the item\'s frozen check names is absent from the submitted commit, and names the missing file and the files the commit added; off (default) queues the gate as before.', 'Capacity', 'on/off'],
  ['gate.refuseTempWorktree', 'Refuse worktrees under the temporary folder', 'When enabled, pullboard worktree refuses a seat folder under the operating system temporary directory, which can be cleared, and names the persistent default; off (default) makes the worktree where it always did.', 'Capacity', 'on/off'],
  ['gate.requireRunnerAttribution', 'Require runner work to name its item and purpose', 'When enabled, a runner request whose metadata lacks an item or a kind is refused with the missing field named; off (default) sends it as before, so a caller that names neither still runs.', 'Capacity', 'on/off'],
  ['gate.runnerBusyCeiling', 'Runner busy ceiling', 'Dispatch avoids runners above this CPU busy percentage when another compatible runner is below it.', 'Capacity', 'percent'],
  ['gate.runnerDispatch', 'How runner jobs are watched', 'pull (the only value) offers each job as a row a runner takes, the loopback local runner when none is registered, and finishes in short processes, so waiting costs none; the old controller value is refused.', 'Capacity', 'pull', { compat: true, removeBy: '2026-12-31' }],
  ['gate.shortSlots', 'Quick-check lane', 'Extra slots kept for runs that name their test files, so they do not wait behind long runs; 0 turns it off.', 'Capacity', 'count'],
  ['gate.staticMemo', 'Keep green local static runs', 'Off (default) runs every local pullboard gate --static in full. On, a green run is kept for its exact clean tree and main, so a rerun on that unchanged tree (a resubmit after a refusal) answers green at once; any uncommitted or untracked change, a new commit or a new main runs it again.', 'Capacity', 'on/off'],
  ['gate.staticSlots', 'Local static checks at once', 'How many local pullboard gate --static runs this machine lets work at once (default 2); a further run waits, names the wait and its place, and starts when a slot frees.', 'Capacity', 'number'],
  ['gate.submitAuthorization', 'Where submit authorization runs', 'runner (default) checks a queued submit\'s lane ownership inside its one runner analysis job beside doctrine and test selection, while local keeps that check on this machine, as it always is with no runner.', 'Capacity', 'runner/local'],
  ['gate.timingRunner', 'Runner for timed checks', 'With two or more runners, timed checks run only on this one and ordinary runs use the rest, and borrow it only when the rest are full and no timed check waits; auto picks the runner with the most measured headroom and off drains a busy runner instead.', 'Capacity', 'host'],
  ['gateSlots', 'Checks at once', 'How many test runs this computer does at the same time.', 'Capacity', 'count'],
  ['machine.loadCeiling', 'Load ceiling', 'Above this 1-minute load, heavy local commands wait in the local resource line and say why; blank means 1.5 times the logical cores.', 'Capacity', 'load'],
  // This machine: Order
  ['add.warnUnnamedTest', 'Add warns on an unnamed test', 'When enabled, pullboard add warns (never refuses) about a [test] clause that names no test file when the brief has no Test: line, because no gate run can tick it; off (default), add stays silent.', 'Order', 'on/off'],
  ['api.codeStampCache', 'Cache the state worker\'s code stamp', 'When enabled, a restart of the state worker over an unchanged code tree reuses the code stamp it saved, checking each recorded folder and file by size and modification time instead of listing the source folders again; any change walks the tree afresh. Off (default), every start walks the source folders.', 'Order', 'on/off'],
  ['board.archiveEvents', 'Archive old events', 'When enabled, the archiver moves the events of items verified more than 30 days ago into the event archive, keeping the live event table small; off (default), no event moves.', 'Order', 'on/off'],
  ['board.hotState', 'Keep hot board state', 'When enabled, the state build keeps the open and recent items as a hot state and counts the finished ones instead of reading every item; off (default), the state build reads every item as before.', 'Order', 'on/off'],
  ['budget.dailyUsd', 'Daily spend ceiling', 'Off by default; the most model dollars this computer may spend in one day, refused when not a positive amount.', 'Spending', 'USD'],
  ['budget.totalUsd', 'Total spend ceiling', 'Off by default; the most model dollars this computer may spend in all, refused when not a positive amount.', 'Spending', 'USD'],
  ['gate.jobReserve', 'Runner job classes', 'Off by default; when set, a runner takes interactive runs, then gates, then landings, then background sweeps, while each class keeps this share of every runner\'s slots.', 'Order', 'share'],
  ['gate.queue.agingMinutes', 'Waiting bonus', 'A waiting check moves up one class every this many minutes, so nothing waits forever; used only while an order setting above is on.', 'Order', 'minutes'],
  ['gate.queue.currentReleaseFirst', 'Current release first', 'Among otherwise tied checks on each board, work in the release being shipped goes ahead of later releases.', 'Order', 'on/off'],
  ['gate.queue.reviewsFirst', 'Reviews first', 'Queued checks run in the order landing, review, submit, then the rest, instead of landings first and then arrival order.', 'Order', 'on/off'],
  ['health.derivedState', 'Derived item state', 'When enabled, an item state is derived from its board records instead of being stored; off (default), item state is exactly as before, and nothing reads this setting yet.', 'Order', 'on/off'],
  ['health.diskFloorGb', 'Health warns on low disk', 'When above 0, pullboard health warns when the disk holding this board has less free space than this many gigabytes; 0 (default) never warns.', 'Order', 'gigabytes'],
  ['health.lapsedSweep', 'The sentinel expires lapsed claims', 'When enabled, the View\'s sentinel expires claims whose lease lapsed every minute, so none waits for a command to run; off (default), lapsed claims are expired by the ten-minute sweep and before each write.', 'Order', 'on/off'],
  ['holds.liftSettled', 'Lift settled holds', 'When enabled, a hold whose reason names only items that have landed or been withdrawn, and a parent hold whose children are all done, lifts when main moves; off (default), holds stay until someone lifts them.', 'Order', 'on/off'],
  ['holds.requireOwner', 'Holds need an owner', 'When enabled, an item hold names an owner (a seat, lane or person) and records a deadline one day out unless one is given; off (default), holds are exactly as before.', 'Order', 'on/off'],
  ['list.thinRead', 'List reads through the thin door', 'When enabled, pullboard list reads its rows through the thin read door that skips the board library; off (default), list reads exactly as before.', 'Order', 'on/off'],
  ['maintenance.retireIdleHours', 'Idle hours before a seat is retired', 'How many hours a seat worktree sits untouched before maintenance.retireIdleSeats may remove it; 3 by default.', 'Order', 'hours'],
  ['maintenance.retireIdleSeats', 'Maintenance retires idle seats', 'When enabled, maintenance removes a seat worktree that is clean, untouched for the hours set below and whose HEAD is already on main; off (default), maintenance leaves such worktrees alone.', 'Order', 'on/off'],
  ['next.adoptPreserved', 'Next restores a returned item\'s pinned work', 'When enabled, next --take of a returned item merges the newest pinned head of its earlier work into the new item folder and records a note fact; off (default), next --take claims as before.', 'Order', 'on/off'],
  ['next.capBuilders', 'Next sends builders past the cap to review', 'The most builder seats that may hold a claim at once; a builder asking next while that many other seats already hold claims is offered a review when one is waiting. 0 (default) turns it off and next offers builds as before.', 'Order', 'count'],
  ['next.holdAboveLoad', 'Next hands no new work above the load ceiling', 'When enabled, pullboard next hands no new build or review claim to a seat while this machine\'s 1-minute load is above machine.loadCeiling, and names the load; a held claim still resumes. Off (default), next hands claims as before.', 'Capacity', 'on/off'],
  ['next.idleBlockers', 'Next names what an idle answer waits on', 'When enabled, an idle answer from next also lists up to three waiting items and what each waits on; off (default), an idle answer carries no blockers.', 'Order', 'on/off'],
  ['next.itemNotices', 'Next lists the item\'s shouts', 'When enabled, the instruction next returns also lists the shouts and rulings that name the item it hands out; off (default), next prints what it did before.', 'Order', 'on/off'],
  ['next.readinessCache', 'Next remembers readiness results per main commit', 'When enabled, next keeps each readiness result for the main commit it ran on, so a second next on the same main commit does not rerun the command and an item that was not ready is offered again once main moves; off (default), next reruns the command on every call.', 'Order', 'on/off'],
  ['next.readinessCheck', 'Next skips items that are not ready', 'When enabled, next runs an item\'s readiness command before offering it and passes over the item, naming the command and its output, when it exits non-zero; off (default), next offers items as before.', 'Order', 'on/off'],
  ['release.rerouteUntouched', 'Untouched releases count toward a route-up', 'When enabled, a claim handed back untouched from next with --reason INELIGIBLE or ROUTED_ELSEWHERE counts toward the rule that moves an item one route up after two releases; off (default), an untouched release never counts, as before.', 'Order', 'on/off'],
  ['review.canonicalFamilies', 'Seats register a canonical family', 'When enabled, a seat joining with --family OpenAI or openai registers as openai, and Claude or anthropic as anthropic, so the family guard sees two families; labels already stored are not rewritten; off (default), the label is stored as typed.', 'Order', 'on/off'],
  ['review.releaseReasons', 'A dropped review names why', 'When enabled, releasing a review needs --reason BAR, FAMILY, INFRA or TOO_LARGE, recorded on the release; off (default), a review release is exactly as before.', 'Order', 'on/off'],
  ['sentinels.recordWriteHolder', 'Record who held a slow board write', 'When enabled, the wait audit keeps a small durable record of the holder\'s command line, pid and held time, and each waiter\'s pid and wait, whenever a board write is held past its budget; off (default), nothing is recorded.', 'Order', 'on/off'],
  ['spec.cascadeReject', 'Rejecting a spec row marks the rows that serve it', 'When enabled, recording a rejected verification of a spec row also records a needs-review event for every row that serves it, directly or through other rows, naming the rejected row; off (default), a rejection writes exactly the events it wrote before.', 'Order', 'on/off'],
  ['stats.recordCoordinatorUsage', 'Record the coordinator\'s session usage', 'When enabled, a coordinator move records the new tokens and model of its own session log under coordinator:<session id> in the cost totals; off (default), nothing is recorded and no log is read.', 'Order', 'on/off'],
  ['status.showUsefulBuilders', 'Status shows max useful builders', 'When enabled, pullboard status prints the max useful builder count from the last 7 days with its window and the seat counts it rests on, or unknown when too few were seen; off (default), status prints exactly what it printed before.', 'Order', 'on/off'],
  ['submit.clauseMarks', 'Submit carries clause marks', 'When enabled, a submit records each numbered clause of the item\'s bar with whether a tick covers it and the evidence the tick cites, so the reviewer reads the marks beside the diff; off (default), a submit records what it always has.', 'Order', 'on/off'],
  ['submit.proofOnly', 'Proof-only items submit without a change', 'When enabled, an item whose clauses are all command, measurement or reasoning clauses, each ticked, submits with no change against main instead of being refused as empty; off (default), such a submit is refused as before.', 'Order', 'on/off'],
  ['test.statusOutcomes', 'Per-case outcomes in test --status', 'When enabled, pullboard test --status <run> --json for a finished run also carries an outcomes list of {file, name, passed, skipped} rows read from the run\'s outcome frames, which survive when the log is cut to its last 40 KB; off (default), the document is unchanged.', 'Runners', 'on/off'],
  ['workers.budget', 'Worker budget', 'The spend per day or week that pullboard run --scale may use across every live seat on this computer, priced by each seat\'s model; off launches no workers.', 'Capacity', 'spend'],
  // This machine: Runners
  ['census.balanceByTime', 'Census jobs balanced by time', 'When enabled, a pulled census cuts its jobs by each file\'s last measured time and offers the heaviest first, so runners finish together; off, it cuts them by file count.', 'Runners', 'on/off'],
  ['census.jobMinutes', 'Census job size', 'When set, a pulled census cuts its jobs so none holds more than this many minutes of measured file time (or one file, if that file alone is longer), so fast runners keep pulling short jobs; unset, jobs hold up to 40 files.', 'Runners', 'minutes'],
  ['census.jobsPerRunner', 'Census jobs per runner', 'When set, a pulled census offers each runner at most this many census jobs at once, so its files run at quiet speed; other jobs and runner slot counts are unchanged. Unset, census jobs fill any free runner slot.', 'Runners', 'count'],
  ['census.jobsPerRunnerQuiet', 'Census jobs per quiet runner', 'When set along with census.jobsPerRunner, a runner holding no job but census ones is offered up to this many census jobs at once instead, so slots do not sit idle; a runner with any other job keeps census.jobsPerRunner. Unset, every runner keeps that one cap.', 'Runners', 'count'],
  ['census.recordFileTimes', 'Census records file times', 'When enabled, a pulled census writes each file\'s measured time back where the next census plan reads it, so the next plan balances by time; it drops files no longer tracked and plans each file by the lower of its last two times. Off, it writes none. The same record steers landing shard plans.', 'Runners', 'on/off'],
  ['census.rerunNonGreen', 'Census reruns non-green files', 'When enabled, a census runs each file that was not green once more, alone, before calling it red: green alone reads green with a flaky mark, and the row keeps both outcomes. Off, each row is the first run\'s.', 'Runners', 'on/off'],
  ['census.rerunOnSettle', 'Census reruns as jobs settle', 'When enabled, a census reruns a non-green file as soon as the job that ran it settles, under the usual 3-minute file kill, instead of after the whole pass. Off, reruns wait for every first-run job.', 'Runners', 'on/off'],
  ['census.selfTune', 'Census sizes its jobs from the last census', 'When enabled, a pulled census with no census.jobMinutes cuts its jobs to the 80th percentile of the previous census\'s shard times (3 to 20 minutes, needs at least 4 shards on record); a typed census.jobMinutes always wins. Off (default), jobs are cut by file count as before.', 'Runners', 'on/off'],
  ['census.soloFileSeconds', 'Census slow files run alone', 'When set, a pulled census plans each file whose last recorded time is over this many seconds as a job to itself, so a slow file never sits inside a job with others; the rest are cut as before. Unset, slow files share jobs.', 'Runners', 'seconds'],
  ['gate.adapterLintClock', 'Refuse new direct clock reads', 'When enabled, the static check refuses a source file outside the kernel that reads Date.now or a timer directly beyond its recorded count, and names the file, the line and the clock adapter to use; off, it reports nothing.', 'Runners', 'on/off'],
  ['gate.adapterLintFs', 'Refuse new direct file-system imports', 'When enabled, the static check refuses a source file outside the kernel that imports node:fs directly beyond its recorded count, and names the file, the line and the file-system adapter to use; off, it reports nothing.', 'Runners', 'on/off'],
  ['gate.endStaleJobs', 'End stale gate jobs', 'When enabled, offering a new gate candidate for an item ends its older open gate jobs, and a landed item\'s open gate jobs end, so runners spend no time on candidates that can no longer land.', 'Runners', 'on/off'],
  ['gate.excuseMainTimingReds', 'Excuse timing reds that main shares', 'When enabled, a gate run whose only reds are timing reds that main also has is excused instead of refused; off (default), every red counts. Only an exact true turns it on.', 'Runners', 'on/off'],
  ['gate.fencedHop', 'Fenced gate hop row', 'When enabled, a gate hop is one row with one owner, written by compare-and-set; a writer that loses the race is refused with the owner named.', 'Runners', 'on/off'],
  ['gate.handoffWorkers', 'Hand-off workers', 'Caps the submit hand-off workers this computer runs at once, computed from the runner slots when unset and lowered only by this setting, never by a launching command.', 'Capacity', 'count'],
  ['gate.idiomSpread', 'Refuse a spreading idiom', 'When enabled, the static check refuses a change that spreads a banned idiom to a file that did not use it before, and names the file, the line and the idiom; off, it reports nothing.', 'Runners', 'on/off'],
  ['gate.mainCaseFilter', 'Compare only the failed cases on main', 'When enabled, a detailed comparison with main runs main\'s copy of a failing file with only the cases the candidate failed, and a case main fails by the same name counts as main\'s red; a filtered run that ran no case is unavailable. Off (default), the whole file runs.', 'Runners', 'on/off'],
  ['gate.measuredSlots', 'Measured runner slots', 'Each runner offers slots computed from its own cores and memory, unless it was registered with a fixed count.', 'Runners', 'on/off'],
  ['gate.overlapStaticProof', 'Static proof overlaps the cells step', 'When enabled, the submit proof starts while the cells step runs and a red cells result still fails the gate; off (default), the proof starts after the cells step.', 'Runners', 'on/off'],
  ['gate.postLandSuite', 'Full suite after landing', 'When enabled, each landed train batch is followed by the full suite on registered runners; newly red files get Main red owners.', 'Runners', 'on/off'],
  ['gate.pulledProfilePaths', 'Keep phase timing profiles from pulled gates', 'When enabled, a pull runner keeps each phase timing profile beside the phase log and the settled gate lists the profile paths; off (default), pulled gates carry no profile paths.', 'Runners', 'on/off'],
  ['gate.recaptureHandoff', 'Hand queued gate recapture to a worker', 'When enabled, a queued gate recapture is handed off to a worker instead of running in the submitting command; off (default), submit recaptures as before, and nothing reads this setting yet.', 'Runners', 'on/off'],
  ['gate.redFactLocation', 'Name the line in a gate red', 'When enabled, a pulled gate red from a static lint or guard check also lists the first file:line places the check reported, then a count; off (default), the red fact is unchanged.', 'Runners', 'on/off'],
  ['gate.reofferInfraEnd', 'Offer a gate job again after an infrastructure end', 'When enabled, a gate job that ends with no progress (GATE_JOB_NO_PROGRESS, an infrastructure end and never a red) is offered once more for the same commit, so the item is not left for its claim to be released. At most one re-offer per commit.', 'Runners', 'on/off'],
  ['gate.runnerWaitMs', 'Wait for a runner', 'How long a runner-only check waits for a free runner before it refuses.', 'Runners', 'ms'],
  ['gate.runnersFirst', 'Runners before local slots', 'Registered runners are tried before this computer\'s own slots.', 'Runners', 'on/off'],
  ['gate.runnersOnly', 'Runners only', 'Submit and review checks wait for a registered runner and never fall back to this computer.', 'Runners', 'on/off'],
  ['gate.sampleDiskIo', 'Runner load samples carry disk busy', 'On, this computer\'s runner load samples also carry disk busy % and I/O wait %, to tell a disk-bound runner from a CPU-bound one; off (the default), a sample is load, cores and free memory only and no child process is launched to take it.', 'Runners', 'on/off'],
  ['gate.settleOnMainReceipt', 'Settle gates on main receipts', 'When enabled, an item gate whose proof ran as shards and was left unknown only because main\'s receipt for a file was missing settles green or red from its recorded run once that receipt records, so its builder does not submit again.', 'Runners', 'on/off'],
  ['gate.tableReplay', 'Replay changed move tables', 'When enabled, a submit that changes a move table replays it over the board\'s recorded moves and is red on any disagreement.', 'Runners', 'on/off'],
  ['gate.testNice', 'Test processes yield the CPU', 'On, test processes the runner starts on this computer run at a lower scheduling priority, so board writers keep the CPU while they hold the write lock; off, they keep the CLI\'s priority.', 'Runners', 'on/off'],
  ['gate.tripOverheadBudgetMs', 'Runner trip overhead budget', 'The most time one runner trip may spend outside running tests (admission, setup, transfer, collecting the result) before gate receipts and the static stage report it; report only, never a refusal. The default is the warm trip measured on 15 Nov (about 7 s) plus margin.', 'Runners', 'ms'],
  ['inspection.clauses', 'Legacy inspection preference', 'This legacy machine value does not control submit; accepted main sets verify.inspectClauses for the board.', 'Order', 'on/off', { compat: true, removeBy: '2026-12-31' }],
  ['items.typedFields', 'Typed item fields', 'When enabled, an item can hold typed key/value fields whose declared type is text, choice or number, and a value of the wrong type is refused with FIELD_TYPE; off (default), the board gains no field tables and every item reads as before.', 'Order', 'on/off'],
  ['jobs.avoidRunners', 'Jobs avoid named runners', 'When enabled, a job offered with a list of runners to avoid is never given to one of them, so a shard that lapsed on a dead runner reruns elsewhere; off (default), the list is ignored and any runner may take the job.', 'Runners', 'on/off'],
  ['jobs.handBackUnrunnable', 'Hand back land jobs a runner cannot run', 'When enabled, a pull runner given a land job whose shardProof run is missing or unreadable hands it back at once with a LAND_UNRUNNABLE reason that names what is missing, instead of letting the lease lapse; off, the runner starts the job as before. Stored flat as "jobs.handBackUnrunnable" in settings.json.', 'Runners', 'on/off'],
  ['moves.live.claim', 'Claims follow the claim table', 'When enabled, the claim writer writes the events the claim move table decides and refuses what the table refuses; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no claim disagreements.', 'Runners', 'on/off'],
  ['moves.live.handoff', 'Hand-offs follow the hand-off tables', 'When enabled, a gate hand-off start follows the START move table and a completion writes the record and events the COMPLETE table decides, refusing what the tables refuse; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no start or complete disagreements.', 'Runners', 'on/off'],
  ['moves.live.job', 'Gate jobs follow the job table', 'When enabled, a runner\'s renew, release or receipt writes the job row the job move table decides and is refused what the table refuses; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no job disagreements.', 'Runners', 'on/off'],
  ['moves.live.outbox', 'Outbox moves follow the outbox table', 'When enabled, the relay outbox writer refuses a queue or park the outbox move table refuses and keeps the state the table decides; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no outbox disagreements.', 'Runners', 'on/off'],
  ['moves.live.outcome', 'Submit outcomes follow the outcome table', 'When enabled, the submit outcome writer records what the outcome move table decides and refuses what it refuses; off, the writer\' own rules decide. Turn it on only when pullboard moves shows no outcome disagreements.', 'Runners', 'on/off'],
  ['moves.live.reclaim', 'Stale-state maintenance follows the reclaim table', 'When enabled, stale-state maintenance refuses what the reclaim move table refuses and writes the release and notice events the table decides; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no reclaim disagreements.', 'Runners', 'on/off'],
  ['moves.live.reopen', 'Reopens follow the reopen table', 'When enabled, the reopen writer writes the decided parts of the event the reopen move table decides and refuses what the table refuses; off, the writer\'s own rules decide. Turn it on only when pullboard moves shows no reopen disagreements.', 'Runners', 'on/off'],
  ['moves.live.submit', 'Submits follow the submit tables', 'When enabled, a submit writes the event the COMMIT move table decides and a gate queue follows the SUBMIT table, refusing what it refuses; off, the writers\' own rules decide. Turn it on only when pullboard moves shows no commit or submit disagreements.', 'Runners', 'on/off'],
  ['moves.shadow', 'Record move table shadow compares', 'When enabled, each writer that carries a move table shadow records on the board whether the table agreed with what the writer wrote, so pullboard can show when a table is ready to run live.', 'Runners', 'on/off'],
  ['push.recordTiming', 'Record push gate timing', 'When enabled, each finished pre-push gate, green, red or unknown, writes one push.timing row on the board with its wall clock and each shard\'s wall time and runner (the newest 20 are kept), so shard sizing can use measured times. Off (default), nothing is recorded.', 'Landing', 'on/off'],
  ['push.rerunFailedShardOnce', 'Rerun a failed push shard once', 'When enabled, the pre-push gate re-offers a shard whose runner lapsed or posted an infrastructure failure once, with that runner on its avoid list (needs jobs.avoidRunners to keep it off that runner); a second failure ends the shard as failed. Off (default), nothing is re-offered.', 'Landing', 'on/off'],
  ['runner.packCache', 'Reuse packed installs', 'When enabled, a runner keeps the npm pack tarball for each tree id in a per-runner folder under its home, pruned by size, and packs the same tree only once; off packs on every call. Stored flat as "runner.packCache" in settings.json.', 'Runners', 'on/off'],
  ['runnerRates', 'Runner rate cards', 'For each runner host, its purchase price, months to pay off, load watts and power price per kWh; nothing computes with it yet.', 'Runners', 'list'],
  ['runners', 'Registered runners', 'The other computers that run checks for this one, each with its slots.', 'Runners', 'list'],
  ['runners.drainOnFetchFailure', 'Stop claiming after trunk fetch failures', 'When enabled, a pull runner claims no job after 3 trunk fetch failures in a row, and checks the trunk every 30 s until a fetch works. Stored flat as "runners.drainOnFetchFailure" in settings.json.', 'Runners', 'on/off'],
  ['runners.fetchFailFast', 'Release at once when the trunk will not fetch', 'When enabled, a pull runner whose trunk fetch fails or runs past 120 s from the claim hands the job back with the fetch error, and the jobs waiting behind that fetch go back at once; off, each job tries its own fetch. Stored flat as "runners.fetchFailFast" in settings.json.', 'Runners', 'on/off'],
  ['runners.postedLineNamesCase', 'Name the failing case in the runner log', 'When enabled, a pull runner\'s "posted <job>: exit 1" log line for a red test job ends with the first failing case\'s file and name and a count of the others, read from the job\'s output; off (default), the line names no case. Stored flat as "runners.postedLineNamesCase" in settings.json.', 'Runners', 'on/off'],
  ['runners.requiredToolchains', 'Send jobs only to runners with these toolchains', 'A comma list of toolchain names, such as node,python; a job goes only to a runner whose recorded toolchains (pullboard runner add --toolchain) include every name, and waits when none does. Blank (default) sends jobs to any compatible runner.', 'Runners', 'text'],
  ['runners.yieldWhilePruning', 'Keep leases alive while pruning', 'When enabled, a pull runner measures old job folders in short slices and gives the event loop back between them, so its lease renewals keep running; off, the walk blocks the whole serve until it ends. Stored flat as "runners.yieldWhilePruning" in settings.json.', 'Runners', 'on/off'],
  ['scratch', 'Scratch folder root', 'One absolute, existing folder for all throwaway folders (PULLBOARD_SCRATCH names it too); unset keeps the system temp folder.', 'Folders', 'folder'],
  ['serve.address', 'Board API address', 'The interface address pullboard serve listens on; off loopback every request needs this machine\'s board key, so runners on the network can pull jobs.', 'Runners', 'address'],
  ['serve.port', 'Board API port', 'The port pullboard serve listens on; 0 chooses a free one, so set it when runners keep the board URL.', 'Runners', 'port'],
  ['serve.pullRoute', 'Board API answers runner pulls', 'When enabled, pullboard serve also answers /pull/register, /pull/take, /pull/heartbeat and /pull/result for pull runners, over this board\'s job table; off (default), serve answers /pull/ as it did before, with no such route.', 'Runners', 'on/off'],
  ['tests.registryStrict', 'Fail on unregistered tests', 'When enabled, the test registry check fails when a test has no stable ID or registry record; off, it reports the test and passes.', 'Runners', 'on/off'],
  ['tests.requireDeclaredInputs', 'Report tests with undeclared inputs', 'When enabled, the test-input rule also reports a test file that reads a repo file outside src (fixtures, data, docs) without an input header; off (default), it keeps today\'s exact behaviour.', 'Runners', 'on/off'],
  ['tests.requireJourneyPath', 'Refuse journeys with no user path', 'When enabled, the static check refuses a change that adds a CLI journey no golden user path names (JOURNEY_NO_PATH); off, it prints the finding as a diagnostic line and passes.', 'Runners', 'on/off'],
  ['tests.requireRegistered', 'Refuse unregistered new tests', 'When enabled, the static check refuses a change that adds a test file in a cell with no test registry (TEST_UNREGISTERED); off, it prints the finding as a diagnostic line and passes.', 'Runners', 'on/off'],
  // This machine: Background
  ['health.sentinel', 'Health watch', 'The automatic health observer runs on this computer; a board can turn it off for itself too.', 'Background', 'on/off'],
  ['landing.pools', 'Boards this computer lands', 'The boards this computer has agreed to land work for, set with pullboard settings landing.pool.', 'Landing', 'list'],
  ['view.background', 'Keep the view running', 'Init and resume keep pullboard view running, so pullboard.dev can open this computer\'s boards.', 'Background', 'on/off'],
  ['view.port', 'View port', 'The port this computer\'s local view listens on.', 'Background', 'port'],
  // Relay (machine and board)
  ['relay.agent', 'Sharing agent', 'The agent identity this board uses when it shares.', 'Relay', 'text'],
  ['relay.agentTokens', 'Agent sign-ins', 'Whether this board holds sign-ins for its agents; the values are never shown.', 'Relay', 'set/not set'],
  ['relay.autoLink', 'Link new boards automatically', 'Boards on this computer are linked to your sharing account without asking each time.', 'Relay', 'on/off'],
  ['relay.board', 'Linked remote board', 'The identifier of the remote board this board shares with.', 'Relay', 'text'],
  ['relay.deleted', 'Sharing removed', 'This board\'s sharing link was deliberately removed.', 'Relay', 'on/off'],
  ['relay.excludeByBoard', 'Relay opt-out covers every worktree', 'When enabled, relay off for one worktree excludes every worktree of the same board, and an older opt-out made from any of its worktrees counts as the board\'s; off (default), an opt-out covers only the checkout it was made in.', 'Relay', 'on/off'],
  ['relay.excluded', 'Boards kept out of sharing', 'Repositories that automatic linking skips.', 'Relay', 'list'],
  ['relay.key', 'Board encryption key', 'Whether this board has the key that encrypts what it shares; the key is never shown.', 'Relay', 'set/not set'],
  ['relay.keyStorage', 'Key storage', 'Where this board keeps its encryption key, such as the system keychain.', 'Relay', 'text'],
  ['relay.offerAtInit', 'Offer phone sharing at setup', 'Init asks once whether to share your boards with your phone.', 'Relay', 'on/off'],
  ['relay.outbox', 'Send updates through the outbox', 'Board updates go out through a durable outbox; false turns that off.', 'Relay', 'on/off'],
  ['relay.owner.account', 'Sharing account', 'The account that owns this computer\'s device sharing.', 'Relay', 'text'],
  ['relay.owner.url', 'Sharing service', 'The address of the sharing service this computer signs in to.', 'Relay', 'text'],
  ['relay.personReauth', 'Needs the person to sign in again', 'This board\'s sharing sign-in was cleared, so the person must sign in again before sharing resumes.', 'Relay', 'on/off'],
  ['relay.pruneReceipts', 'Drop old relay request receipts', 'When enabled, a phone request receipt recorded more than 7 days ago is dropped when the next one is saved, and a receipt with no recorded time stays; off (default), every receipt is kept as before.', 'Relay', 'on/off'],
  ['relay.push', 'Phone wake-up notifications', 'When enabled, the sharing service keeps one push subscription per paired phone and sends it a sealed wake-up for an alert, until the pairing is revoked; off (default), nothing is stored or sent.', 'Relay', 'on/off'],
  ['relay.session.token', 'Device sign-in', 'Whether this computer holds a sharing sign-in; the value is never shown.', 'Relay', 'set/not set'],
  ['relay.token', 'Board sign-in', 'Whether this board holds a sharing sign-in; the value is never shown.', 'Relay', 'set/not set'],
  ['relay.url', 'Board sharing service', 'The address of the sharing service this board is linked to.', 'Relay', 'text'],
  // This repo: Project
  ['agents.names', 'Agent name style', 'Whether an agent\'s number comes after its name or before it.', 'Project', 'choice'],
  ['fix', 'Automatic fixers', 'Commands that fix the files they are given, and which files they apply to.', 'Project', 'list'],
  ['inbox.batchedMarks', 'Batch inbox marks', 'Off (default) writes each inbox delivery mark as the inbox is read. On queues the marks and writes them in one batch.', 'Project', 'on/off'],
  ['inbox.tokenBudget', 'Inbox size', 'The most an inbox response may hold, in bytes of text.', 'Project', 'bytes'],
  ['lanes', 'Lanes', 'Each lane\'s owned files, owned spec rows and starting rules.', 'Project', 'list'],
  ['map.slice', 'Code map with assigned work', 'Next and claim print the slice of the code map an item touches.', 'Project', 'on/off'],
  ['name', 'Repository name', 'The name shown for this repository.', 'Project', 'text'],
  ['next.wholeItemsFirst', 'Whole items before slices', 'Off (default) keeps the offer order. On, next offers a whole item of the focused release before an open slice.', 'Claims', 'on/off'],
  ['practice', 'Doctrine file', 'The file holding the project\'s doctrine.', 'Project', 'file'],
  ['products', 'Products', 'Product names and the spec rows each one covers.', 'Project', 'list'],
  ['project', 'Project name', 'The name shown for this project.', 'Project', 'text'],
  ['shared', 'Shared paths', 'Path prefixes any lane may change.', 'Folders', 'list'],
  ['slices.enforcePaths', 'Keep slices in their paths', 'Submit refuses a slice that changes a path outside the files it declared.', 'Checks', 'on/off'],
  ['spec', 'Spec file', 'The file holding the approved specification.', 'Project', 'file'],
  ['toolBuild.autoGate', 'Automatic tool build gate', 'Run a full runner gate on main at the tool build refresh interval.', 'Project', 'on/off'],
  ['toolBuild.enabled', 'Pinned tool builds', 'Run board commands from a gated tool build instead of the live trunk when enabled.', 'Project', 'on/off'],
  ['toolBuild.refreshMs', 'Tool build refresh interval', 'How often commands check for a newer gated tool build, in milliseconds.', 'Project', 'milliseconds'],
  ['trunk.remote', 'Trunk remote', 'The git URL runners fetch candidates from and landing pushes the trunk to, with gate.runnerDispatch pull as a runner job that pushes only if trunk has not moved; empty uses the board host\'s own repository.', 'Project', 'text'],
  ['worktreeMaintenance.enabled', 'Automatic worktree maintenance', 'Opt in to archiving recoverable work before maintenance cleans eligible retired checkouts; off by default.', 'Project', 'on/off'],
  ['worktreeMaintenance.every', 'Maintenance interval', 'How often enabled maintenance checks for retired worktrees; one hour by default.', 'Project', 'duration'],
  ['worktreeMaintenance.exclude', 'Worktrees kept out of maintenance', 'Explicit absolute directory paths maintenance always leaves alone.', 'Project', 'list'],
  ['worktreeMaintenance.grace', 'Retirement grace', 'How long a retired worktree waits before archive-first cleanup; one day by default.', 'Project', 'duration'],
  ['worktrees', 'Worktree placement', 'Agent worktrees are made inside this repository or beside it.', 'Project', 'choice'],
  // This repo: Checks
  ['affectedSuites', 'Suites by folder', 'Which test suite covers each folder, so a landing runs only the suites its changes touch.', 'Checks', 'list'],
  ['affectedTests', 'Selected-test command', 'The command prefix that runs only the test files a change affects.', 'Checks', 'command'],
  ['cells.cache', 'Remember cells check answers', 'The cells checks answer from a saved result when the commit, tree and uncommitted changes are the same as last time.', 'Checks', 'on/off'],
  ['cells.shimMaxAgeDays', 'Shim removal age', 'Health names compatibility shims left beyond this many days after their cell move landed.', 'Checks', 'days'],
  ['check.install', 'Check setup', 'The command that prepares a clean tree before an item\'s frozen check runs.', 'Checks', 'command'],
  ['check.timeout', 'Check time limit', 'The longest a frozen check may run.', 'Checks', 'duration'],
  ['checks.provesNothing', 'Checks that already pass', 'What happens when an item\'s check already passes on main: hold refuses the claim and submit, warn only says so.', 'Checks', 'choice'],
  ['claim.barTestFiles', 'Check file patterns', 'Which test files may carry an item\'s frozen check.', 'Checks', 'list'],
  ['flakes.quarantine', 'Quarantine flaky tests', 'A test that keeps flaking is set aside so it stops blocking work.', 'Checks', 'on/off'],
  ['flakes.rerun', 'Rerun flaky tests', 'A test known to be flaky is run again before a failure counts.', 'Checks', 'on/off'],
  ['gate', 'Test command', 'The command that runs the project\'s whole test suite.', 'Checks', 'command'],
  ['itemBuildBudgetMinutes', 'Item build budget', 'Expected build minutes allowed before an item must be cut into children.', 'Work', 'minutes'],
  ['itemSizeBudget', 'Item size budget', 'Changed lines an item may carry before submit notes it as oversize.', 'Checks', 'lines'],
  ['positiveControl', 'Known-good test', 'A test that must pass, so a gate that can no longer pass anything raises an alarm.', 'Checks', 'command'],
  ['registryGuards', 'Registry guards', 'Source guards the selected-test runner adds when a change touches a registry.', 'Checks', 'list'],
  ['rigor.autoDraft', 'Draft unproved Rigor rules', 'Rigor drafts a rule for a repeated failure before any fix is proven; false keeps only drafts you prove with rigor draft --red/--green.', 'Checks', 'on/off'],
  ['rigor.budget', 'Code a change may add', 'The most lines of non-test code one change may add.', 'Checks', 'lines'],
  ['staticChecks', 'Static checks', 'A source check that runs before the tests.', 'Checks', 'command'],
  ['submit.autoFileMainReds', 'File known main failures', 'Submit opens repair items for failures freshly confirmed to match main.', 'Checks', 'on/off'],
  ['submit.edgeFollowUps', 'List new import edges', 'On, a submit whose diff adds import edges files one follow-up item listing them; off, it does not look.', 'Checks', 'on/off'],
  ['submit.handoff', 'Return while checks run', 'Deprecated no-op: submit always settles through the pull gate.', 'Checks', 'on/off'],
  ['submit.regenerateDeclared', 'Regenerate declared files', 'On, submit runs the generator of a declared generated file whose input the diff changed and commits the result; off, the composed tree is left as committed.', 'Checks', 'on/off'],
  ['submit.requireInfraNote', 'Explain test edits', 'Submit asks for a written reason when a change edits tests or infrastructure.', 'Checks', 'on/off'],
  ['submitInvariants', 'Always-run tests', 'Test files that run on every submit, however small the change.', 'Checks', 'list'],
  ['testConcurrency.browser', 'Browser test files at once', 'How many browser test files run at the same time; never more than the file limit.', 'Checks', 'count'],
  ['testConcurrency.files', 'Test files at once', 'How many test files run at the same time.', 'Checks', 'count'],
  ['testEconomics.costOfEscape', 'Cost of a bug escaping', 'How costly a defect that slips through is, in seconds of equivalent waiting; it steers where checks are placed.', 'Checks', 'seconds'],
  ['testEconomics.costOfFalseRed', 'Cost of a false red', 'How costly a failure that was not real is, in seconds of equivalent waiting; it steers where checks are placed.', 'Checks', 'seconds'],
  ['testEconomics.costOfWaiting', 'Cost of waiting', 'How costly each second of waiting is, in seconds of equivalent waiting; it steers where checks are placed.', 'Checks', 'seconds'],
  // This repo: Review
  ['approvers', 'People who approve', 'The GitHub accounts allowed to act as the person on a linked board; blank means no limit.', 'Review', 'list'],
  ['families', 'Model family names', 'Which vendor names count as the same model family.', 'Review', 'list'],
  ['labels', 'Label bounds', 'How many items may carry each label at once, as a minimum and a maximum per label name.', 'Order', 'list'],
  ['pace', 'Pace', 'How work lands: steady (default) lands an item after a green gate and an accept, while sprint and strict are opt-in paces that nothing reads yet.', 'Review', 'choice'],
  ['release.liftTwiceHold', 'Lift a released-twice hold', 'On, the hold the release-twice rule places lifts when main moves or when an item a release named as its blocker lands; a hold a person or the coordinator placed stays. Off (default), it stays until someone lifts it.', 'Review', 'on/off'],
  ['resume.adoptOrphans', 'Adopt orphaned claims', 'On, pullboard resume in a fresh worktree adopts the claim an orphaned seat left, restoring its pinned head and crediting it; off, resume only reports.', 'Agents', 'on/off'],
  ['review.excludeEarlierHolders', 'Exclude earlier holders from review', 'On refuses a review reservation by any seat that ever claimed, built, submitted or released the item; off excludes only its current builder and submitters.', 'Review', 'on/off'],
  ['review.independence', 'Reviewer independence', 'Off lets any seat but the builder verify, even a subagent of the builder\'s session, while session lets only a different agent session verify.', 'Review', 'choice'],
  ['review.relaxRequiredFamily', 'Review family can widen', 'When enabled, an item filed with --review-family may widen its required reviewer family when no reviewer of it is available; off (default), a --review-family item never widens.', 'Review', 'on/off'],
  ['review.starveMinutes', 'Review waiting alarm', 'A submission that has waited this long without a reviewer is marked urgent.', 'Review', 'minutes'],
  ['review.starveShout', 'A starved review shouts the coordinator', 'When enabled, a green submission with no eligible reviewer past the review waiting alarm sends the coordinator one blocker shout naming the guards that refuse every seat; off (default), no shout is sent.', 'Order', 'on/off'],
  ['verify.composeAtAdmission', 'Compose with main at review', 'A review is judged on the item combined with the current main when it starts.', 'Review', 'on/off'],
  ['verify.failBefore', 'Require a fail-before receipt', 'Submit refuses a [test] clause unless a recorded run at the item base failed on an assertion.', 'Review', 'on/off'],
  ['verify.family', 'Reviewer model family', 'Whether a reviewer must (require) or should (prefer) come from a different model family than the builder; off ignores it.', 'Review', 'choice'],
  ['verify.familyRelaxAt', 'Review backlog threshold', 'Allow independent same-family reviews when this many submissions lack an available other-family reviewer; off disables it.', 'Review', 'count'],
  ['verify.folderTicks', 'Tick folder-named test clauses', 'On, a [test] clause that names a folder is ticked by the item\'s changed tests under it when the gate runs them green; off (default) only a clause naming a test file is.', 'Review', 'on/off'],
  ['verify.frozenTests', 'Freeze named test files', 'Submit refuses an item whose bar-named test file changed after claim, unless the person ruled on the new content.', 'Review', 'on/off'],
  ['verify.hunkFreshness', 'Judge freshness by changed hunks', 'When enabled, a verdict whose item merges onto main without conflict stays fresh while every hunk of the item\'s own patch is unchanged, wherever it moved in the file; off, freshness compares each reviewed path\'s whole patch as before.', 'Review', 'on/off'],
  ['verify.inspectClauses', 'Inspect bar clauses', 'Each bar clause must name its evidence kind, and submit checks every clause against it.', 'Review', 'on/off'],
  ['verify.landedReviews', 'Review forced landings', 'On, next --verify offers an item a forced merge landed with no verdict as a review of its merged commit, after the ordinary submitted reviews; off, only submitted work is offered.', 'Review', 'on/off'],
  ['verify.policy', 'Who may review', 'Any other agent may review, or only the coordinator.', 'Review', 'choice'],
  ['verify.queueAccept', 'Queue the accept check', 'On, verify accept queues the frozen check as a runner job, reserves the review to the accepting seat and returns at once; off (default) runs the check before the accept returns.', 'Review', 'on/off'],
  ['verify.rejectKeepsCheck', 'Landed rejects keep the check', 'On, a reviewer\'s reject of a landed item reopens it as a follow-up carrying the landed item\'s exact check, which a reviewer cannot set or edit; off (default), such a reject is refused when the item has a check only the coordinator may set.', 'Review', 'on/off'],
  ['verify.requireRowRewrite', 'Require bar rewrites for changed rows', 'On, a restructure move refuses while an open item cites a spec row whose text changed with no rewrite edit recorded for its bar, and names the coordinator; off (default) moves without checking.', 'Review', 'on/off'],
  ['verify.reviewRatio', 'Reviews to builds', 'How many builds each reviewer is scheduled against.', 'Review', 'ratio'],
  ['verify.testAuthorSplit', 'Separate test author', 'Submit refuses an item whose own seat wrote a bar-named test file; another seat must be the recorded author.', 'Review', 'on/off'],
  ['verify.titleTicks', 'Tick clauses by case title', 'On, a [test] clause that names no test file is ticked by the item\'s changed tests holding a case titled "clause N:" when the gate runs every such case green; off (default) only a clause naming a test file or folder is.', 'Review', 'on/off'],
  ['verify.unrelatedTrunkMoves', 'Keep verdicts through unrelated changes', 'A verdict survives main moving through commits that touch nothing the review read.', 'Review', 'on/off'],
  ['withdraw.refuseLanded', 'Landed work stays landed', 'On, withdraw refuses an item whose commit is on main and names pullboard merged instead; off, withdraw closes it as before.', 'Review', 'on/off'],
  ['withdraw.review', 'Withdrawals need a second seat', 'On, a withdrawal waits as pending until another seat confirms it; off, withdraw closes the item at once.', 'Review', 'on/off'],
  // This repo: Claims
  ['claim.keepWhileRunning', 'Keep a claim while its run is in flight', 'When enabled, a claim whose holder has a test run, test or gate job in flight on the item is not released as idle, stalled or without progress; once the job ends the usual rules apply. Off (default), only a quiet seat is spared while its run is live.', 'Claims', 'on/off'],
  ['claim.refuseOffMainHead', 'Refuse a claim off main', 'When enabled, claim refuses in a folder whose HEAD is not on main (a commit made before claiming), and names the step that puts the folder back on main; off (default), claim takes the folder as it stands.', 'Claims', 'on/off'],
  ['claim.reopenFirstRefusalMinutes', 'Builder repair window', 'After a reopen, the original builder gets this long to repair it first; 0 turns it off.', 'Claims', 'minutes'],
  ['claim.returnToBoard', 'Return reds to the board', 'A red or refused queued gate releases the builder claim at once, so any free seat of the lane and route takes it.', 'Claims', 'on/off'],
  ['claims.fileLease', 'Lease the files a claim will change', 'On, a claim whose predicted files (from the brief and the bar) a live claim of another seat already leases is refused FILE_LEASED, naming the holder and the file; off, claims are unchanged.', 'Claims', 'on/off'],
  ['claims.fileLeaseHubs', 'Files many items share', 'Files no claim leases, such as an index or a registry every item touches.', 'Claims', 'list'],
  ['claims.itemsInGate', 'Build beside the gate', 'On, a seat keeps claiming and editing while its items wait in the gate.', 'Claims', 'on/off'],
  ['claims.itemsInGateMax', 'Items in the gate', 'Most gate-waiting items per seat.', 'Claims', 'count'],
  ['claims.perSeat', 'Live claims per seat', 'How many build claims one seat may hold at once; blank lets the board set N = clamp(1, 5, floor(free test-run slots / live seats)), counting local cores when no runner serves.', 'Claims', 'count'],
  ['claims.releaseCooldownMinutes', 'Release cooldown', 'After a seat releases an item, next offers it other work for this many minutes unless nothing else is open.', 'Claims', 'minutes'],
  ['claims.releaseGone', 'Release claims of gone agents', 'Claims held by agents that have disappeared are released automatically.', 'Claims', 'on/off'],
  ['docs.regenerateOnCommit', 'Regenerate generated docs on commit', 'When enabled, the pre-commit hook regenerates docs/formats.md, docs/api.md and the help additions when a commit changes the source declarations they are built from, and stages the result; off (default), the hook leaves generated docs alone.', 'Claims', 'on/off'],
  ['engine.nameBehindDevice', 'Name the device that is behind', 'When enabled, a move refused for an old engine names the teammate device running an older Pullboard, its seat, the release it runs, the release the move needs and the pullboard update to run, when the caller knows the device; off (default), the refusal reads as it always has.', 'Relay', 'on/off'],
  ['freeze.refuseEmptyBar', 'Refuse an empty bar', 'When enabled, freezing an item whose criterion is empty is refused BAR_EMPTY, since a reviewer has no clause to check; off (default), an empty bar freezes as before.', 'Claims', 'on/off'],
  ['inbox.escalateAfterMinutes', 'Minutes before an unacted entry escalates', 'With entries kept until acted on, one waiting this long goes to the coordinator and, after as long again, to the person; empty, entries never escalate.', 'Project', 'minutes'],
  ['inbox.keepUntilActed', 'Inbox entries wait for an action', 'On, every shout stays listed in the inbox until an action its kind allows (answer, act, archive or escalate) is recorded; off, a shout is read once.', 'Project', 'on/off'],
  ['laneMode', 'Lanes on or off', 'on (default) keeps every board as it is, with its lanes; off is read by later slices of the lanes switch and today changes nothing.', 'Claims', 'on/off'],
  ['lease', 'Build claim length', 'How long a build claim lasts before it expires.', 'Claims', 'duration'],
  ['modelTiers', 'Model routes', 'Which route a seat serves, light, mid or strong, from a fragment of its model name; an unmatched model serves mid.', 'Claims', 'list'],
  ['pin.signed', 'Require a signed tooling pin', 'On, no run uses a tooling pin file that is unsigned or edited after it was signed; off, the pin file is read as written.', 'Checks', 'on/off'],
  ['queue.contention', 'Steer next away from hot files', 'On, next starts the least contended ready item of equal priority and makes an item wait when its files are in flight elsewhere; off, next orders ready items as before.', 'Claims', 'on/off'],
  ['queue.contentionThreshold', 'Contention score that waits', 'With queue.contention on, an item whose score (file conflict rate times changes in flight on it) passes this waits.', 'Claims', 'count'],
  ['reviewLease', 'Review claim length', 'How long a review reservation lasts before it expires.', 'Claims', 'duration'],
  ['seat.checkpoints', 'Record seat checkpoints', 'On, a seat records a checkpoint fact at claim, submit, an exit-rule stop and handoff: what is done, what is left, decisions taken, evidence and tokens used; off (default) records none.', 'Agents', 'on/off'],
  // This repo: Landing
  ['generated', 'Generated files', 'Each generated file with the command that makes it and the files it reads; a declaration missing its generator is refused; off unless declared.', 'Checks', 'list'],
  ['landing.adaptiveBatch', 'Adaptive landing batch size', 'When enabled, an automatic land offer starts at one item and takes one more after every three clean batches in a row, never more than line.landingBatchSize, and drops back to one after any stopped batch; off (default), an offer takes line.landingBatchSize or everything.', 'Landing', 'on/off'],
  ['landing.asyncFetch', 'Fetch in the background when landing', 'When enabled, the lander starts its remote fetch without waiting for it; off (default), landing waits for the fetch to finish.', 'Landing', 'on/off'],
  ['landing.auditOnly', 'Audit-only tests', 'Test files the per-item landing gate leaves to the post-landing audit, which files a red there as a main red; off unless listed.', 'Landing', 'list'],
  ['landing.byHand', 'Coordinator lands one accepted item by hand', 'When enabled, the coordinator may name one accepted item to pullboard land --item; off (default), land --item is refused and the board lands accepted items by itself.', 'Landing', 'on/off'],
  ['landing.environment', 'Required landing machine', 'The platform, architecture and Node version the landing gate must run on.', 'Landing', 'list'],
  ['landing.first', 'Land these first', 'Item ids the lander takes ahead of the accept order, in the order listed; a listed item that is not verified is skipped.', 'Landing', 'list'],
  ['landing.landedFromMain', 'Landed means on main', 'On, roadmap, show, the view and withdraw count an item landed when its commit is on main, whether or not a merge was recorded; off, they read the recorded merge.', 'Landing', 'on/off'],
  ['landing.ledgerMainReds', 'Main reds from the ledger', 'On, a land job counts a red in a file the test ledger records red on main at its base as main\'s own and lands; a red in any other file still holds it. Off, every red is rerun on the base and matched case for case.', 'Landing', 'on/off'],
  ['landing.manualOverride', 'Manual landing override', 'A person can permit coordinator landing commands instead of automatic landing after acceptance.', 'Landing', 'on/off'],
  ['landing.pauseOnRed', 'Pause landing on red', 'Landing pauses after a publish full suite fails without proof it is unrelated.', 'Landing', 'on/off'],
  ['landing.perItem', 'Per-item landing', 'A landing takes every verified item that merges cleanly; a red batch bisects to its culprit and lands the rest, and a red batch of one goes back to open alone.', 'Landing', 'on/off'],
  ['landing.pipeline', 'Pipelined landing', 'On, a second landing batch may start while one is in flight; off (default) lands one batch at a time. Nothing reads it yet.', 'Landing', 'on/off'],
  ['landing.priorityOrder', 'Land in priority order', 'On, the lander takes accepted items in the order next uses: person-urgent or pinned first, then milestone position, then accept order. Held and stale items are skipped without changing the order of the rest. Off, oldest accept first.', 'Landing', 'on/off'],
  ['landing.parallelGates', 'Gate landing batches in parallel', 'When enabled, landing may gate a second batch while the first is still in flight; off (default), landing gates one batch at a time as before.', 'Landing', 'on/off'],
  ['landing.publish', 'Publish separately', 'Landing happens locally and the push goes out through pullboard publish.', 'Landing', 'choice'],
  ['landing.reofferTrunkBusy', 'Offer a trunk-busy landing again', 'When enabled, a land job that found trunk moved under every push attempt is offered again after a backoff that grows per retry, and its items stay accepted; off (default), a trunk-busy land job ends and nothing offers its items again until the next landing.', 'Landing', 'on/off'],
  ['landing.reuseContractResults', 'Reuse contract results in a land', 'When enabled, a land request carries the ledger\'s newest green results with its contract files, so a contract file whose inputs are unchanged on the merged tree is reused and only the others run; off (default), every contract file runs.', 'Landing', 'on/off'],
  ['landing.reuseGateReceipts', 'Reuse gate results in a land proof', 'When enabled, a land request lists the item\'s own green gate results first in its proof hit list, so a file whose inputs are unchanged on the merged tree is reused; off (default), the hit list holds the newest results of any origin, as before.', 'Landing', 'on/off'],
  ['landing.shardProof', 'Spread the landing proof', 'A landing job offers its proof\'s test files as shard jobs to other runners and pushes trunk when every shard is green; off, the one runner that holds the job runs the whole proof.', 'Landing', 'on/off'],
  ['landing.squash', 'Squash landings', 'When enabled, the lander lands an item as one commit on main with a single parent, keeping the item\'s own commits reachable for audit; off (default), an item lands as a merge commit.', 'Landing', 'on/off'],
  ['landing.stallStop', 'Stop a stalled landing', 'When enabled, a landing job whose check shows no progress for two minutes is stopped and its batch offered again with the stall named; off (default), a quiet check runs to its time limit.', 'Landing', 'on/off'],
  ['landing.strictFullSuite', 'Strict full-suite landing', 'With strict pace, an item lands only with its group\'s full suite green, and lands and publishes in one step; off (default), an item lands on its own gate and screen.', 'Landing', 'on/off'],
  ['landing.trunkRemote', 'Trunk remote (old name)', 'Deprecated: the old name for trunk.remote, read for one release when trunk.remote is empty and removed after it; set trunk.remote instead.', 'Landing', 'text', { compat: true, removeBy: '2026-12-31' }],
  ['landingShards', 'Landing test shards', 'How many shards the landing gate splits its test files into.', 'Landing', 'count'],
  ['pushGate.shardMinutes', 'Push shard time limit', 'How long a pre-push gate shard may run before the push gate gives up, and a quarter of it sizes each shard; a longer runner ceiling raises it.', 'Landing', 'minutes'],
  ['pushGate.sizeFromBoard', 'Size push shards from the board', 'On, the pre-push gate sizes its shard count from the board\'s own data (runners and recorded times) instead of a fixed number; off, it keeps the fixed count.', 'Landing', 'on/off'],
  ['submitDeferAbove', 'Defer large selections', 'A submit whose selection names more test files than this runs only its check and invariants, and landing runs the rest.', 'Landing', 'count'],
  ['submitGate', 'Full suite at', 'Where the full test suite runs: blank at submit, or landing to defer it.', 'Landing', 'choice'],
  ['tiers', 'Routine, standard and escalation tiers', 'For each tier, its self-hosted endpoint and model, any you run; a tier missing either is refused; off unless set.', 'Agents', 'list'],
  // This repo: Commits
  ['commits.banned', 'Banned words', 'Text a commit header may not contain.', 'Commits', 'list'],
  ['commits.maxHeader', 'Header length', 'The longest a commit header may be.', 'Commits', 'characters'],
  ['commits.noCoAuthor', 'No co-author lines', 'Commits with co-author trailers are refused.', 'Commits', 'on/off'],
  ['commits.noEmoji', 'No emoji', 'Commit messages with emoji are refused.', 'Commits', 'on/off'],
  ['commits.noHostName', 'No computer name', 'Submit refuses commits that name this computer; off only warns.', 'Commits', 'on/off'],
  ['commits.requireIds', 'Types that cite specs', 'Commit types whose header must cite a spec id.', 'Commits', 'list'],
  ['commits.types', 'Commit types', 'The types a commit header may start with.', 'Commits', 'list'],
  ['protect.allowed', 'Protected-file exceptions', 'File patterns allowed even though they match a protected one.', 'Protection', 'list'],
  ['protect.blocked', 'Protected files', 'File patterns no change may include.', 'Protection', 'list'],
  ['protect.secrets', 'Secret scan', 'Changes are scanned for text that looks like a secret.', 'Protection', 'on/off'],
  ['spec.commitOnApply', 'Commit applied spec decisions', 'When enabled, applying a decided spec row from the view writes SPEC.md and commits it under the person\'s identity, with only the spec file and signoff receipts, if the checkout is clean; off (default), apply writes the files and commits nothing.', 'Project', 'on/off'],
  // This board: line settings (recorded by the coordinator with a reason)
  ['line.agingMinutes', 'Item waiting bonus', 'A ready item gains one queue position per this many minutes waited; off preserves the existing order.', 'Line', 'minutes'],
  ['line.bar.check', 'Criterion needs a check', 'A criterion must name an executable check.', 'Line', 'on/off'],
  ['line.bar.dryRunReview', 'Dry-run review checklist', 'submit --dry-run-review prints the verifier checklist (each bar clause, the bar-check edge cases, a test that fails without the fix) and records that it ran; advisory, never a verdict. ab alternates items between on and off by id and records each item\'s arm.', 'Line', 'off/on/ab'],
  ['line.bar.sharpenToPerson', 'Send vague criteria to the person', 'A rejected criterion that is unclear goes to the person to sharpen.', 'Line', 'on/off'],
  ['line.barReady', 'Criterion must be ready', 'A new criterion needs its baseline, notes and a second signature before it can be claimed.', 'Line', 'on/off'],
  ['line.collisionFreeBatch', 'Collision-free landing batches', 'Items that change the same files are kept out of the same landing batch.', 'Line', 'on/off'],
  ['line.focusMilestone', 'Focus milestone', 'The milestone whose work is offered first.', 'Line', 'text'],
  ['line.landingBatchSize', 'Landing batch size', 'The most items one landing batch holds, in real landing and when replaying board flow; unset, automatic landing sizes batches from recorded redness.', 'Line', 'count'],
  ['line.landingCadenceMinutes', 'Landing interval', 'The time between landing batches when replaying board flow.', 'Line', 'minutes'],
  ['line.order', 'Board-controlled order', 'The board sets queue order itself.', 'Line', 'on/off'],
  ['line.requireReviewFamilies', 'Require reviewer families', 'A review needs a reviewer with a declared model family.', 'Line', 'on/off'],
  ['line.returnRejectedWork', 'Return rejected work', 'Rejected work goes to its builder first; after 30 minutes another lane seat may claim it.', 'Line', 'on/off'],
  ['line.reviewsFirst', 'Reviews first', 'Reviews are offered before new builds.', 'Line', 'on/off'],
  ['line.reworkSameFamily', 'Same-family rework', 'After the original builder is gone, returned work first goes to live seats in the builder’s model family.', 'Line', 'on/off'],
  ['line.route.liveOnly', 'Live seats only', 'Work is offered only to seats that are live.', 'Line', 'on/off'],
  ['line.takeoverMinutes', 'Takeover wait', 'How long an inactive claim waits before another builder may take it over.', 'Line', 'minutes'],
  ['line.wipPerReviewer', 'Work per reviewer', 'How many items may be in progress for each active reviewer.', 'Line', 'ratio'],
];

// The settings the CLI can set, by the form `pullboard settings <form> <value>` takes; apps/cli/journeys/settings/descriptions.test.js holds this equal to help.js SETTING_FORMS.
const CLI_FORMS = new Set(['gateSlots', 'browserSlots', 'gate.shortSlots', 'gate.runnersFirst', 'gate.measuredSlots', 'gate.loadAwareDispatch', 'gate.runnerBusyCeiling', 'gate.runnersOnly', 'gate.runnerWaitMs', 'inspection.clauses', 'runnerRates', ...Object.keys(PERSON_SET)]);

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Build the frozen description map from inventory rows, refusing a compatibility toggle with no removeBy date.
 * Why: a leftover toggle quietly keeps an old path alive; every one must carry the day it goes [O6,C7].
 *
 * @param {Array<[string, string, string, string, string, { compat?: boolean, removeBy?: string }?]>} rows
 * @returns {Readonly<Record<string, object>>}
 */
export function settingDescriptions(rows) {
  return Object.freeze(Object.fromEntries(rows.map(([key, label, description, group, unit, toggle]) => {
    if (toggle?.compat && !(DATE.test(toggle.removeBy ?? '') && !Number.isNaN(Date.parse(toggle.removeBy)))) {
      throw new Refused('COMPAT_NEEDS_REMOVE_BY', `setting ${key} is a compatibility toggle with no removeBy date`, `add removeBy: 'YYYY-MM-DD' to the ${key} row in ${INVENTORY_FILE}`);
    }
    return [key, Object.freeze({ label, description, group, unit, cli: CLI_FORMS.has(key) ? key : null, ...(toggle?.compat ? { compat: true, removeBy: toggle.removeBy } : {}) })];
  })));
}

export const INVENTORY_FILE = 'packages/config/src/io/settings/descriptions.js';
export const SETTING_DESCRIPTIONS = settingDescriptions(ROWS);

/** The compatibility rows in one inventory source, read as text so main's copy can be judged too, with their lines. */
function compatibilityRows(source) {
  return (source ?? '').split('\n').flatMap((line, index) => {
    // Any line marked compat: true is a row, whichever order its properties come in; one with no key fails closed (key null).
    if (!/^\s*(\.\.\.)?\[/u.test(line) || !/\bcompat:\s*true\b/u.test(line)) return []; // only inventory-row lines, never this function's own code
    return [{ key: /^\s*\['([^']+)',/u.exec(line)?.[1] ?? null, removeBy: /\bremoveBy:\s*'([^']*)'/u.exec(line)?.[1] ?? null, line: index + 1 }];
  });
}

/**
 * Static check over the settings inventory: a compatibility toggle past its removeBy date, or with none, fails with the
 * step that removes it, and the toggle count is a ratchet that may only fall against accepted main's [O6,C7].
 *
 * @param {string} source - The candidate inventory source.
 * @param {string} accepted - Main's inventory source, or '' when main has none.
 * @param {number} [now] - Milliseconds since the epoch; today's UTC date decides "past".
 * @returns {string[]} One `path:line: message` per failure.
 */
export function compatibilityToggleProblems(source, accepted, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = compatibilityRows(source);
  const problems = rows.flatMap(({ key, removeBy, line }) => !key
    ? [`${INVENTORY_FILE}:${line}: a row marked compat: true cannot be read; next: write it as ['key', ...] on one line ending { compat: true, removeBy: 'YYYY-MM-DD' }`]
    : !removeBy || !DATE.test(removeBy)
    ? [`${INVENTORY_FILE}:${line}: compatibility toggle ${key} has no removeBy date; next: add removeBy: 'YYYY-MM-DD' to its row`]
    : removeBy < today ? [`${INVENTORY_FILE}:${line}: compatibility toggle ${key} passed its removeBy date ${removeBy}; next: remove ${key}, its reader and its inventory row`] : []);
  const before = compatibilityRows(accepted).length;
  // Main tracks toggles once its inventory names removeBy; from then on the count may only fall.
  if (/removeBy/u.test(accepted ?? '') && rows.length > before) problems.push(`${INVENTORY_FILE}:1: compatibility toggles grew from ${before} to ${rows.length}; the count only falls; next: remove a toggle before adding one`);
  return problems;
}
export const CLI_SETTABLE = Object.freeze([...CLI_FORMS]);

/** The label, sentence, group and unit for a setting key, or null for a key nobody has described. */
export function describeSetting(key) {
  if (Object.hasOwn(SETTING_DESCRIPTIONS, key)) return SETTING_DESCRIPTIONS[key];
  const named = /^resources\.(.+)\.capacity$/u.exec(key);
  if (named) return { label: `${named[1]} capacity`, description: `How many runs may use the ${named[1]} resource at the same time.`, group: 'Capacity', unit: 'count', cli: null };
  return null;
}
