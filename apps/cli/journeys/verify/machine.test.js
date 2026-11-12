/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/store/src/io/board.js */
import { assertPostVerdictLandingAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { NOT_MOVES } from '../../tests/fixtures/machine/moves.js';
/**
 * The item lifecycle's declaration (M1, M2, M4): sound on its own terms, each property shown
 * failing on a broken copy, and in step with the refusals the board, CLI and spec parser raise today.
 */
import {
  functionsIn,
  MACHINE_CALLBACKS as CALLBACKS,
} from '../../../../packages/gate/tests/fixtures/functions.js';
import { sourceFacts } from '../../../../packages/gate/tests/fixtures/functions.js';
import { moveOf } from '../../../../packages/gate/tests/fixtures/functions.js';
import { declaredBoardOrder } from '../../../../packages/gate/tests/fixtures/functions.js';
import { movedSourceFiles } from '../../tests/fixtures/source.js';
import { sourceReader } from '../../../../packages/gate/tests/fixtures/functions.js';
import { sourceDirectories } from '../../../../packages/gate/tests/fixtures/functions.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { assertSyncFacadeAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { assertGitFacadeAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { workingSourceInventory } from '../../../../packages/gate/src/io/scan.js';
import { fileURLToPath } from 'node:url';
import {
  assertCommitShimRefusals,
  machineSourceModule,
} from '../../tests/fixtures/machine/commits.js';
import { assertMachineWalkMemo } from '../../tests/fixtures/machine/memo.js';
import * as fs from 'node:fs';
import * as machineRules from '../../../../packages/state/index.js';
import {
  policyRepository,
  submitFixture,
} from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
  posix,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import { openBoard } from '../../../lib/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { HELP } from '../../index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { assertRehomeTriggerDeclaration } from '../../tests/fixtures/machine/rehome.js';
import {
  runnerControllerCallees,
  assertRunnerControllerReachability,
} from '../../tests/fixtures/runner/machine.js';
import {
  assertConfiguredReviewLease,
  assertLifecycleReservation,
} from '../../tests/fixtures/machine/reservation.js';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild as spawnSync,
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
const SUBMIT_REFUSALS = 'AGENT_APPROVAL_REQUIRED BAD_BUILD_ESTIMATE BOARD_SCHEMA_BEHIND BOARD_UNAVAILABLE CLAUSE_EVIDENCE_KIND CLAUSE_EVIDENCE_REQUIRED CLAUSE_REASONING_ONLY EMPTY_SUBMIT GIT_SYNC_FOLDER KERNEL_EXPORT_APPROVAL KERNEL_EXPORT_SOURCE MILESTONES_CORRUPT SEAL_REVISION SEAL_STALE SEAL_STORE SHIM_IMPORT_PARSER UNKNOWN_SPEC'.split(' ');
/**
 * Where each move starts in the code. Accept and reject share the board's verify and the CLI's, so
 * they answer for its refusals together.
 */
const ENTRY_POINTS = [
  { verbs: ['claim'], at: ['../packages/store/src/io/board.js#claim'] },
  { verbs: ['release'], at: ['../packages/store/src/io/board.js#release'] },
  { verbs: ['submit'], at: ['../packages/store/src/io/board.js#submit', '../apps/cli/src/io/commands/submit.js#submitHere'] },
  { verbs: ['reserve'], at: ['../packages/store/src/io/board.js#reserveReview', '../packages/store/src/io/board.js#reserveNextReview'] },
  { verbs: ['accept', 'reject'], at: ['../packages/store/src/io/board.js#verify', '../apps/cli/src/io/commands/verify.js#verifyHere'] },
  { verbs: ['escalate'], at: ['../packages/store/src/logic/board/escalate.js#escalate'] },
  { verbs: ['withdraw'], at: ['../packages/store/src/io/board.js#withdraw'] },
  { verbs: ['refreeze'], at: ['../packages/store/src/io/board.js#refreeze'] },
  { verbs: ['reopen'], at: ['../packages/store/src/io/board.js#reopen'] },
];
/** Setup refusals have no item move, but stay in the same reachability audit. */
/** Runner refusals reach lifecycle checks through these package and worker entry points. */
const RUNNER_ENTRY_FILES = ['../packages/runners/index.js', '../packages/gate/src/io/slot.js', '../packages/runners/src/io/result.js',
  '../packages/runners/src/io/dispatch.js', '../apps/runner/src/io/worker/entry.js'];
const NON_MOVE_ENTRY_POINTS = [
  '../apps/lib/src/logic/native.js#openBoard', // Physical storage is composed before any item move.
  '../packages/store/index.js#recordSpecApprovalBaseline', // A distinct bootstrap operation precedes the requested move.
  '../apps/cli/src/io/join.js#refuseRemoteCoordinatorModel',
  // Child-process commands may be serialized into scripts, so audit this exported setup guard directly.
  '../packages/resources/src/io/main.js#gateSlotEnvironment',
  '../packages/person/src/io/signing/cli.js#pinRelayAuthority', // Reads the relay's authority before a person command (#408).
];

/**
 * Calls whose refusals an entry point catches and reports as another: submit and verify read a
 * cited row taken out of force as a changed criterion, CRITERIA_CHANGED. Submit also keeps its
 * original gate refusal when a best-effort main comparison or its attribution cannot be read, and
 * reads committed doctrine rules leniently: a doctrine it cannot parse carries no check [D1].
 */
const CAUGHT = {
  // The rigor auto-draft switch reads pullboard.json to honor rigor.autoDraft; a missing or bad config keeps the default and never refuses release or reopen.
  '../packages/store/src/io/board/shout.js#rigorAutoDraftOn': ['../packages/config/index.js#loadConfig'],
  // A lane-policy refresh tries the freezer only to compare digests; a refusal there keeps the pinned policy (#2886).
  '../apps/cli/src/io/claim.js#refreshesLanePolicy': ['../apps/cli/src/io/claim.js#freezer'],
  // nextFor converts an exited-session refusal into a skip reason; reserveNextReview returns that
  // reason as data rather than raising the refusal from the reserve move.
  '../packages/store/src/io/board/next.js#nextFor': ['../packages/store/src/logic/exit/rules/continuation.js#exitContinuationProblem', '../packages/items/index.js#expectedBuildProblem'], // An over-budget item is a skip reason.
  // An unknown code map keeps the file collision; every read inside it is caught.
  '../packages/items/src/io/planning.js#schedulingMap': ['../packages/git/index.js#mainCheckout', '../packages/git/index.js#repoInfo', '../packages/git/index.js#git', '../packages/codemap/index.js#readCodeMap'],
  '../packages/verify/src/logic/review/reachability.js#unreviewableStrict': ['../packages/verify/src/logic/review/eligibility.js#reviewEligibility'], // Eligibility is read as data; only its own refusal escapes.
  // Invalid authenticated-link metadata remains an unavailable dependency inside these exact catches.
  '../packages/items/src/logic/cross/repo.js#stateFor': ['../packages/kernel/index.js#boardLinkRecord', '../packages/kernel/src/logic/registry.js#boardLinkRecord', '../packages/store/src/logic/board/link.js#readReceivedBoardState'],
  // Review eligibility returns Refused values as data, and this helper also catches thrown eligibility refusals.
  '../packages/seats/src/logic/line/capacity/board.js#oldestCapacityReview': ['../packages/store/src/io/board.js#reviewerChecks'],
  '../apps/cli/src/io/commands/submit.js#submitHere': ['../apps/cli/src/io/commands/land.js#landAfterAcceptance', '../packages/flakes/src/io/native.js#observeFailure', '../apps/cli/src/io/entry.js#freezer', '../apps/cli/src/io/claim.js#freezer', '../packages/landing/src/io/main/red.js#compareMainFailures', '../packages/landing/src/io/main/red.js#matchingReworks', '../packages/doctrine/src/io/checks.js#checkRulesAt'],
  // Machine-verified submit lands after its record, and that landing call is caught like verify's.
  // The same catches as reached at the CLI's moved source (#2886).
  // The exact post-verdict landing call and optional flake observations are caught; neither can refuse an already-recorded verdict.
  '../apps/cli/src/io/commands/verify.js#verifyHere': ['../apps/cli/src/io/commands/land.js#landAfterAcceptance', '../packages/flakes/src/io/native.js#observeFailure'],
  // Invalid approval evidence is data, not a lifecycle refusal; runtime controls keep it unconfirmed.
  '../packages/spec/src/io/approval.js#approvalEvidence': ['../packages/spec/src/io/main.js#readSignoffs'],
  '../packages/spec/src/io/approval.js#confirmedDecision': ['../packages/spec/src/io/signature.js#verifyRowDecision'],
  // specApprovalState turns a Refused from the canonical baseline reader into invalid evidence.
  '../packages/spec/src/io/approval.js#specApprovalState': ['../packages/store/index.js#specApprovalBaseline', '../packages/store/src/io/board/query.js#specApprovalBaseline'],
  // Historical decline metadata is parsed inside a non-throwing boundary, covered by the Rigor history control.
  '../packages/store/src/io/board.js#reopen': ['../packages/rigor/src/logic/notices.js#declinedRigorSource'],
  '../packages/rigor/src/logic/notices.js#declinedRigorSource': ['../packages/spec/index.js#parseSpec'], // Only the historical source parser is caught here.
  // Rigor projection folds inspect invalid cause results as data, never lifecycle refusals.
  '../packages/store/src/logic/board/rigor.js#eventCauses': ['../packages/store/src/logic/board/rigor.js#causeProblem'],
  '../packages/rigor/src/logic/counter.js#neverKey': ['../packages/store/index.js#causeProblem'],
  // Historical decline grammar is caught locally; typed readers return invalid evidence as null.
  '../packages/rigor/src/logic/counter.js#declineKey': ['../packages/spec/src/logic/grammar.js#parseSpec', '../packages/spec/index.js#parseSpec'],
  '../packages/store/src/logic/board/rigor/provenance.js#readRigorSource': ['../packages/store/src/logic/board/rigor.js#causeProblem'],
  '../packages/store/src/logic/board/rigor/auto.js#readAutomaticRigorSource': ['../packages/store/src/logic/board/rigor.js#causeProblem'],
  // Only an unsupported historical grammar is ignored; new caller refusals remain audited below.
  '../packages/store/src/logic/board/rigor/auto.js#automaticDecisionSource': ['../packages/spec/src/logic/grammar.js#parseSpec', '../packages/spec/index.js#parseSpec'],
  '../packages/store/src/logic/board/rigor/auto.js#rigorDecisionKey': ['../packages/spec/src/logic/grammar.js#parseSpec', '../packages/spec/index.js#parseSpec'],
  '../packages/person/src/io/proof.js#signedRowDecisionsMatch': ['../packages/spec/src/io/main.js#answerQuestion', '../packages/spec/index.js#answerQuestion'], // A non-throwing proof: an unbuildable answer reads false (#408).
};
/**
 * Encrypted transport authenticates/orders a move; its board operation is walked separately above.
 * Keep walking the CLI dispatcher itself so a new item rule there cannot hide behind this boundary.
 */
const TRANSPORT_BOUNDARIES = new Set(['../packages/link/src/io/relay.js#relayLinked', '../packages/link/src/io/relay.js#relayOperation', '../packages/link/src/io/relay.js#relayRecovered', '../packages/link/src/io/relay.js#relayCommandReceipt', '../packages/link/src/io/relay.js#relayCommandReceiptReported']);
// This independently ordered bootstrap happens before the requested move; its refusals remain audited above.
const SETUP_EDGES = { '../apps/cli/src/io/claim.js#ordered': ['../packages/store/index.js#recordSpecApprovalBaseline'] };

/**
 * A walk over this package's source: the refusal codes a function raises, itself or through the
 * functions it calls, followed across imports and into the functions the CLI hands the board.
 *
 * @param {(file: string) => string} read - The source of a file in src/.
 * @param {{ caught?: boolean }} [options] Honor explicit caller/callee catch boundaries for escaping codes.
 * @returns {{ functions: (file: string) => string[], refusalsOf: (key: string, skip?: Set<string>) => Set<string> }}
 */
function codeWalk(read, { caught = false } = {}) {
  const files = new Map();
  const localFacts = new Map();
  const load = (file) => {
    if (!files.has(file)) {
      const { sourceFile, source } = machineSourceModule(file, read);
      files.set(file, sourceFacts(source, sourceFile));
    }
    return files.get(file);
  };
  const refusalsOf = (key, skip = new Set(), seen = new Set()) => {
    if (seen.has(key) || [...skip].some(entry => entry === key) || TRANSPORT_BOUNDARIES.has(key)) return new Set();
    seen.add(key);
    const [file, name] = key.split('#');
    const { bodies, named, spaces, source, stars } = load(file);
    // A facade may import and re-export the helper; follow its real definition after extraction.
    if (!bodies.has(name) && named.has(name)) return refusalsOf(named.get(name), skip, seen);
    // A public export-star front door retains every concrete provider's refusal path.
    if (!bodies.has(name) && stars.length) {
      const codes = new Set();
      for (const from of stars) for (const code of refusalsOf(`${from}#${name}`, skip, seen)) codes.add(code);
      return codes;
    }
    // Loaded source is fixed within this walk; local scans do not depend on the caller's seen/skip sets.
    let facts = localFacts.get(key);
    if (!facts) {
      const body = bodies.get(name) ?? '';
      const callbacks = CALLBACKS[file];
      const codes = new Set([...body.matchAll(/new Refused\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g)].map((match) => match[2]));
      const callees = [
        ...[...body.matchAll(/(?<!\w)(?<!(?<!\.\.)\.)(\w+)\(/g)].map(([, callee]) => (bodies.has(callee) ? `${file}#${callee}` : named.get(callee) ?? callbacks?.[callee])),
        ...[...body.matchAll(/\b(\w+(?:\.\w+)*)\.(\w+)\(/g)].map(([, space, callee]) => (spaces.has(space) ? `${spaces.get(space)}#${callee}` : callbacks?.[`${space}.${callee}`])),
      ];
      callees.push(...runnerControllerCallees(file, body, source));
      facts = { codes, callees };
      localFacts.set(key, facts);
    }
    const codes = new Set(facts.codes);
    for (const callee of facts.callees.filter(Boolean)) {
      if (caught && (CAUGHT[key] ?? []).some(entry => entry === callee)) continue;
      if (caught && (SETUP_EDGES[key] ?? []).includes(callee)) continue;
      for (const code of refusalsOf(callee, skip, seen)) codes.add(code);
    }
    return codes;
  };
  return { functions: (file) => [...(load(file).bodies.size ? load(file).bodies.keys() : load(file).named.keys())], refusalsOf };
}

/**
 * A file in src/ as it is on disk.
 *
 * @param {string} file
 * @returns {string}
 */
const fromDisk = sourceReader(workingSourceInventory(fileURLToPath(new URL('../../../..', import.meta.url)), sourceDirectories(packageFiles(fileURLToPath(new URL('../../../..', import.meta.url))))));

/**
 * The refusal codes the named moves declare, or the whole declaration's when none is named: their
 * guards' codes, exit guards included, their wrong-state codes, and the unknown move's.
 *
 * @param {any} machine
 * @param {string[]} [verbs]
 * @returns {Set<string>}
 */
function declaredCodes(machine, verbs) {
  const moves = verbs ? machine.moves.filter((move) => verbs.includes(move.verb)) : machine.moves;
  const used = new Set(moves.flatMap((move) => machineRules.effectiveGuards(move, machine)));
  return new Set([
    ...machine.guards.filter((guard) => !verbs || used.has(guard.id)).flatMap((guard) => [guard.refuse, ...(guard.alsoRefuses ?? []).map((entry) => entry.code)]),
    ...moves.flatMap((move) => [move.refuse, ...(move.alsoRefuses ?? []).map((entry) => entry.code)]),
    machine.unknownMove.refuse,
  ].filter(Boolean));
}

/**
 * Where a declaration and the code disagree: a refusal a move raises today that the move does not
 * declare, or a code the declaration names that the board, CLI and spec parser never raise.
 *
 * @param {any} machine
 * @param {(file: string) => string} [read]
 * @returns {string[]}
 */
function codeProblems(machine, read = fromDisk) {
  const walk = codeWalk(read, { caught: true });
  const problems = new Set();
  for (const { verbs, at } of ENTRY_POINTS) {
    const declared = declaredCodes(machine, verbs);
    for (const entry of at) {
      for (const code of walk.refusalsOf(entry)) {
        if (!declared.has(code) && !(code in NOT_MOVES)) problems.add(`${code} is raised by ${verbs.join(' and ')} but not declared there`);
      }
    }
  }
  const commandFiles = fs.readdirSync(new URL('../../src/io/commands/', import.meta.url)).filter((name) => name.endsWith('.js') && name !== 'index.js').map((name) => `../apps/cli/src/io/commands/${name}`);
  const moveFiles = new Set([...read('../packages/store/src/io/board.js').matchAll(/^import \{ \w+ \} from (['"])(\.\/(?:board-[\w-]+|board\/[\w/-]+)\.js)\1;$/gmu)].map((match) => posix.join('../packages/store/src/io', match[2]))), raised = new Set([
    '../packages/store/src/io/board.js', '../packages/store/src/logic/board/reland.js', ...moveFiles, '../apps/cli/src/io/entry.js', '../packages/spec/src/io/main.js', '../packages/gate/src/io/submit.js', ...RUNNER_ENTRY_FILES, ...commandFiles,
  ].flatMap((file) => walk.functions(file).flatMap((name) => [...walk.refusalsOf(`${file}#${name}`)])));
  for (const code of declaredCodes(machine)) if (!raised.has(code)) problems.add(`${code} is declared but the board, CLI and spec parser never raise it`);
  return [...problems];
}

/**
 * The source of src/ with one line of one file rewritten, for a broken copy of the code. Refuses if
 * the line is not there, so a refactor cannot quietly turn the broken copy into the real one.
 *
 * @param {string} file
 * @param {RegExp} line
 * @param {string} replacement
 * @returns {(name: string) => string}
 */
function editedSource(file, line, replacement) {
  return (name) => {
    const source = fromDisk(name);
    // The moved Rigor cell reaches src/ files as ../src/<file>; it is the same file.
    if (name.replace(/^\.\.\/src\//, '') !== file) return source;
    assert.match(source, line, `${file} still has the line this broken copy rewrites`);
    return source.replace(line, replacement);
  };
}

/**
 * A deep copy of the declaration to break, so the real one stays whole.
 *
 * @returns {any}
 */
const copy = () => structuredClone(machineRules.MACHINE);


/**
 * Accept and reject hold a verifier to the same checks, in the same order, until the verdict's own
 * rules, so the bar does not depend on which way the verifier decides.
 *
 * @param {any} machine
 * @returns {string[]}
 */
function verdictsDiverge(machine) {
  const [accept, reject] = ['accept', 'reject'].map((verb) => moveOf(machine, verb).guards);
  const shared = Math.max(accept.indexOf('criterionUnchanged'), reject.indexOf('criterionUnchanged')) + 1;
  const same = shared > 0 && accept.slice(0, shared).join() === reject.slice(0, shared).join();
  return same ? [] : [`accept checks ${accept.slice(0, shared).join(', ')} before its verdict, but reject checks ${reject.slice(0, shared).join(', ')}`];
}

/** The exit guards each final state needs, and the rule each one stands for. */
const PINNED = {
  verified: { notBuilder: 'V1', criterionUnchanged: 'V3', proofNoted: 'V5', atSubmittedCommit: 'V7' },
  withdrawn: { coordinatorOnly: 'only the coordinator withdraws', noteGiven: 'the reason stays on the item' },
};

/**
 * Exit guards a final state has lost, each named with the rule it stands for.
 *
 * @param {any} machine
 * @returns {string[]}
 */
function unpinned(machine) {
  return Object.entries(PINNED).flatMap(([state, guards]) => Object.entries(guards)
    .filter(([id]) => !(machine.exitGuards[state] ?? []).includes(id))
    .map(([id, rule]) => `${state} no longer requires ${id} (${rule}) of every move into it`));
}

/** Each property, broken the way a real board could break, and what the check must then say. */
const BROKEN = [
  {
    property: 'every state, guard and role a move names is declared',
    breaks: (machine) => moveOf(machine, 'claim').from.push('limbo'),
    says: /claim: no state "limbo"/,
  },
  {
    property: 'every state is reachable from open',
    breaks: (machine) => {
      machine.states.push({ id: 'orphan', final: true, means: 'nothing leads here', requires: [] });
      machine.exitGuards.orphan = ['notBuilder'];
    },
    says: /state orphan cannot be reached from open/,
  },
  {
    property: 'every non-final state has a way out',
    breaks: (machine) => {
      machine.states.push({ id: 'parked', means: 'set aside', requires: [] });
      machine.moves.push({ verb: 'park', from: ['open'], to: 'parked', by: ['agent', 'coordinator'], refuse: 'CLOSED', guards: ['joined', 'itemExists', machineRules.IN_STATE] });
    },
    says: /state parked is a trap/,
  },
  {
    property: 'nothing leaves a final state',
    breaks: (machine) => machine.moves.push({ verb: 'restore', from: ['withdrawn'], to: 'open', by: ['agent', 'coordinator'], refuse: 'CLOSED', guards: ['joined', 'coordinatorOnly', 'itemExists', machineRules.IN_STATE] }),
    says: /final state withdrawn has a move out/,
  },
  {
    property: 'every final state has exit guards',
    breaks: (machine) => {
      machine.exitGuards.withdrawn = [];
    },
    says: /final state withdrawn has no exit guards/,
  },
  {
    property: 'accept names every exit guard of verified',
    breaks: (machine) => {
      const accept = moveOf(machine, 'accept');
      accept.guards = accept.guards.filter((id) => id !== 'notBuilder');
    },
    says: /accept reaches verified without naming its exit guard notBuilder: a second door/,
  },
  {
    property: 'no second door into verified',
    breaks: (machine) => machine.moves.push({ verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', machineRules.IN_STATE], sets: ['item_verified_by'] }),
    says: /land reaches verified without naming its exit guard atSubmittedCommit: a second door/,
  },
  {
    property: 'every guard names a refusal code',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'laneOpen').refuse = '';
    },
    says: /guard laneOpen names no refusal code/,
  },
  {
    property: 'every guard says the next step',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'laneOpen').next = ' ';
    },
    says: /guard laneOpen refuses without a next step/,
  },
  {
    property: 'every additional refusal says its next step',
    breaks: (machine) => {
      machine.guards.find((guard) => guard.id === 'rowsInForce').alsoRefuses[0].next = '';
    },
    says: /guard rowsInForce refusal A5_GRAMMAR_VERSION has no next step/,
  },
  {
    property: 'every guard is used by some move',
    breaks: (machine) => machine.guards.push({ id: 'unused', refuse: 'UNUSED', rule: 'nothing', next: 'nothing', source: 'board' }),
    says: /guard unused is declared but no move uses it/,
  },
  {
    property: "every caller's move checks the item's state once",
    breaks: (machine) => {
      const release = moveOf(machine, 'release');
      release.guards = release.guards.filter((id) => id !== machineRules.IN_STATE);
    },
    says: /release checks the item's state 0 times, not once/,
  },
  {
    property: "the coordinator's moves name coordinatorOnly",
    breaks: (machine) => {
      moveOf(machine, 'withdraw').by = ['agent', 'coordinator'];
    },
    says: /withdraw is for agent or coordinator, but its guards name coordinatorOnly/,
  },
  {
    property: "the clock's move is the clock's alone",
    breaks: (machine) => {
      moveOf(machine, 'lapse').by = ['clock', 'agent'];
    },
    says: /lapse mixes the clock with callers/,
  },
  {
    property: "every move sets its target state's fields",
    breaks: (machine) => {
      moveOf(machine, 'submit').sets = ['item_built_by'];
    },
    says: /submit from claimed can reach submitted without item_commit/,
  },
];

test('the declared lifecycle is sound: reachable, no traps, no second door, every refusal with a next step [M1, M2, M4]', () => {
  assert.deepEqual(machineRules.machineProblems(), []);
  assert.deepEqual(machineRules.MACHINE.states.map((state) => state.id), ['open', 'claimed', 'submitted', 'verified', 'withdrawn']);
  assert.deepEqual(machineRules.MACHINE.states.filter((state) => state.final).map((state) => state.id), ['withdrawn']);
  assert.deepEqual(machineRules.MACHINE.moves.map((move) => move.verb), ['patch-objected', 'patch-claimed', 'patch', 'rehomeImport', 'intake', 'claim', 'release', 'lapse', 'submit', 'submit-merge', 'reserve', 'accept', 'reject', 'reopen', 'reland', 'escalate', 'refreeze', 'refreeze', 'withdraw']);
  assert.deepEqual(machineRules.MACHINE.moves.find((move) => move.verb === 'rehomeImport').sets, ['item_verified_by', 'item_commit']);
});

for (const broken of BROKEN) {
  test(`a broken copy fails the check: ${broken.property} [M4]`, () => {
    const machine = copy();
    broken.breaks(machine);
    const problems = machineRules.machineProblems(machine);
    assert.ok(problems.some((problem) => broken.says.test(problem)), `expected ${broken.says}, got:\n${problems.join('\n')}`);
    assert.deepEqual(machineRules.machineProblems(), [], 'the real declaration stays sound');
  });
}

test('a door declared without its exit guards still passes them [M2]', () => {
  const machine = copy();
  const land = { verb: 'land', from: ['submitted'], to: 'verified', by: ['agent', 'coordinator'], refuse: 'NOT_SUBMITTED', guards: ['joined', 'itemExists', machineRules.IN_STATE] };
  machine.moves.push(land);
  const passes = machineRules.effectiveGuards(land, machine);
  for (const id of machine.exitGuards.verified) assert.ok(passes.includes(id), `land passes ${id}`);
  assert.deepEqual(passes.slice(0, land.guards.length), land.guards, 'its own guards come first, in order');
  assert.deepEqual(machineRules.effectiveGuards(moveOf(machineRules.MACHINE, 'accept')), moveOf(machineRules.MACHINE, 'accept').guards, 'accept names them all already, so nothing is added');
});

test('verified and withdrawn keep the exit guards their rules need, and a copy that drops one fails [V1, V3, V5, V7, M2, M4]', () => {
  assert.deepEqual(unpinned(machineRules.MACHINE), []);
  const broken = copy();
  broken.exitGuards.verified = broken.exitGuards.verified.filter((id) => id !== 'notBuilder');
  assert.deepEqual(unpinned(broken), ['verified no longer requires notBuilder (V1) of every move into it']);
});

test('accept and reject hold a verifier to the same checks until the verdict, and a copy that splits them fails [M1, M4]', () => {
  assert.deepEqual(verdictsDiverge(machineRules.MACHINE), []);
  const broken = copy();
  const accept = moveOf(broken, 'accept');
  accept.guards = accept.guards.filter((id) => id !== 'routeAllows');
  assert.equal(verdictsDiverge(broken).length, 1);
});

test('clause 1: every refusal code that submit and release raise is declared on that move, and every declared code is raised [C7,M1]', () => {
  const problems = codeProblems(machineRules.MACHINE);
  assert.deepEqual(problems, []);
  assert.deepEqual(problems.filter(problem => /\bis raised by (?:release|reserve|reopen|withdraw|refreeze|claim)\b/u.test(problem)), [],
    'clause 1: release, reserve, reopen, withdraw, refreeze and claim have no undeclared refusal lines');
  const walk = codeWalk(fromDisk);
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#claim').has('UNKNOWN_SPEC'), 'the walk follows claim into the freezer the CLI hands it');
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#refreeze').has('UNKNOWN_SPEC'), 'and refreeze too');
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#claim').has('A5_GRAMMAR_VERSION'), 'grammar declarations can stop a claim with their own code');
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#refreeze').has('A5_GRAMMAR_VERSION'), 'and stop a refreeze too');
  assert.ok(walk.refusalsOf('../apps/cli/src/io/commands/submit.js#submitHere').has('UNKNOWN_SPEC'), 'submit calls the freezer too');
  assert.ok(!walk.refusalsOf('../apps/cli/src/io/commands/submit.js#submitHere', new Set(CAUGHT['../apps/cli/src/io/commands/submit.js#submitHere'])).has('UNKNOWN_SPEC'), 'and catches what it raises');
  assert.ok(walk.refusalsOf('../apps/cli/src/io/entry.js#freezer').has('A5_GRAMMAR_VERSION'), 'the freezer propagates an unsupported grammar version');
  for (const code of ['NOT_CLAIMABLE', 'LANE_HELD', 'GATE_RED', 'NO_GATE', 'NOT_AT_COMMIT', 'SELF_VERIFY', 'BAD_DECISION']) {
    assert.ok(ENTRY_POINTS.some(({ at }) => at.some((entry) => walk.refusalsOf(entry).has(code))), `the walk finds ${code}`);
  }
  for (const code of Object.keys(NOT_MOVES)) {
    const moveRaises = ENTRY_POINTS.some(({ at }) => at.some((entry) => walk.refusalsOf(entry).has(code)));
    const setupRaises = [...NON_MOVE_ENTRY_POINTS, ...RUNNER_ENTRY_FILES.flatMap((file) => walk.functions(file).map((name) => `${file}#${name}`))]
      .some((entry) => walk.refusalsOf(entry).has(code));
    assert.ok(moveRaises || setupRaises, `${code} is listed as not a move because a move or setup code path raises it`);
  }
});

test('clause 1: submit refusals are declared or classified as setup [M1]', () => {
  const declared = declaredCodes(machineRules.MACHINE, ['submit']);
  for (const code of SUBMIT_REFUSALS) assert.ok(declared.has(code) || code in NOT_MOVES, `${code} is covered by M1`);
  assert.deepEqual(codeProblems(machineRules.MACHINE), [], 'no submit refusal is raised but undeclared');
});
test('clause 1: a broken copy of the declaration fails the check against the code, both ways [M1, M4]', () => {
  const noLaneHold = copy();
  noLaneHold.guards = noLaneHold.guards.filter((guard) => guard.id !== 'laneOpen');
  for (const move of noLaneHold.moves) move.guards = move.guards.filter((id) => id !== 'laneOpen');
  assert.deepEqual(codeProblems(noLaneHold), ['LANE_HELD is raised by claim but not declared there']);

  const noRows = copy();
  noRows.guards = noRows.guards.filter((guard) => guard.id !== 'rowsInForce');
  for (const move of noRows.moves) move.guards = move.guards.filter((id) => id !== 'rowsInForce');
  assert.deepEqual(codeProblems(noRows).sort(), [
    'A5_GRAMMAR_VERSION is raised by claim but not declared there',
    'A5_GRAMMAR_VERSION is raised by refreeze but not declared there',
    'AGENT_APPROVAL_REQUIRED is raised by claim but not declared there',
    'AGENT_APPROVAL_REQUIRED is raised by refreeze but not declared there',
    'BAD_CONFIG is raised by claim but not declared there',
    'BAD_CONFIG is raised by refreeze but not declared there',
    'NO_POLICY is raised by claim but not declared there',
    'NO_POLICY is raised by refreeze but not declared there',
    'UNKNOWN_SPEC is raised by claim but not declared there',
    'UNKNOWN_SPEC is raised by refreeze but not declared there',
  ]);

  const noRouteOnVerdicts = copy();
  for (const verb of ['accept', 'reject']) {
    const move = moveOf(noRouteOnVerdicts, verb);
    move.guards = move.guards.filter((id) => id !== 'routeAllows');
  }
  assert.deepEqual(codeProblems(noRouteOnVerdicts), ['ROUTE is raised by accept and reject but not declared there']);

  const noVerdictRefusals = copy();
  const verdictCodes = ['AGENT_APPROVAL_REQUIRED', 'SUBMISSION_PROOF', 'UNKNOWN_SPEC'];
  for (const verb of ['accept', 'reject']) {
    const move = moveOf(noVerdictRefusals, verb);
    move.alsoRefuses = move.alsoRefuses.filter(entry => !verdictCodes.includes(entry.code));
  }
  assert.deepEqual(codeProblems(noVerdictRefusals).sort(), verdictCodes.map(code => `${code} is raised by accept and reject but not declared there`),
    'clause 1: verdict refusals stay declared rather than hidden by the setup exemptions');

  const invented = copy();
  invented.guards.push({ id: 'moonPhase', refuse: 'WRONG_MOON', rule: 'the moon is full', next: 'wait', source: 'board' });
  moveOf(invented, 'claim').guards.push('moonPhase');
  assert.deepEqual(codeProblems(invented), ['WRONG_MOON is declared but the board, CLI and spec parser never raise it']);
});

test('a broken copy of the code fails the check: a refusal added wherever a move reaches [M1, M4]', () => {
  for (const [file, pattern] of [
    ['../packages/kernel/src/logic/registry.js', /^export function boardLinkRecord\(value\) \{$/m],
    ['../packages/store/src/logic/board/link.js', /^export function readReceivedBoardState\(board, .*$/m],
  ]) {
    const inForeignReader = editedSource(file, pattern,
      "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
    assert.deepEqual(codeProblems(machineRules.MACHINE, inForeignReader), [], 'only the exact foreign evidence reader is caught as unavailable');
  }
  const inForeignCaller = editedSource('../packages/items/src/logic/cross/repo.js', /^function stateFor\(board, ref, readReceivedBoardState\) \{$/m,
    "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inForeignCaller).sort(), [
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by reserve but not declared there',
  ], 'the foreign-state caller is still audited outside its exact evidence catches');
  const inCaughtBaseline = editedSource('../packages/store/src/io/board/query.js', /^export function specApprovalBaseline\(board\) \{$/m,
    "$&\n  if (!board) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inCaughtBaseline), [], 'the real caller catches a Refused from the baseline reader');
  const inBaselineCaller = editedSource('../packages/spec/src/io/approval.js', /^export function specApprovalState\(root, .*$/m,
    "$&\n  if (!root) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inBaselineCaller).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by refreeze but not declared there',
    // Submit's pending-correction claim freezes the bar again, so it reaches the reader too (#2886).
    'MOON_PHASE is raised by submit but not declared there',
  ], 'the caller is not exempt: only the exact reader call is inside its catch');

  // Since #5404 a decline is final for its key, so recordAutomaticRigorDrafts no longer reads decisions and the two decision-source
  // readers left the move paths; the drafting entry itself is the one place the audit still reaches release, reopen and submit through.
  for (const [file, head] of [['../packages/rigor/src/io/auto.js', /^export function recordAutomaticRigorDrafts\(board, trigger, shout\) \{$/m]]) {
    const inHistoricalCaller = editedSource(file, head,
      "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
    assert.deepEqual(codeProblems(machineRules.MACHINE, inHistoricalCaller).sort(), [
      'MOON_PHASE is raised by accept and reject but not declared there',
      'MOON_PHASE is raised by release but not declared there',
      'MOON_PHASE is raised by reopen but not declared there',
      // Submit starts the companion objection window, which reads the same rigor sources (#2540).
      'MOON_PHASE is raised by submit but not declared there',
    ], 'the native summary fact keeps release in the rigor-source refusal audit alongside existing lifecycle moves');
  }

  const inFreeze = editedSource('../packages/spec/src/io/main.js', /^export function frozenCriterion\(spec, item, doctrine = null\) \{$/m, "$&\n  if (item.item_title === 'moon') throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inFreeze).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by refreeze but not declared there',
    'MOON_PHASE is raised by submit but not declared there',
  ], 'claim, refreeze and submit\'s pending-correction claim let a freeze refusal through; verify catches it');

  const inProof = editedSource('../packages/spec/src/io/approval.js', /^function approvalEvidence\(root, evidenceErrors\) \{$/m, "$&\n  if (!root) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inProof).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by refreeze but not declared there',
    'MOON_PHASE is raised by submit but not declared there',
  ], 'only caught proof readers are excluded; a new guard inside their caller is still audited');

  const inArrow = editedSource('../packages/seats/src/logic/route/escalation.js', /^export const canTake = .*$/m, "import { Refused } from '../../../../kernel/index.js';\nexport const canTake = (agentRoute, itemRoute) => { if (!agentRoute) throw new Refused('NO_ROUTE', 'no route'); return ROUTES.indexOf(itemRoute) <= ROUTES.indexOf(agentRoute); };");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inArrow).sort(), [
    'NO_ROUTE is raised by accept and reject but not declared there',
    'NO_ROUTE is raised by claim but not declared there',
    'NO_ROUTE is raised by reserve but not declared there',
  ], 'reserve reaches the route check through the reviewer checks it shares with a verdict');

  const doubleQuoted = editedSource('../apps/cli/src/io/read.js', /^(?:export )?const cdTo = .*$/m, "const cdTo = (root) => { if (!root) throw new Refused(\"NO_ROOT\", 'no root'); return 'cd ' + root + ' &&'; };");
  assert.deepEqual(codeProblems(machineRules.MACHINE, doubleQuoted), [
    'NO_ROOT is raised by submit but not declared there',
    'NO_ROOT is raised by accept and reject but not declared there',
  ]);
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A freeze that digests the title, as the real one digests the criterion.
 *
 * @param {any} item
 * @returns {{ text: string, digest: string }}
 */
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/**
 * A board file on disk with a coordinator and two web agents, opened the way the CLI opens it,
 * and a way to open the same file raw, as any agent with a shell could.
 *
 * @param {{ now: () => Date }} [clock] - The board's clock; the system's when left out.
 * @returns {{ file: string, board: any, raw: () => DatabaseSync, done: () => void }}
 */
function boardOnDisk(clock) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pullboard-machine-'));
  const file = join(dir, 'board.sqlite');
  const board = openBoard(file, clock, { gitRoot: policyRepository(dir) });
  store.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: 'review-vendor' });
  const handles = [board.db];
  return {
    file,
    board,
    raw: () => {
      const db = new DatabaseSync(file);
      handles.push(db);
      return db;
    },
    done: () => {
      for (const db of handles) {
        try {
          db.close();
        } catch {
          // already closed by the test
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A logic-only board uses the shared memory contract; raw connections stay in boardOnDisk. */
function memoryBoardLab(t, clock, { reviewerFamily = 'review-vendor' } = {}) {
  const board = fixtureBoard(t, { clock });
  store.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  store.register(board, { lane: 'web', path: '/repo-web-2', family: reviewerFamily });
  return { board };
}

/**
 * An item web-1 claimed and submitted.
 *
 * @param {any} board
 * @param {{ reviewFamily?: string }} [options] optional real item metadata for guard witnesses
 * @returns {number}
 */
function submittedItem(board, options = {}) {
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page', ...options });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
  return id;
}

/**
 * A submitted item whose queued gate has no captured proof receipt, so a reviewer finds GATE_PENDING.
 *
 * @param {any} board
 * @returns {number}
 */
function gatePendingItem(board) {
  const id = submittedItem(board);
  const item = store.getItem(board, id);
  recordSubmitHandoff(board.db, id, { version: 1, id: `job-pending-${id}`, agentId: 'web-1', commit: item.item_commit,
    executionCommit: item.item_commit, executionTree: item.item_tree, digest: item.item_frozen_digest, state: 'running' });
  return id;
}

/**
 * A verdict with what a careful verifier passes.
 *
 * @param {any} board
 * @param {number} id
 * @param {string} agentId
 * @param {'ACCEPT' | 'REJECT'} decision
 */
function verdictOn(board, id, agentId, decision) {
  const reason = decision === 'REJECT' ? { reason: 'TEST_FAILURE', clause: 'Page' } : {};
  store.verify(board, id, { agentId, decision, head: SHA_A, digest: 'digest:Page', policy: 'any', note: 'reverted the fix; its test went red; restored it', ...reason });
}

/**
 * Insert an ACCEPT by hand, as a forger would.
 *
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string} by
 * @param {string} commit
 * @param {string} [digest]
 */
function forgeAccept(db, id, by, commit, digest = 'digest:Page') {
  db.prepare(
    `INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
     VALUES (?, ?, 'ACCEPT', 'CRITERION_MET', 'forged', ?, ?, ?, '2026-10-06T00:00:00Z')`,
  ).run(id, by, commit, digest, commit);
}

/**
 * The names of a board file's triggers.
 *
 * @param {any} board
 * @returns {string[]}
 */
const triggerNames = (board) => board.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((row) => row.name);

test('the board file refuses, written by hand: an unknown state, an undeclared move, an unproven verified, a reasonless withdrawal, an edited record [M3]', () => {
  const lab = boardOnDisk();
  try {
    const open = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const built = submittedItem(lab.board);
    const raw = lab.raw();
    const refused = (sql, args, code) => assert.throws(() => raw.prepare(sql).run(...args), new RegExp(code), sql);
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['shipped', open], 'UNDECLARED_STATE');
    refused('UPDATE item SET item_status = ? WHERE item_id = ?', ['verified', open], 'MISSING_FIELD');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2', item_commit = ?, item_frozen_digest = 'digest:Forged', item_built_by = 'web-1' WHERE item_id = ?",
      [SHA_A, open], 'NOT_PROVEN');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-1', SHA_A);
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-1' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-2', SHA_B);
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    forgeAccept(raw, built, 'web-2', SHA_A, 'digest:Another criterion');
    refused("UPDATE item SET item_status = 'verified', item_verified_by = 'web-2' WHERE item_id = ?", [built], 'NOT_PROVEN');
    refused("UPDATE item SET item_status = 'withdrawn' WHERE item_id = ?", [open], 'MISSING_FIELD');
    refused("UPDATE event SET event_kind = 'nothing' WHERE event_id = 1", [], 'APPEND_ONLY');
    refused('DELETE FROM event', [], 'APPEND_ONLY');
    refused("UPDATE verdict SET verdict_by = 'web-2'", [], 'APPEND_ONLY');
    refused('DELETE FROM verdict', [], 'APPEND_ONLY');
    refused('DELETE FROM item WHERE item_id = ?', [open], 'KEPT');
    refused(
      "INSERT INTO item (item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at) VALUES ('web', 'Forged', 'verified', 'web-1', 'now', 'now')",
      [],
      'UNDECLARED_MOVE',
    );
    assert.equal(store.getItem(lab.board, open).item_status, 'open');
    assert.equal(store.getItem(lab.board, built).item_status, 'submitted');
  } finally {
    lab.done();
  }
});

test('every move the board makes passes the triggers: claim, submit, accept, reject, rework, release, escalate, refreeze, withdraw [M3]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const accepted = submittedItem(board);
  verdictOn(board, accepted, 'web-2', 'ACCEPT');
  store.merged(board, accepted, { agentId: 'coordinator', commit: SHA_A });
  const rejected = submittedItem(board);
  verdictOn(board, rejected, 'web-2', 'REJECT');
  store.claim(board, rejected, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  store.release(board, rejected, 'web-1', 'Release the rework fixture before escalation.', undefined, 'OTHER');
  store.escalate(board, rejected, { agentId: 'coordinator', note: 'two tries stayed red' });
  store.refreeze(board, rejected, { agentId: 'coordinator', freeze });
  const dropped = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Old idea' });
  store.claim(board, dropped, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000, freeze });
  store.withdraw(board, dropped, { agentId: 'coordinator', reason: 'superseded' });
  assert.deepEqual([accepted, rejected, dropped].map((id) => store.getItem(board, id).item_status), ['verified', 'open', 'withdrawn']);
});

test('an older board gets the triggers quietly on its next open; one dropped by hand comes back, and the log says so [M3]', () => {
  const lab = boardOnDisk();
  try {
    const id = store.addItem(lab.board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const every = machineRules.storeTriggers().map(({ name }) => name).sort();
    assert.deepEqual(triggerNames(lab.board), every);
    store.closeBoard(lab.board);

    const older = lab.raw();
    for (const name of every) older.exec(`DROP TRIGGER ${name}`);
    older.exec('PRAGMA user_version = 0');
    older.prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id);
    older.prepare("UPDATE item SET item_status = 'open' WHERE item_id = ?").run(id);
    older.close();

    const upgraded = openBoard(lab.file);
    assert.deepEqual(triggerNames(upgraded), every);
    assert.equal(upgraded.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'guards'").get().n, 0, 'an older board gets them quietly');
    store.closeBoard(upgraded);

    const tampered = lab.raw();
    tampered.exec('DROP TRIGGER machine_proof_verified');
    tampered.exec('DROP TRIGGER machine_item_move');
    tampered.exec('CREATE TRIGGER machine_item_move BEFORE UPDATE OF item_status ON item WHEN 0 BEGIN SELECT 1; END');
    // Only a board whose user_version is behind is audited on open (#1047); a guarded older board still reports.
    tampered.exec('PRAGMA user_version = 1');
    tampered.close();

    const restored = openBoard(lab.file);
    try {
      assert.deepEqual(triggerNames(restored), every);
      const logged = restored.db.prepare("SELECT event_by, event_detail FROM event WHERE event_kind = 'guards'").all();
      assert.deepEqual(logged.map((row) => [row.event_by, JSON.parse(row.event_detail)]), [['board', { missing: ['machine_proof_verified'], changed: ['machine_item_move'], stale: [] }]]);
      assert.throws(() => lab.raw().prepare("UPDATE item SET item_status = 'verified' WHERE item_id = ?").run(id), /MISSING_FIELD/);
    } finally {
      store.closeBoard(restored);
    }
  } finally {
    lab.done();
  }
});

test('the triggers come from the declaration, so a changed declaration changes them [M1, M3]', () => {
  assertRehomeTriggerDeclaration();
});

test("a verified item's proof cannot be rewritten afterwards: its commit, builder, verifier or criterion [M3]", () => {
  const lab = boardOnDisk();
  try {
    const id = submittedItem(lab.board);
    verdictOn(lab.board, id, 'web-2', 'ACCEPT');
    const raw = lab.raw();
    const refused = (sql) => assert.throws(() => raw.prepare(sql).run(id), /NOT_PROVEN/, sql);
    refused(`UPDATE item SET item_commit = '${SHA_B}' WHERE item_id = ?`);
    refused("UPDATE item SET item_built_by = 'web-2' WHERE item_id = ?");
    refused("UPDATE item SET item_verified_by = 'web-1' WHERE item_id = ?");
    refused("UPDATE item SET item_frozen_digest = 'digest:Another criterion' WHERE item_id = ?");
    refused(`UPDATE item SET item_status = 'verified', item_commit = '${SHA_B}' WHERE item_id = ?`);
    raw.prepare(`UPDATE item SET item_merged_commit = '${SHA_A}' WHERE item_id = ?`).run(id);
    assert.deepEqual([store.getItem(lab.board, id).item_commit, store.getItem(lab.board, id).item_merged_commit], [SHA_A, SHA_A]);
  } finally {
    lab.done();
  }
});

test('a field a state needs cannot be blanked, on the way in or while the item stays, with any whitespace [M3]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const withdrawn = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Old idea' });
    store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'superseded' });
    const fresh = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Another' });
    const claimed = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    store.claim(board, claimed, { agentId: 'web-2', lane: 'web', leaseMs: 7_200_000, freeze });
    const built = submittedItem(board);
    const raw = lab.raw();
    const refused = (sql, args) => assert.throws(() => raw.prepare(sql).run(...args), /MISSING_FIELD/, `${sql} ${JSON.stringify(args)}`);
    refused("UPDATE item SET item_withdrawn_reason = '' WHERE item_id = ?", [withdrawn]);
    refused('UPDATE item SET item_withdrawn_reason = NULL WHERE item_id = ?', [withdrawn]);
    refused("UPDATE item SET item_status = 'withdrawn', item_withdrawn_reason = '' WHERE item_id = ?", [withdrawn]);
    for (const blank of [' ', '\t\n', ' ', ' ', '﻿', '　 ']) {
      refused("UPDATE item SET item_status = 'withdrawn', item_withdrawn_reason = ? WHERE item_id = ?", [blank, fresh]);
    }
    refused('UPDATE item SET item_owner = NULL WHERE item_id = ?', [claimed]);
    refused("UPDATE item SET item_commit = '' WHERE item_id = ?", [built]);
    assert.equal(store.getItem(board, withdrawn).item_withdrawn_reason, 'superseded');
    assert.equal(store.getItem(board, fresh).item_status, 'open');
    assert.throws(() => store.withdraw(board, fresh, { agentId: 'coordinator', reason: ' ' }), /NOTE_REQUIRED/, 'the command trims the same way');
  } finally {
    lab.done();
  }
});

test("a blank field in the board file is exactly what JavaScript's trim removes [M3]", () => {
  const trimmed = [];
  for (let code = 0; code <= 0xffff; code += 1) if (String.fromCharCode(code).trim() === '') trimmed.push(code);
  assert.deepEqual(machineRules.BLANKS, trimmed);
});

const BIN = join(import.meta.dirname, '../../pullboard.js');

/** Guards checked before the explicit transition: CLI facts and optional roadmap selection. */
const PRECHECKED = {
  claim: ['joined', 'checkProvesSomething'],
  submit: ['joined', 'checkProvesSomething', 'criterionUnchanged', 'treeClean', 'nothingUntracked', 'hasCommit', 'withinLane', 'trunkMergeClean', 'sourcePlaced', 'trunkInCandidate', 'infraExplained', 'doctrineHolds', 'clausesInspected', 'gateConfigured', 'queuedItemLease', 'gateGreen', 'proofRecorded', 'treeStillDuringGate', 'noUnverifiedStack'],
  reserve: ['coordinatorSaysAs', 'joined', 'roadmapReadable', 'companionWindow'],
  accept: ['coordinatorSaysAs', 'joined', 'companionWindow', 'atSubmittedCommit', 'reviewTreeCurrent', 'trunkMergeClean', 'queuedItemLease', 'itemCheckGreen', 'proofRecorded', 'noUnverifiedStack'],
  reject: ['coordinatorSaysAs', 'joined', 'companionWindow', 'atSubmittedCommit', 'reviewTreeCurrent'],
};


/**
 * The refusal code a call raises, or 'ok'.
 *
 * @param {() => unknown} run
 * @returns {string}
 */
function outcome(run) {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (!error.code) throw error;
    return error.code;
  }
}

/** A freeze for an item whose cited row has been retired. */
const retiredFreeze = () => {
  throw new Refused('UNKNOWN_SPEC', 'G1 is retired; fix the spec, or the coordinator withdraws the item');
};

/**
 * Set an item claimed by hand, with every field a claim carries, the way a test sets up a holder
 * the board's own guards would not let it reach directly.
 *
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {string} owner
 */
function holdByHand(db, id, owner) {
  db.prepare("UPDATE item SET item_status = 'claimed', item_owner = ?, item_lease_until = ?, item_frozen_digest = 'digest:Page' WHERE item_id = ?")
    .run(owner, new Date(Date.now() + 3_600_000).toISOString(), id);
}

test('claim refuses in the declared order, one failure peeled at a time, on a real board [M1, M2]', () => {
  const lab = boardOnDisk();
  try {
    const { board } = lab;
    const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
    const strong = store.register(board, { lane: 'web', path: '/repo-web-strong' });
    // The target expects 45 build minutes: a 60-minute budget admits it, and the board's 30-minute default peels buildScopeFits.
    const claimAs = (id, agentId, lane, freezer = retiredFreeze, buildBudgetMinutes = 60) => outcome(() => store.claim(board, id, { agentId, lane, leaseMs: 7_200_000, freeze: freezer, buildBudgetMinutes }));
    const done = submittedItem(board);
    const returned = submittedItem(board);
    // A reject reopens to anyone (REJECT_OPEN_ENGINE); a failed landing still waits for its builder first.
    verdictOn(board, returned, 'web-2', 'ACCEPT');
    store.reopen(board, returned, { agentId: 'coordinator', reopenFirstRefusalMinutes: 30, note: `test/page.test.js: failed case; merge commit ${SHA_B}` });
    const dependency = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const target = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page', after: [dependency], expectedBuildMinutes: 45 });
    const spare = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const raw = lab.raw();
    holdByHand(raw, target, 'web-2');
    store.claim(board, spare, { agentId: strong, lane: 'web', leaseMs: 7_200_000, freeze });
    store.claim(board, dependency, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    submitFixture(board, dependency, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
    store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
    store.holdItem(board, target, { agentId: 'coordinator', reason: 'item pause' });
    const fired = [claimAs(999, light, 'api'), claimAs(done, light, 'api')];
    store.setBarReady(board, { agentId: 'coordinator', enabled: true });
    store.editItem(board, target, { agentId: 'coordinator', brief: 'Unsigned bar edge' });
    fired.push(claimAs(target, light, 'api'));
    store.setBarReady(board, { agentId: 'coordinator', enabled: false });
    fired.push(claimAs(target, light, 'api'));
    store.releaseItemHold(board, target, { agentId: 'coordinator' });
    fired.push(claimAs(target, light, 'api'), claimAs(target, light, 'web'), claimAs(target, strong, 'web', retiredFreeze, 30), claimAs(target, strong, 'web'));
    verdictOn(board, dependency, 'web-2', 'ACCEPT');
    fired.push(claimAs(target, strong, 'web'), claimAs(returned, strong, 'web'));
    store.editItem(board, target, { agentId: 'coordinator', criterion: 'Pending correction before the lane guard.' });
    store.release(board, target, 'web-2', 'Release the fixture holder before checking the pending correction.', undefined, 'OTHER');
    fired.push(claimAs(target, strong, 'web'));
    store.refreeze(board, target, { agentId: 'coordinator', freeze });
    store.editItem(board, target, { agentId: 'coordinator', criterion: 'A new bar, so the next claim freezes it.' });
    fired.push(claimAs(target, strong, 'web'));
    store.releaseLane(board, 'web', { agentId: 'coordinator' });
    store.setLineSetting(board, { agentId: 'coordinator', key: 'wipPerReviewer', value: 1.5, reason: 'peel the actual capacity guard', window: { activeReviewers: 1 } });
    fired.push(claimAs(target, strong, 'web'));
    store.setLineSetting(board, { agentId: 'coordinator', key: 'wipPerReviewer', value: false, reason: 'peel the remaining existing guards', window: { activeReviewers: 1 } });
    fired.push(claimAs(target, strong, 'web'));
    store.release(board, spare, strong, 'Release the spare fixture claim before checking the next guard.', undefined, 'OTHER');
    fired.push(claimAs(target, strong, 'web'), claimAs(target, strong, 'web', freeze));
    assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, 'claim'), 'ok']);
    assert.deepEqual(fired, ['NO_ITEM', 'NOT_CLAIMABLE', 'BAR_NOT_READY', 'ITEM_HELD', 'WRONG_LANE', 'ROUTE', 'ITEM_BUILD_BUDGET', 'BLOCKED', 'HELD', 'REOPEN_HELD_FOR_BUILDER', 'PENDING_REFREEZE', 'LANE_HELD', 'LINE_WIP_LIMIT', 'ONE_CLAIM', 'UNKNOWN_SPEC', 'ok']);
  } finally {
    lab.done();
  }
});

test('submit, accept and reject refuse in the declared order, one failure peeled at a time [M1, M2]', t => {
  const lab = memoryBoardLab(t, undefined, { reviewerFamily: 'REQUIRED REVIEW' }); // Declared once: a family is one derived value (#1783).
  const { board } = lab;
  const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
  const submitAs = (id, agentId, commit) => outcome(() => submitFixture(board, id, { agentId, commit, tree: 'tree' }));
  const piece = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const submits = [submitAs(999, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_A)];
  store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submits.push(submitAs(piece, 'web-2', SHA_A));
  store.editItem(board, piece, { agentId: 'coordinator', criterion: 'A correction before submission.', reason: 'the fixture corrects its bar' });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  assert.equal(submits.at(-1), 'PENDING_REFREEZE', 'a pending correction stops the board submission before later guards');
  store.refreeze(board, piece, { agentId: 'web-1', freeze });
  store.setBarReady(board, { agentId: 'coordinator', enabled: true });
  store.editItem(board, piece, { agentId: 'coordinator', brief: 'Unsigned corrected bar' });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  store.setBarReady(board, { agentId: 'coordinator', enabled: false });
  submits.push(outcome(() => submitFixture(board, piece, { agentId: 'web-1', commit: SHA_A, tree: 'tree',
    submissionProof: { version: 99, files: [], full: false, deferred: true, reason: '' } })));
  submitFixture(board, piece, { agentId: 'web-1', commit: SHA_A, tree: 'tree' });
  verdictOn(board, piece, 'web-2', 'REJECT');
  store.claim(board, piece, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  const child = store.addItem(board, { by: 'web-1', lane: 'web', title: 'Part', parentId: piece });
  submits.push(submitAs(piece, 'web-1', SHA_A));
  store.withdraw(board, child, { agentId: 'coordinator', reason: 'folded into the parent' });
  submits.push(submitAs(piece, 'web-1', SHA_A), submitAs(piece, 'web-1', SHA_B));
  assert.deepEqual(submits, [...declaredBoardOrder(machineRules, PRECHECKED, 'submit'), 'ok']);

  // A family is one derived value since #1783, so each vendor role is its own seat rather than a rewritten column.
  const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
  const otherVendor = store.register(board, { lane: 'web', path: '/repo-web-other-vendor', family: 'BUILDER-VENDOR' });
  const otherRequired = store.register(board, { lane: 'web', path: '/repo-web-other-required', family: 'required review' });
  for (const verb of ['accept', 'reject']) {
    const decision = verb === 'accept' ? 'ACCEPT' : 'REJECT';
    store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
    const built = submittedItem(board, { reviewFamily: 'Required Review' });
    const vendorOnly = submittedItem(board, { sensitive: true });
    const landed = submittedItem(board);
    verdictOn(board, landed, 'web-2', 'ACCEPT');
    store.merged(board, landed, { agentId: 'coordinator', commit: SHA_A });
    const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    const pending = gatePendingItem(board);
    store.reserveReview(board, built, { agentId: 'web-2', leaseMs: 3_600_000, policy: 'any' });
    const judge = (id, agentId, fields) =>
      outcome(() => store.verify(board, id, { agentId, decision, head: SHA_A, digest: 'wrong', policy: 'coordinator', note: '', review: { commit: SHA_A, head: SHA_A, trunk: SHA_B, paths: ['web/page.js'] }, ...fields }));
    const bad = verb === 'accept' ? 'TEST_FAILURE' : 'NOPE';
    const good = verb === 'accept' ? undefined : 'TEST_FAILURE';
    const fired = [
      judge(999, 'web-2', { reason: bad }),
      judge(open, 'web-2', { reason: bad }),
      judge(pending, 'web-2', { reason: bad }),
      judge(landed, 'web-2', { reason: bad }),
      judge(built, 'web-2', { reason: bad, review: null }),
      judge(built, 'web-1', { reason: bad }),
      judge(built, light, { reason: bad }),
      judge(built, 'web-2', { reason: bad }),
      judge(built, other, { reason: bad, policy: 'any' }),
      /** Observe vendor refusal on Strict work, then restore the required-family peer for later guards. */
      judge(vendorOnly, otherVendor, { reason: bad, policy: 'any', familyPolicy: 'require' }),
      judge(built, otherRequired, { reason: bad, policy: 'any' }),
      judge(built, 'web-2', { reason: bad, policy: 'any' }),
      judge(built, 'web-2', { reason: bad, policy: 'any', digest: 'digest:Page' }),
      judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page' }),
      // Only a reject reads a cause key, so only its order has the malformed-cause step (#713).
      ...(verb === 'reject' ? [judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red', cause: 'free text' })] : []),
      judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red' }),
      ...(verb === 'reject' ? [judge(built, 'web-2', { reason: good, policy: 'any', digest: 'digest:Page', note: 'reverted the fix; its test went red', clause: 'Page' })] : []),
    ];
    assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, verb), 'ok'], verb);
  }
});

test('reserve refuses in the declared order, one failure peeled at a time [V15, M1, M2]', t => {
  const lab = memoryBoardLab(t, undefined, { reviewerFamily: 'REQUIRED REVIEW' }); // Declared once: a family is one derived value (#1783).
  const { board } = lab;
  const light = store.register(board, { lane: 'web', path: '/repo-web-light', route: 'light' });
  const other = store.register(board, { lane: 'web', path: '/repo-web-other' });
  // A family is one derived value since #1783, so each vendor role is its own seat rather than a rewritten column.
  const otherVendor = store.register(board, { lane: 'web', path: '/repo-web-other-vendor', family: 'BUILDER-VENDOR' });
  const otherRequired = store.register(board, { lane: 'web', path: '/repo-web-other-required', family: 'required review' });
  store.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
  const built = submittedItem(board, { reviewFamily: 'Required Review' });
  const vendorOnly = submittedItem(board, { sensitive: true });
  const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const reserveAs = (id, agentId, policy = 'coordinator', familyPolicy = 'off') => outcome(() => store.reserveReview(board, id, { agentId, leaseMs: 3_600_000, policy, familyPolicy }));
  const pending = gatePendingItem(board);
  const cooling = submittedItem(board);
  store.reserveReview(board, cooling, { agentId: 'web-2', leaseMs: 3_600_000, policy: 'any' });
  store.release(board, cooling, 'web-2', 'another reviewer should take it', undefined, 'OTHER');
  const fired = [reserveAs(999, 'web-2'), reserveAs(open, 'web-2'), reserveAs(pending, 'web-2'), reserveAs(cooling, 'web-2'), reserveAs(built, 'web-1'), reserveAs(built, light), reserveAs(built, 'web-2'), reserveAs(built, other, 'any')];
  fired.push(reserveAs(vendorOnly, otherVendor, 'any', 'require'));
  store.reserveReview(board, built, { agentId: otherRequired, leaseMs: 3_600_000, policy: 'any' });
  fired.push(reserveAs(built, 'web-2', 'any'), reserveAs(built, otherRequired, 'any'));
  assert.deepEqual(fired, [...declaredBoardOrder(machineRules, PRECHECKED, 'reserve'), 'ok']);
  assert.deepEqual(fired, ['NO_ITEM', 'NOT_SUBMITTED', 'GATE_PENDING', 'REVIEW_COOLDOWN', 'SELF_VERIFY', 'ROUTE', 'COORDINATOR_VERIFIES', 'REQUIRED_REVIEW_FAMILY', 'SAME_FAMILY', 'REVIEW_HELD', 'ok']);
});

test('a reserved review refuses every other verdict while its lease lives, and only then; a new submission starts free [V15]', t => {
  let at = Date.parse('2026-10-06T12:00:00.000Z');
  const lab = memoryBoardLab(t, { now: () => new Date(at) });
  const { board } = lab;
  const third = store.register(board, { lane: 'web', path: '/repo-web-3', family: 'review-vendor' });
  const id = submittedItem(board);
  const minutes = (count) => {
    at += count * 60_000;
    // A reservation holds only while its reviewer's seat is alive, so both reviewers keep beating as the clock moves.
    for (const seat of ['web-2', third]) heartbeatSeat(board, seat);
  };
  const reserve = (agentId) => store.reserveReview(board, id, { agentId, leaseMs: 30 * 60_000, policy: 'any' });
  const judge = (agentId, decision) =>
    outcome(() =>
      store.verify(board, id, {
        agentId,
        decision,
        reason: decision === 'REJECT' ? 'TEST_FAILURE' : undefined, ...(decision === 'REJECT' ? { clause: 'Page' } : {}),
        note: 'reverted the fix; its test went red',
        head: store.getItem(board, id).item_commit,
        digest: 'digest:Page',
        policy: 'any',
      }),
    );
  const holder = () => store.reviewHolder(board, store.getItem(board, id));
  const offered = (agentId) => store.nextFor(board, { agentId, lane: 'web', verify: true });

  assert.equal(reserve('web-2').item_review_until, '2026-10-06T12:30:00.000Z');
  assert.equal(holder(), 'web-2');
  assert.equal(offered(third).item ?? null, null, 'another agent is passed over');
  assert.match(offered(third).reasons.join('; '), /web-2 holds the review of #1 until 2026-10-06T12:30:00\.000Z/);
  assert.equal(outcome(() => reserve(third)), 'REVIEW_HELD');
  assert.equal(judge(third, 'ACCEPT'), 'REVIEW_HELD');
  assert.equal(judge(third, 'REJECT'), 'REVIEW_HELD');
  assert.equal(offered('web-2').item.item_id, id, 'the holder is offered its own review');

  minutes(20);
  assert.equal(reserve('web-2').item_review_until, '2026-10-06T12:50:00.000Z', 'reserving again renews the lease');
  minutes(25);
  assert.equal(judge(third, 'ACCEPT'), 'REVIEW_HELD', 'at 12:45 the renewed lease still holds');

  minutes(6);
  assert.equal(holder(), null, 'at 12:51 the lease has run out');
  assert.equal(offered(third).item.item_id, id);
  assert.equal(reserve(third).item_review_until, '2026-10-06T13:21:00.000Z');
  assert.equal(judge('web-2', 'ACCEPT'), 'REVIEW_HELD', 'a lapsed lease gives nothing over the agent that reserved since');
  assert.equal(judge(third, 'REJECT'), 'ok');
  assert.equal(store.getItem(board, id).item_review_by, third, 'the reservation stays on the record');
  assert.equal(holder(), null, 'but holds nothing once the item leaves submitted, though its lease lives until 13:21');

  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  submitFixture(board, id, { agentId: 'web-1', commit: SHA_B, tree: 'tree' });
  assert.equal(store.getItem(board, id).item_review_by, null, 'a new submission starts with no reservation');
  assert.equal(offered('web-2').item.item_id, id, 'though the last lease would live until 13:21');

  reserve('web-2');
  minutes(60);
  assert.equal(holder(), null);
  assert.equal(judge('web-2', 'ACCEPT'), 'ok', "the holder's own verdict is never refused for its lease having lapsed");
  assert.equal(store.getItem(board, id).item_status, 'verified');
  const reserved = store
    .events(board, { itemId: id })
    .filter((event) => event.event_kind === 'reserve')
    .map((event) => [event.event_by, JSON.parse(event.event_detail).until]);
  assert.deepEqual(reserved, [
    ['web-2', '2026-10-06T12:30:00.000Z'],
    ['web-2', '2026-10-06T12:50:00.000Z'],
    [third, '2026-10-06T13:21:00.000Z'],
    ['web-2', '2026-10-06T13:21:00.000Z'],
  ]);
});

test('next --verify reserves the review for the reviewLease and says until when; show names the holder; another verifier is passed over and refused [V15]', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pullboard-reserve-')));
  try {
    // A fixture seat never inherits the running agent's session: it joins with its own declared model.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CLAUDE|CODEX)/u.test(key))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      PULLBOARD_HOME: join(dir, 'home'),
      PULLBOARD_MACHINE_HOME: join(dir, 'home'),
    };
    // This journey submits through a real machine home and holds the gate in the submitting process, so it pins controller dispatch (#6182-#6185).
    fs.mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'controller' } });
    const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    // The test runner's per-test timeout bounds hangs without killing this CLI early under load.
    // Each worktree is its own native session, so a peer's review is never skipped as the builder's own session.
    const sessions = new Map();
    const session = (cwd) => { if (!sessions.has(cwd)) sessions.set(cwd, `00000000-0000-4000-8000-${String(sessions.size + 1).padStart(12, '0')}`); return sessions.get(cwd); };
    const run = (cwd, ...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd, env: { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session(cwd) }, encoding: 'utf8' });
    const repo = join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', reviewLease: '45m', lanes: { web: { owns: ['web/'] } } }));
    fs.writeFileSync(join(repo, 'SPEC.md'), '# Demo\n\n## G · Goals\n- G1 [approved, must] It greets. | gate: test\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'chore: a spec');
    const [builder, holder, other] = ['web-1', 'web-2', 'web-3'].map((name) => {
      const path = join(dir, name);
      git(repo, 'worktree', 'add', '-q', '--detach', path);
      // Each seat declares its model; the builder's family differs so its peers may review it.
      const joined = fixtureJoin(run, path, 'web', '--model', name === 'web-1' ? 'Builder Model' : 'Test Model', '--route', 'strong');
      assert.match(joined.stdout, new RegExp(`joined as ${name}`), joined.stderr);
      return path;
    });
    const added = fixtureAdd(run, repo, 'web', 'Greet', '--specs', 'G1', '--criterion', 'It greets.');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(run(builder, 'claim', '1').status, 0);
    fs.mkdirSync(join(builder, 'web'));
    fs.writeFileSync(join(builder, 'web', 'greet.txt'), 'hello\n');
    git(builder, 'add', '-A');
    git(builder, 'commit', '-q', '-m', 'feat(web): greet [G1]');
    const commit = git(builder, 'rev-parse', 'HEAD');
    const submitted = run(builder, 'submit', '1');
    assert.equal(submitted.status, 0, submitted.stderr);
    const commonDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    assert.equal(git(holder, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonDir,
      'the verifier worktree reads the builder repo common dir');
    const sharedBoard = new DatabaseSync(join(commonDir, 'pullboard', 'board.sqlite'), { readOnly: true });
    assert.equal(sharedBoard.prepare('PRAGMA user_version').get().user_version, 3,
      'the main repo creates the shared board before the verifier opens it');
    sharedBoard.close();

    const before = Date.now();
    const first = run(holder, 'next', '--verify');
    const after = Date.now();
    assert.equal(first.status, 0, first.stderr);
    const until = /reserved for you until (\S+): another agent's verdict on it is refused until then/.exec(first.stdout)?.[1];
    assert.ok(until, first.stdout);
    const lease = 45 * 60_000;
    assert.ok(Date.parse(until) >= before + lease && Date.parse(until) <= after + lease, `${until} is 45 minutes on, the repo's reviewLease`);
    assert.ok(run(repo, 'show', '1').stdout.includes(`under review by web-2 (Test Model) until ${until}`), 'show names the holder and the time');

    const passed = run(other, 'next', '--verify');
    assert.equal(passed.status, 1, passed.stdout);
    assert.match(passed.stderr, /NOTHING_FREE/);
    assert.ok(passed.stderr.includes(`web-2 (Test Model) holds the review of #1 until ${until}`), passed.stderr);
    git(other, 'switch', '-q', '--detach', commit);
    const refused = run(other, 'verify', '1', 'accept', '--note', 'it greets');
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /REVIEW_HELD/);
    assert.ok(refused.stderr.includes(`web-2 (Test Model) holds the review of #1 until ${until}`), refused.stderr);

    const renewed = run(holder, 'next', '--verify');
    const again = /reserved for you until (\S+):/.exec(renewed.stdout)?.[1];
    assert.ok(again && Date.parse(again) > Date.parse(until), `running next --verify again renews the lease: ${renewed.stdout}${renewed.stderr}`);
    git(holder, 'switch', '-q', '--detach', commit);
    const accepted = run(holder, 'verify', '1', 'accept', '--note', 'checked out the commit; web/greet.txt says hello');
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('next --verify looks outside the lock and rechecks inside it, so no other verifier takes the review in between [V15]', () => {
  const lab = boardOnDisk();
  const others = [];
  try {
    const id = submittedItem(lab.board);
    const third = store.register(lab.board, { lane: 'web', path: '/repo-web-3', family: 'review-vendor' });
    const fourth = store.register(lab.board, { lane: 'web', path: '/repo-web-4', family: 'review-vendor' });
    // A reservation that has already lapsed, so the look has a lease to read the clock for.
    store.reserveReview(lab.board, id, { agentId: fourth, leaseMs: 1, policy: 'any' });
    const rival = openBoard(lab.file);
    rival.db.exec('PRAGMA busy_timeout = 0');
    let armed = false;
    let rivalSaw = null;
    // web-2's own connection. Its clock runs a minute ahead, so the lapsed lease is plainly lapsed,
    // and the first time the look reads it, a rival verifier on another connection reserves the
    // same review. The look holds no write lock (#3156), so the rival's write lands mid-look.
    const looking = openBoard(lab.file, {
      now: () => {
        if (armed && rivalSaw === null) {
          try {
            store.reserveReview(rival, id, { agentId: third, leaseMs: 600_000, policy: 'any' });
            rivalSaw = 'reserved';
          } catch (error) {
            rivalSaw = error;
          }
        }
        return new Date(Date.now() + 60_000);
      },
    });
    others.push(rival, looking);
    armed = true;
    const found = store.reserveNextReview(looking, { agentId: 'web-2', lane: 'web', leaseMs: 60_000, policy: 'any' });
    assert.ok(rivalSaw !== null, 'the look read the clock, so the rival had its chance mid-look');
    assert.equal(rivalSaw, 'reserved', 'the look held no write lock, so the rival reserved mid-look');
    // The in-lock recheck sees the rival's live reservation and refuses: the looker never takes the review.
    assert.notEqual(found.item?.item_id, id, 'the looker did not take the review the rival holds');
    const held = store.getItem(lab.board, id);
    assert.equal(held.item_review_by, third, 'exactly one verifier holds the review: the rival');
  } finally {
    for (const board of others) store.closeBoard(board);
    lab.done();
  }
});

test('the review lease is reviewLease in pullboard.json, 30 minutes unless the repo says otherwise [V15]', () => {
  assertConfiguredReviewLease(loadConfig);
});

test('the lifecycle page and the help show the reservation: reserve, and reviewFree on every verdict [V15, M1]', () => {
  assertLifecycleReservation(machineRules, HELP);
});

test('the two conditional guards behave as declared: a renewal passes a held lane, and only a freeze checks the rows [M1, M2]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const claimAs = (id, agentId, freezer) => outcome(() => store.claim(board, id, { agentId, lane: 'web', leaseMs: 7_200_000, freeze: freezer }));
  assert.match(machineRules.MACHINE.guards.find((guard) => guard.id === 'laneOpen').when, /renewing its own live claim/);
  assert.match(machineRules.MACHINE.guards.find((guard) => guard.id === 'rowsInForce').when, /where the criterion freezes/);

  const mine = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  const theirs = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  assert.equal(claimAs(mine, 'web-1', freeze), 'ok');
  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'pause' });
  assert.equal(claimAs(mine, 'web-1', freeze), 'ok', 'its holder renews a live claim in a held lane');
  assert.equal(claimAs(theirs, 'web-2', freeze), 'LANE_HELD', 'a fresh claim in the held lane is refused');
  store.releaseLane(board, 'web', { agentId: 'coordinator' });

  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a renewal keeps the frozen bar and checks no rows');
  store.release(board, mine, 'web-1', 'Release the fixture claim to check reclaiming the frozen bar.', undefined, 'OTHER');
  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'ok', 'a reclaim keeps the frozen bar too');
  assert.equal(claimAs(theirs, 'web-2', retiredFreeze), 'UNKNOWN_SPEC', 'a first claim freezes, so it checks the rows');
  store.release(board, mine, 'web-1', 'Release the fixture claim before correcting its bar.', undefined, 'OTHER');
  store.editItem(board, mine, { agentId: 'coordinator', criterion: 'A changed bar.', reason: 'the fixture corrects its bar' });
  assert.equal(claimAs(mine, 'web-1', retiredFreeze), 'UNKNOWN_SPEC', 'after an edit drops the bar, the next claim freezes and checks');
  assert.equal(outcome(() => store.refreeze(board, mine, { agentId: 'coordinator', freeze: retiredFreeze })), 'UNKNOWN_SPEC', 'refreeze freezes, so it checks');
});

/**
 * Every place in src/ that could write an item's status outside moveItem, found in the source: an
 * item_status key, quoted or computed from a literal, or any statement that updates or replaces
 * item rows, in either case. This backs up the runtime guard, which refuses such a write on every
 * path a test runs, for the paths no test reaches. Allowed: moveItem; setItem, the generic update
 * moveItem writes through, which the guard watches; and current(), which builds the reader's view
 * of a lapsed claim and never writes; and JSON_SHAPES, whose keys describe output fields.
 *
 * @param {(file: string) => string} read
 * @returns {string[]}
 */
function statusWriters(read) {
  const writers = [];
  const movedFiles = packageFiles(fileURLToPath(new URL('../../../..', import.meta.url)))
    .filter(file => (file.startsWith('packages/items/src/') || file.startsWith('packages/store/src/')) && file.endsWith('.js')).map(file => `../${file}`);
  const others = movedSourceFiles().filter(file => !file.startsWith('packages/items/src/') && !file.startsWith('packages/store/src/')).map(file => `../${file}`);
  // The old src/config.js shim was deleted by the move; its moved body stays scanned beside the other src files.
  const files = [...new Set([...others, '../packages/config/src/io/main.js', '../packages/config/src/logic/json.js', ...movedFiles])];
  for (const file of files) {
    const source = read(file);
    const allowedNames = file === '../packages/store/src/io/board.js' ? ['moveItem'] : file === '../packages/items/src/logic/fields.js' ? ['setItem'] : file === '../packages/store/src/io/board/query.js' ? ['current'] : [];
    const allowed = allowedNames.map((name) => functionsIn(source).get(name));
    const spans = allowed.filter(Boolean).map((body) => [source.indexOf(body), source.indexOf(body) + body.length]);
    if (file === 'json.js' || file === '../packages/config/src/logic/json.js') {
      const catalog = /^export const JSON_SHAPES = \{[\s\S]*?^\};/m.exec(source);
      if (catalog) spans.push([catalog.index, catalog.index + catalog[0].length]);
    }
    for (const match of source.matchAll(/(?:\[\s*)?(['"`]?)item_status\1(?:\s*\])?\s*:|\b(?:update|replace\s+into|insert\s+or\s+replace\s+into)\s+(?:main\.)?item\b/gi)) {
      if (!spans.some(([start, end]) => match.index >= start && match.index < end)) {
        const before = source.slice(0, match.index);
        const owner = [...functionsIn(source).entries()].find(([, body]) => source.indexOf(body) <= match.index && match.index < source.indexOf(body) + body.length);
        writers.push(`${file}#${owner ? owner[0] : `line ${before.split('\n').length}`}`);
      }
    }
  }
  return writers;
}

test('only moveItem writes an item\'s status, and a write anywhere else fails the check [M1]', () => {
  assert.deepEqual(statusWriters(fromDisk), []);
  const besideSetter = editedSource('../packages/items/src/logic/fields.js', /^export function setItem/m,
    "export function reopenByHand(board, id) {\n  board.db.prepare(\"update item set item_status = 'open' where item_id = ?\").run(id);\n}\n\nexport function setItem");
  assert.deepEqual(statusWriters(besideSetter), ['../packages/items/src/logic/fields.js#reopenByHand'], 'the generic setter exemption never covers a writer beside it');
  const besideReader = editedSource('../packages/store/src/io/board/query.js', /^export function current/m,
    "export function reopenByHand(board, id) {\n  board.db.prepare(\"update item set item_status = 'open' where item_id = ?\").run(id);\n}\n\nexport function current");
  assert.deepEqual(statusWriters(besideReader), ['../packages/store/src/io/board/query.js#reopenByHand'], 'the projection exemption never covers a writer beside it');
  assert.match(functionsIn(fromDisk('../packages/store/src/io/board.js')).get('moveItem'), /item_status: move\.to/, 'moveItem is the writer');
  const planted = editedSource('../packages/store/src/logic/board/escalate.js', /set: \(found\) => \(\{ item_route: nextRoute\(found\.item_route\), item_owner: null, item_lease_until: null \}\),/, "set: (found) => ({ item_route: nextRoute(found.item_route), item_status: 'open', item_owner: null, item_lease_until: null }),");
  assert.deepEqual(statusWriters(planted), ['../packages/store/src/logic/board/escalate.js#escalate']);
  const lowercase = editedSource('../packages/store/src/logic/board/attempt.js', /^export function recordAttempt/m, "export function reopenByHand(board, id) {\n  board.db.prepare(\"update item set item_status = 'open' where item_id = ?\").run(id);\n}\n\nexport function recordAttempt");
  assert.deepEqual(statusWriters(lowercase), ['../packages/store/src/logic/board/attempt.js#reopenByHand']);
  const computed = editedSource('../packages/store/src/logic/board/attempt.js', /^export function recordAttempt/m, "export function reopenByKey(board, id) {\n  setItem(board, id, { ['item_status']: 'open' });\n}\n\nexport function recordAttempt");
  assert.deepEqual(statusWriters(computed), ['../packages/store/src/logic/board/attempt.js#reopenByKey']);
  const besideCatalog = editedSource('../packages/config/src/logic/json.js', /^export const JSON_SHAPES =/m, "export function reopenByKey(board, id) {\n  setItem(board, id, { ['item_status']: 'open' });\n}\n\nexport const JSON_SHAPES =");
  assert.deepEqual(statusWriters(besideCatalog), ['../packages/config/src/logic/json.js#reopenByKey'], 'the output catalog exemption never covers a writer beside it');
  const besideShim = editedSource('../packages/config/src/io/main.js', /^export \{/m, "export function reopenByKey(board, id) {\n  setItem(board, id, { ['item_status']: 'open' });\n}\n\nexport {");
  assert.deepEqual(statusWriters(besideShim), ['../packages/config/src/io/main.js#reopenByKey'], 'the moved body of the old config shim stays scanned');
});

test('the board refuses a status written outside moveItem at run time, however it is spelled [M1]', t => {
  const lab = memoryBoardLab(t);
  const { board } = lab;
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
  store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
  const column = ['item', 'status'].join('_');
  for (const sql of ["update item set item_status = 'open' where item_id = ?", `UPDATE item SET ${column} = 'claimed' WHERE item_id = ?`]) {
    assert.throws(() => board.db.prepare(sql).run(id), /STATUS_OUTSIDE_MOVE/, sql);
  }
  assert.throws(
    () => board.db.prepare("REPLACE INTO item (item_id, item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES (?, 'web', 'Page', 'x', 'now', 'now')").run(id),
    /KEPT/,
    'a replace deletes the old row first, and the board keeps items',
  );
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  store.release(board, id, 'web-1', 'Exercise the declared release move after refusing direct status writes.', undefined, 'OTHER');
  assert.equal(store.getItem(board, id).item_status, 'open', 'a move through moveItem still writes');
});

test('a helper added to the board that changes a status outside moveItem is refused when it runs [M1]', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pullboard-planted-'));
  try {
    copyPackageFiles(join(import.meta.dirname, '../../../..'), dir);
    const boardFile = join(dir, 'packages/store/index.js');
    fs.appendFileSync(boardFile, `\nexport function reopenByHand(board, id) {\n  board.db.prepare("update item set item_status = 'open', item_owner = null, item_lease_until = null where item_id = ?").run(id);\n}\n`);
    const copy = await import(pathToFileURL(boardFile).href);
    const copyNative = await import(pathToFileURL(join(dir, 'apps', 'lib', 'index.js')).href);
    const board = copyNative.openBoard(':memory:');
    copy.register(board, { lane: 'coordinator', path: '/repo', family: 'human' });
    copy.register(board, { lane: 'web', path: '/repo-web-1', family: 'builder-vendor' });
    const id = copy.addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    copy.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000, freeze });
    assert.throws(() => copy.reopenByHand(board, id), /STATUS_OUTSIDE_MOVE/);
    assert.equal(copy.getItem(board, id).item_status, 'claimed');
    copy.closeBoard(board);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transport boundaries keep a new item refusal in ordered dispatch visible [M1,M4,H16]', () => {
  const inDispatch = editedSource('../apps/cli/src/io/claim.js', /^(?:export )?async function ordered\(ctx, board, operation, args(?:, \{ prepareInWriter \} = \{\})?\) \{$/m,
    "$&\n  if (args[0] === 999) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inDispatch).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by submit but not declared there',
  ], 'transport authentication is separate but a dispatcher item guard still belongs to the lifecycle');
});

test('bootstrap refusals remain visible on their own operation [M1,M4,H16]', () => {
  const source = editedSource('../packages/store/src/io/baseline/spec/approval.js', /^export function recordSpecApprovalBaseline\(board, \{ agentId, baseline \}\) \{$/m,
    "$&\n  throw new Refused('BOOTSTRAP_PROBE', 'repair the baseline');");
  const walk = codeWalk(source, { caught: true });
  assert.ok(walk.refusalsOf('../packages/store/index.js#recordSpecApprovalBaseline').has('BOOTSTRAP_PROBE'));
  assert.ok(!walk.refusalsOf('../apps/cli/src/io/claim.js#ordered').has('BOOTSTRAP_PROBE'));
});

test('same-file runner controller bridges retain child refusals in the lifecycle audit [M1,M4,C7]', () => {
  assertRunnerControllerReachability({ codeProblems, codeWalk, editedSource, machine: machineRules.MACHINE });
});

test('Rigor historical data boundaries do not hide a new projection refusal [M1,M4]', () => {
  const broken = editedSource('../packages/rigor/src/logic/counter.js', /export function rigorCounterKeys\(event, person\) \{/, "export function rigorCounterKeys(event, person) { if (event.event_kind === 'probe') throw new Refused('RIGOR_PROBE', 'new item eligibility rule');");
  assert.ok(codeProblems(machineRules.MACHINE, broken).includes('RIGOR_PROBE is raised by claim but not declared there'));
});

test('a source walk scans local facts once while retaining caller-specific refusal traversal [C7,M1]', () => {
  assertMachineWalkMemo(codeWalk);
});


test('lifecycle audit follows extracted package guards and catches a new refusal [M1,M4,H16]', () => {
  assertCommitShimRefusals(codeWalk, fromDisk, editedSource, codeProblems, machineRules.MACHINE);
  const file = '../packages/state/src/logic/handoff.js';
  const walk = codeWalk(fromDisk);
  assert.ok(walk.refusalsOf(`${file}#requireHandoffActive`).has('AGENT_REPLACED'));
  const planted = editedSource(file, /^export function requireHandoffActive\(board, actor, operation, args\) \{$/m,
    "$&\n  throw new Refused('STATE_PACKAGE_PROBE', 'planted package guard');");
  assert.ok(codeProblems(machineRules.MACHINE, planted).includes('STATE_PACKAGE_PROBE is raised by submit but not declared there'));
});

/** The exact native guard binding remains audited after the canonical root supplies it. */
test('native landing ports retain guard refusals without trusting unrelated chains [M1,M4]', () => {
  const planted = editedSource('../packages/landing/src/logic/environment.js', /^export function requireVerdict\([^\n]+\) \{$/m,
    "$&\n  throw new Refused('NATIVE_PORT_PROBE', 'planted native guard');");
  const reaches = codeProblems(machineRules.MACHINE, planted);
  assert.ok(reaches.includes('NATIVE_PORT_PROBE is raised by accept and reject but not declared there'), 'the actual bound guard reaches its lifecycle caller');
  const unrelated = file => planted(file).replaceAll('board.nativePorts.landingEnvironment.', 'board.nativePorts.unrelatedLandingEnvironment.');
  assert.ok(!codeProblems(machineRules.MACHINE, unrelated).some(problem => problem.startsWith('NATIVE_PORT_PROBE is raised by ')), 'an unrelated property chain does not inherit the real binding');
});

test('lifecycle source walks follow sync shims and catch a planted body refusal [M1,M4,H16]', () => {
  assertSyncFacadeAudit(codeWalk, fromDisk, editedSource);
});

test('lifecycle source walks follow Git shims and catch a planted body refusal [M1,M4,H16]', () => {
  assertGitFacadeAudit(codeWalk, fromDisk, editedSource);
});

/** The bound storage callback must reach its real body through the moved public facade. */
test('native store setup keeps the exact event-log callback refusal reachable [C7,M1]', () => {
  const entry = '../apps/lib/src/logic/native.js#openBoard';
  assert.ok(codeWalk(fromDisk).refusalsOf(entry).has('EVENT_LOG_VERSION'));
  const planted = editedSource('../packages/store/src/io/board/read/snapshot.js',
    /^export function readEventLogVersion\(db\) \{$/m,
    "$&\n  throw new Refused('STORE_SETUP_PROBE', 'planted event-log guard');");
  assert.ok(codeWalk(planted).refusalsOf(entry).has('STORE_SETUP_PROBE'));
  const beside = editedSource('../packages/store/src/io/board/read/snapshot.js',
    /^export function readEventLogVersion\(db\) \{$/m,
    "export function unrelatedStoreProbe() { throw new Refused('STORE_ADJACENT_PROBE', 'unbound function'); }\n$&");
  assert.ok(!codeWalk(beside).refusalsOf(entry).has('STORE_ADJACENT_PROBE'));
});

test('post-verdict landing catches do not hide verification guards [B35,M1,M4]', () => assertPostVerdictLandingAudit(editedSource, codeProblems, machineRules.MACHINE));
