/** @pullboard-test-input source-cell apps/cli apps/lib apps/runner codemap config doctrine flakes gate git items kernel landing link moves person resources rigor runners seats spec state stats store verify */
/** @pullboard-world-pin: the audit reads the CLI's command files and the packages' source, to find the refusals the code raises. */
/** @pullboard-test-loads packages/store/src/io/board.js */
import { assertPostVerdictLandingAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { NOT_MOVES } from '../../tests/fixtures/machine/moves.js';
import { functionsIn } from '../../../../packages/gate/tests/fixtures/functions.js';
import { MACHINE_CALLBACKS as CALLBACKS } from '../../../../packages/gate/tests/fixtures/functions.js';
import { sourceFacts } from '../../../../packages/gate/tests/fixtures/functions.js';
import { moveOf } from '../../../../packages/gate/tests/fixtures/functions.js';
import { movedSourceFiles } from '../../tests/fixtures/source.js';
import { sourceReader } from '../../../../packages/gate/tests/fixtures/functions.js';
import { sourceDirectories } from '../../../../packages/gate/tests/fixtures/functions.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { assertSyncFacadeAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { assertGitFacadeAudit } from '../../../../packages/gate/tests/fixtures/functions.js';
import { workingSourceInventory } from '../../../../packages/gate/src/io/scan.js';
import { fileURLToPath } from 'node:url';
import { assertCommitShimRefusals } from '../../tests/fixtures/machine/commits.js';
import { machineSourceModule } from '../../tests/fixtures/machine/commits.js';
import { assertMachineWalkMemo } from '../../tests/fixtures/machine/memo.js';
import * as fs from 'node:fs';
import * as machineRules from '../../../../packages/state/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { posix } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { runnerControllerCallees } from '../../tests/fixtures/runner/machine.js';
import { assertRunnerControllerReachability } from '../../tests/fixtures/runner/machine.js';

const SUBMIT_REFUSALS = 'AGENT_APPROVAL_REQUIRED BAD_BUILD_ESTIMATE BOARD_UNAVAILABLE CLAUSE_EVIDENCE_KIND CLAUSE_EVIDENCE_REQUIRED CLAUSE_REASONING_ONLY EMPTY_SUBMIT GIT_SYNC_FOLDER KERNEL_EXPORT_APPROVAL KERNEL_EXPORT_SOURCE MILESTONES_CORRUPT SEAL_REVISION SEAL_STALE SEAL_STORE UNKNOWN_SPEC'.split(' ');
/**
 * Where each move starts in the code. Accept and reject share the board's verify and the CLI's, so
 * they answer for its refusals together.
 */
const ENTRY_POINTS = [
  { verbs: ['claim'], at: ['../packages/store/src/io/board.js#claim'] },
  { verbs: ['release'], at: ['../packages/store/src/io/board.js#release'] },
  // submitHere loads the pulled gate offer lazily, which the walk does not follow, so the offer is its own submit entry [#6807].
  { verbs: ['submit'], at: ['../packages/store/src/io/board.js#submit', '../apps/cli/src/io/commands/submit.js#submitHere', '../apps/cli/src/io/submit/pull.js#offerSubmitGate'] },
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
// The pulled gate runs the doctrine hold through injected runner services (apps/cli/src/io/runner/handoff/services.js), which a static walk cannot follow [#6807].
const INJECTED_GATE_FILES = ['../packages/doctrine/src/io/checks.js'];
// The move tables raise the lease refusals from data the walk does not follow; these files raise them as code, and the audit worker raises STALE_MAIN_RED on withdraw.
const TABLE_RAISER_FILES = ['../packages/store/src/logic/board/landing/lease.js', '../packages/landing/src/io/worker.js', '../packages/landing/src/io/resource.js', '../packages/gate/src/io/main/audit/worker.js'];
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
  '../apps/cli/src/io/submit/pull.js#offerSubmitGate': ['../packages/stats/index.js#checkpointAfterMove', '../packages/stats/src/io/cost/checkpoint.js#checkpointAfterMove'], // A pulled submit's usage checkpoint catches every usage failure as USAGE_PENDING [N2].
  // Machine-verified submit lands after its record, and that landing call is caught like verify's; the same catches as reached at the CLI's moved source (#2886).
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

/** A file's createRequire bindings: the names it loads modules through at the call. */
const loadersIn = (source) => new Set([...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*createRequire\(/g)].map(([, name]) => name));

/**
 * The functions a body calls through a module it requires at the call: `load('./x.js').name(...)`
 * and `const { name } = load('./x.js')` then `name(...)`, where load is the file's createRequire
 * binding. Why: claim's criterion freezer loads the moves package at the call to keep commands fast
 * (#7081, 7dde797e3a); a required module is still a call edge, so every refusal the freezer and the
 * move tables raise stays in the audit.
 *
 * @param {string} file
 * @param {string} body
 * @param {string} source
 * @returns {string[]}
 */
function lazyCallees(file, body, source) {
  const loaders = loadersIn(source);
  if (!loaders.size) return [];
  const load = String.raw`(?:${[...loaders].join('|')})\(\s*(['"])(\.{1,2}\/[^'"]+\.js)\1\s*\)`;
  const under = (specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));
  const callees = [...body.matchAll(new RegExp(String.raw`${load}\.(\w+)\(`, 'g'))].map(([, , specifier, name]) => `${under(specifier)}#${name}`);
  for (const [, names, , specifier] of body.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${load}`, 'g'))) {
    for (const part of names.split(',').map(text => text.trim()).filter(Boolean)) {
      const [original, local = original] = part.split(/\s*:\s*/);
      if (new RegExp(String.raw`(?<![\w.])${local}\(`).test(body)) callees.push(`${under(specifier)}#${original}`);
    }
  }
  return callees;
}

/**
 * A file's exports bound to an on-demand loader, `export const name = onDemand('./x.js', 'name')`,
 * where onDemand's body requires the module: each export to the function it loads. Why: the moves
 * light door hands the board root every table engine this way, loading a table at its first run
 * (#7081), and the walk must reach the engine itself.
 *
 * @param {string} file
 * @param {string} source
 * @param {Map<string, string>} bodies
 * @returns {Map<string, string>}
 */
function onDemandExports(file, source, bodies) {
  const loaders = [...loadersIn(source)];
  const under = (specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));
  return new Map([...source.matchAll(/^export const (\w+) = (\w+)\(\s*(['"])(\.{1,2}\/[^'"]+\.js)\3\s*,\s*(['"])(\w+)\5\s*\);$/gm)]
    .filter(([, , loader]) => loaders.some(name => new RegExp(String.raw`(?<![\w.])${name}\(`).test(bodies.get(loader) ?? '')))
    .map(([, name, , , specifier, , exported]) => [name, `${under(specifier)}#${exported}`]));
}

/**
 * The store runs its move tables through engines the board composition root injects
 * (provideMoveTables); the store cannot import the moves cell, which reads it [C7]. The walk follows
 * the injection: a call through the store's getter reaches the engine the root hands over under
 * that name, read from the root's own call, so a newly injected table is walked with no edit here.
 */
const INJECTED_TABLES = { file: '../packages/store/src/logic/board/landing/lease.js', getter: 'moveTables', root: '../packages/board/index.js', provider: 'provideMoveTables' };

/**
 * The engines a body runs through the injected move tables: `moveTables().name(...)` and
 * `const { name } = moveTables()` then `name(...)`.
 *
 * @param {string} file
 * @param {string} body
 * @param {(file: string) => { named: Map<string, string>, source: string }} load
 * @returns {string[]}
 */
function injectedCallees(file, body, load) {
  const { getter, root, provider } = INJECTED_TABLES;
  if (file !== INJECTED_TABLES.file || !body.includes(`${getter}()`)) return [];
  const { named, source } = load(root);
  const handed = new Set((new RegExp(String.raw`\b${provider}\(\{([^}]*)\}\)`).exec(source)?.[1] ?? '').split(',').map(text => text.trim()).filter(Boolean));
  const called = [...body.matchAll(new RegExp(String.raw`\b${getter}\(\)\.(\w+)\(`, 'g'))].map(([, name]) => name);
  for (const [, names] of body.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${getter}\(\)`, 'g'))) {
    called.push(...names.split(',').map(text => text.trim().split(/\s*:\s*/).at(-1)).filter(name => name && new RegExp(String.raw`(?<![\w.])${name}\(`).test(body)));
  }
  return called.filter(name => handed.has(name)).map(name => named.get(name) ?? `${root}#${name}`);
}

/**
 * A move table names the refusals its rows raise as data (`code: 'X'`), and the table engine
 * raises them; the walk reads thrown codes, so reaching a table's engine also reaches its rows.
 *
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
const tableDataCodes = (file, source) => /\/packages\/moves\/src\/logic\/table\/[\w-]+\.table\.js$/u.test(file)
  ? [...source.matchAll(/\bcode: '([A-Z][A-Z0-9_]*)'/g)].map(([, code]) => code) : [];

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
    // An export bound to an on-demand loader is the function it loads.
    const demanded = !bodies.has(name) && onDemandExports(file, source, bodies).get(name);
    if (demanded) return refusalsOf(demanded, skip, seen);
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
      const codes = new Set([...[...body.matchAll(/new Refused\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g)].map((match) => match[2]), ...(body ? tableDataCodes(file, source) : [])]);
      const callees = [
        ...[...body.matchAll(/(?<!\w)(?<!(?<!\.\.)\.)(\w+)\(/g)].map(([, callee]) => (bodies.has(callee) ? `${file}#${callee}` : named.get(callee) ?? callbacks?.[callee])),
        ...[...body.matchAll(/\b(\w+(?:\.\w+)*)\.(\w+)\(/g)].map(([, space, callee]) => (spaces.has(space) ? `${spaces.get(space)}#${callee}` : callbacks?.[`${space}.${callee}`])),
      ];
      callees.push(...runnerControllerCallees(file, body, source), ...lazyCallees(file, body, source), ...injectedCallees(file, body, load));
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
    '../packages/store/src/io/board.js', ...moveFiles, '../apps/cli/src/io/entry.js', '../packages/spec/src/io/main.js', '../packages/gate/src/io/submit.js', ...RUNNER_ENTRY_FILES, ...INJECTED_GATE_FILES, ...TABLE_RAISER_FILES, ...commandFiles,
  ].flatMap((file) => walk.functions(file).flatMap((name) => [...walk.refusalsOf(`${file}#${name}`)])));
  // A code a move's own entry reaches is raised by the code, whichever file holds the entry (the pulled submit gate's table replay, for one).
  for (const { at } of ENTRY_POINTS) for (const entry of at) for (const code of walk.refusalsOf(entry)) raised.add(code);
  // The lease table names its refusals as data (code: 'X') and the table engine raises them; the walk reads only thrown Refused codes.
  for (const [, code] of read('../packages/moves/src/logic/table/lease.table.js').matchAll(/\bcode: '([A-Z][A-Z0-9_]*)'/g)) raised.add(code);
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
  const setupEntries = [...NON_MOVE_ENTRY_POINTS, ...RUNNER_ENTRY_FILES.flatMap((file) => walk.functions(file).map((name) => `${file}#${name}`))];
  const unraised = Object.keys(NOT_MOVES).filter((code) => !ENTRY_POINTS.some(({ at }) => at.some((entry) => walk.refusalsOf(entry).has(code))) && !setupEntries.some((entry) => walk.refusalsOf(entry).has(code)));
  assert.deepEqual(unraised, [], 'every code listed as not a move is raised by a move or setup code path');
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
    'BAR_EMPTY is raised by claim but not declared there',
    'BAR_EMPTY is raised by refreeze but not declared there',
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

test('post-verdict landing catches do not hide verification guards [B35,M1,M4]', () => assertPostVerdictLandingAudit(editedSource, codeProblems, machineRules.MACHINE, { land: '../apps/cli/src/io/commands/land.js', verify: '../apps/cli/src/io/commands/verify.js' }));


/** Claim's freezer and the move tables load at the call (#7081) and run through engines the board root injects; the walk follows both [C7,M1,M4]. */
test('the walk follows a writer into its move table and the freezer it requires, and finds a planted refusal there [C7,M1,M4]', () => {
  const walk = codeWalk(fromDisk);
  assert.ok(walk.refusalsOf('../apps/cli/src/io/claim.js#freezer').has('UNKNOWN_SPEC'), 'the CLI freezer reaches the moves freezer it requires at the call');
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#claim').has('CLAIM_TABLE_INPUTS'), 'claim reaches the claim table the board root injects');
  assert.ok(walk.refusalsOf('../packages/store/src/io/board.js#release').has('RELEASE_REASON'), 'release reaches the refusals its table names as row data');
  const inFreezer = editedSource('../packages/moves/src/io/freezer.js', /^export function criterionFreezer\(.*$/m,
    "$&\n  if (!root) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inFreezer).sort(), [
    'MOON_PHASE is raised by accept and reject but not declared there',
    'MOON_PHASE is raised by claim but not declared there',
    'MOON_PHASE is raised by refreeze but not declared there',
    'MOON_PHASE is raised by submit but not declared there',
  ], 'claim, refreeze and submit reach the moves freezer; verify reaches it through the freeze check it shares');
  const inEngine = editedSource('../packages/moves/src/logic/table/claim.table.js', /^export function claimEngine\(board\) \{$/m,
    "$&\n  if (!board) throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inEngine), ['MOON_PHASE is raised by claim but not declared there'], 'a refusal the claim table engine throws is audited on claim');
  const inRow = editedSource('../packages/moves/src/logic/table/release.table.js', /code: 'RELEASE_REASON'/, "code: 'MOON_PHASE'");
  assert.deepEqual(codeProblems(machineRules.MACHINE, inRow), ['MOON_PHASE is raised by release but not declared there'], 'a refusal a release table row names is audited on release');
});
