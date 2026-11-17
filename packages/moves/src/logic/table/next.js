/**
 * Every move table's next steps, one sentence per refusal code, in one module the move leaves read without loading the tables.
 * Why: the move registry loads every leaf at start, and a leaf that imported its whole table for these words made every command pay
 * for the tables, their rules and their engine [C7,#7081]. Each table re-exports its own, so the table and the command still word
 * a refusal one way.
 */

/**
 * The next step the claim command prints for each refusal code its table rows share; the live command's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const CLAIM_NEXT = Object.freeze({
  LINE_WIP_LIMIT: 'review the oldest eligible waiting submission: pullboard next --verify; if none is eligible, ask the coordinator to arrange a reviewer',
  A5_GRAMMAR_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
  AGENT_APPROVAL_REQUIRED: 'ask the person to confirm or decline the named row through pullboard view or their own terminal',
  BAD_CONFIG: 'fix pullboard.json as the message says, then commit it: git commit -m "chore: fix pullboard config" pullboard.json',
  BAR_EMPTY: 'ask the coordinator to give the item numbered clauses: pullboard edit <id> --criterion "1. ... [test]" --reason "..."',
  BAR_NOT_READY: 'read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar',
  BLOCKED: 'take another item with pullboard next, or shout the lane it waits on: pullboard shout <lane> "<text>"',
  CRITERION_PROVES_NOTHING: 'set a check that fails before the work: pullboard edit <id> --check "<command>", or ask the person to accept this one: pullboard check accept <id>',
  HELD: 'take another item: pullboard next',
  ITEM_HELD: 'take another item with pullboard next while the coordinator holds this one',
  LANE_HELD: 'take other work with pullboard next; nothing for this seat: end your turn',
  NOT_CLAIMABLE: 'take open work: pullboard next',
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NO_ITEM: 'find the item id: pullboard list --all',
  NO_POLICY: 'restore and commit pullboard.json, then run the command again',
  ONE_CLAIM: 'submit or release the item you hold: pullboard release <id> --reason <code> --note "why"',
  PENDING_REFREEZE: 'the coordinator runs pullboard refreeze <id>',
  REOPEN_HELD_FOR_BUILDER: 'ask the builder to run pullboard release <id> --reason ROUTED_ELSEWHERE, then take other work with pullboard next',
  ROUTE: 'take an item your route covers: pullboard next',
  SESSION_LEDGER: 'make the agent-session ledger named in the message writable by this user, then run the command again',
  UNKNOWN_SPEC: 'ask the coordinator to restore the named spec rows or withdraw the item: pullboard shout coordinator --kind question "please fix the rows cited by #<id>"',
  WRONG_LANE: 'create a worktree in the required lane with pullboard worktree <lane> --model "<model name>", or take an item in your lane with pullboard next',
});

/**
 * The next step the release command prints for each refusal code its table rows share; the live command's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const RELEASE_NEXT = Object.freeze({
  RELEASE_REASON: 'name why with --reason INELIGIBLE|ROUTED_ELSEWHERE|BLOCKED|BUDGET|TAKEN_OVER|DIAGNOSIS_WRONG|OTHER (OTHER also needs --note)',
  NOTE_REQUIRED: 'add --note "<what happened>"',
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NOT_YOURS: 'shout its holder or the coordinator: pullboard shout coordinator --kind question "<what you need>"',
  NO_ITEM: 'find the item id: pullboard list --all',
});

/**
 * The next step the withdraw command prints for each refusal code; the live command's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const WITHDRAW_NEXT = Object.freeze({
  STALE_MAIN_RED: 'rerun the native main audit against the current frozen item',
  CLOSED: 'read its state with pullboard show <id>, then take open work: pullboard next',
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  NOTE_REQUIRED: 'add --note "<what happened>"',
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NO_ITEM: 'find the item id: pullboard list --all',
  SESSION_LEDGER: 'make the agent-session ledger named in the message writable by this user, then run the command again',
});

/**
 * The next step the reopen command prints for each refusal code; the live command's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const REOPEN_NEXT = Object.freeze({
  BOARD_RETURNS_REJECTED: 'run pullboard next to resume returned work',
  BAD_VERDICT_WITHDRAW: 'use --withdraw-verdict with a note, or report a conflict separately',
  VERDICT_WITHDRAW_FORBIDDEN: 'ask the accepting reviewer or coordinator to withdraw this verdict',
  VERDICT_WITHDRAW_STATE: 'refresh the item; withdraw only a current acceptance before landing',
  REVIEW_HELD: 'take another review: pullboard next --verify',
  ALREADY_MERGED: 'file the follow-up as a new item: pullboard add <lane> "<title>"',
  BAD_CAUSE: 'name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out',
  BAD_CONFIG: 'fix pullboard.json as the message says, then commit it: git commit -m "chore: fix pullboard config" pullboard.json',
  BAD_CONFLICT: 'run pullboard reopen <id> --conflict <file> [--conflict <file>] from the main checkout',
  CONFLICT_FILES: 'name only the files Git reports as conflicting with the trunk: pullboard reopen <id> --conflict <file> [--conflict <file>]',
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
  LANDING_FAILURE_REQUIRED: 'reopen with --note "<test file>: <test name>; merge commit <sha>", or with --note \'<test file>: "<test name; with semicolon>"; merge commit <sha>\' when the test name contains a semicolon, or use --conflict <file> for each file that only conflicts with the trunk',
  MERGE_CHECK_FAILED: 'use Git 2.38 or newer (git --version), then retry',
  NOTE_REQUIRED: 'add --note "<what happened>"',
  NOT_ACCEPTED: 'reopen a submission with --note "why"; --conflict is for accepted work',
  NOT_CONFLICTING: 'merge it; reopen only after a red landing, with --note "<test file>: <test name>; merge commit <sha>"',
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NOT_SUBMITTED: 'see its state with pullboard show <id>; verify only submitted items: pullboard next --verify',
  NO_ITEM: 'find the item id: pullboard list --all',
  NO_TRUNK: 'in the main checkout, switch to the repository’s trunk branch and run pullboard inbox',
  SESSION_LEDGER: 'make the agent-session ledger named in the message writable by this user, then run the command again',
});

export const SUBMIT_NEXT = Object.freeze({
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NOT_YOURS: 'shout its holder or the coordinator: pullboard shout coordinator --kind question "<what you need>"',
  NO_ITEM: 'find the item id: pullboard list --all', USAGE: 'run pullboard help', PENDING_REFREEZE: 'the coordinator runs pullboard refreeze <id>',
  CHILDREN_OPEN: 'finish the child items (pullboard list --all), or ask the coordinator to withdraw them',
  HEAD_NOT_NEW: 'commit the rework, then pullboard submit <id>',
  OUTSIDE_NATIVE_BUILD: 'ask the coordinator to return it, then intake the author\'s new exact head',
  CRITERIA_CHANGED: 'ask the coordinator to refreeze it: pullboard shout coordinator --kind question "please refreeze #<id>"',
  BAD_SUBMIT_HANDOFF: 'read the captured candidate and current job with pullboard show <id>, then submit the clean committed source again',
  SUBMIT_HANDOFF_CHANGED: 'read the current claim and queued result with pullboard show <id>; do not complete an old or foreign job',
  SUBMIT_HANDOFF_PENDING: 'leave the queued source unchanged; take other work with pullboard next; nothing for this seat: end your turn',
  SUBMIT_HANDOFF_RESULT: 'retain the normal gate receipts and submission result; a queue record never replaces a proved submit',
});

/** The next steps the submit command prints for the refusal codes its table rows own; the live command's next-step map reads these. */
export const SUBMIT_COMMAND_NEXT = Object.freeze(Object.fromEntries(['NOT_YOURS', 'NO_ITEM', 'USAGE', 'PENDING_REFREEZE', 'CHILDREN_OPEN', 'HEAD_NOT_NEW', 'CRITERIA_CHANGED', 'NOT_JOINED'].map(code => [code, SUBMIT_NEXT[code]])));

/**
 * The next step the verify command prints for each refusal code its table rows share; the live move declaration's next-step map reads these.
 * Why: one sentence per code, so the table and the command can never word the same refusal two ways.
 */
export const VERIFY_NEXT = Object.freeze({
  NOT_JOINED: 'join a lane from this worktree: pullboard join <lane> --model "<model name>" (see: pullboard lanes)',
  NO_ITEM: 'find the item id: pullboard list --all',
  NOT_SUBMITTED: 'see its state with pullboard show <id>; verify only submitted items: pullboard next --verify',
  SELF_SESSION_VERIFY: "start the review in a separate process or session: run pullboard next --verify from a different agent session's own worktree",
  NOT_AT_COMMIT: 'check out the submitted commit shown by pullboard show <id>: git switch --detach <commit>',
  CRITERIA_CHANGED: 'ask the coordinator to refreeze it: pullboard shout coordinator --kind question "please refreeze #<id>"',
  NO_POLICY: 'restore and commit pullboard.json, then run the command again',
  ALREADY_MERGED: 'file the follow-up as a new item: pullboard add <lane> "<title>"',
  BAD_VERDICT_REVIEW: 'restore the submitted commit and reviewed Git objects, then re-review the clean composition with current Pullboard',
  SELF_VERIFY: 'ask a different agent to verify it; from main create its worktree with pullboard worktree <lane> --model "<model name>"',
  ROUTE: 'take an item your route covers: pullboard next',
  COORDINATOR_VERIFIES: 'leave the review to the coordinator; record readiness on the item: pullboard fact <id> note "ready for coordinator review"',
  REVIEW_HELD: 'take another review: pullboard next --verify',
  BAD_REASON: 'accept with --note "how you proved it", or reject with --reason TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD or OTHER',
  PROOF_REQUIRED: 'say how you proved it: --note "what you broke or which edge you tried, and what happened"',
  NOTE_REQUIRED: 'add --note "<what happened>"',
  BAD_CAUSE: 'name the cause as test:<file>::<title>, refusal:<CODE>, row:<id> or doctrine:<id>, or leave --cause out',
  BAR_CLAUSE_REQUIRED: 'add --clause "exact wording from the frozen criterion or spec row"',
  BAR_CLAUSE_UNKNOWN: 'read pullboard show <id>, then quote the failing requirement with --clause',
  VERDICT_ENVIRONMENT: 'run the frozen check with current Pullboard, then have an independent reviewer record a fresh verdict with its actual executor environment',
});

/**
 * The next step the landing commands print for each refusal code the landing tables share; the live commands' next-step maps read these.
 * Why: one sentence per code, so the table and the commands can never word the same refusal two ways.
 */
export const LANDING_NEXT = Object.freeze({
  LAND_BATCH: 'adopt the recorded batch: pullboard land --adopt',
  LAND_ITEM_MOVED: 'rebuild the batch from current verified work: pullboard land',
  LAND_NOT_PUSHED: 'push the batch, then pullboard land --adopt',
  LAND_TEST_DEFECT: 'commit a correction to the test named by the held defect, or ask the person for an expiring test waiver; then run pullboard land again',
  FORCED_REASON: 'name why this merge bypassed the gate: pullboard merged <id> <commit> --forced "<why>"',
  NOT_VERIFIED: 'merge only verified items; see pullboard list --all',
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  LAND_LEASE_LOST: 'stop, read pullboard resume, and adopt only after the holder finishes',
  LAND_ADOPT: 'pullboard land --adopt',
  LAND_TRUNK: 'return the checkout to the trunk, then run pullboard land',
  NOT_PENDING: 'nothing to do: only a verified item with no landing receipt lands',
  ITEM_HELD: 'ask the coordinator to lift the hold: pullboard shout coordinator --kind question "lift the hold on #<id>"',
  STALE_VERDICT: 'merge main, resubmit, and verify again',
  LAND_KNOWN_RED: 'fix the failing tests and resubmit, or ask the person for an expiring test waiver',
  LAND_RUNNER_SOURCE_HELD: 'wait for a new head or a new main',
  LAND_REPEATED_RED: 'fix what the landing batches found red, then resubmit',
  WAITS_ON_ITEM: 'land the dependency first: pullboard show <id>',
  STACKED_UNVERIFIED: 'verify the carried submission first',
  PUBLISH_RED_FILE: 'fix the red publish; the item waits until it is green',
  LAND_FILE_OVERLAP: 'it leads the next batch; nothing to do',
  CRITERIA_CHANGED: 'ask the coordinator to refreeze it: pullboard shout coordinator --kind question "please refreeze #<id>"',
  SCREEN_PENDING: 'nothing to do: the screen runs on the current base, and the item lands once it is green',
  LAND_SUITE_PENDING: "run the full suite for the item's group on the current base, then the item lands once it is green",
  LAND_UNCHECKED: 'nothing to do: the item lands once the screen records its trusted secrets and hook re-check',
});
