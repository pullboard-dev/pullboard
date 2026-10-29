import assert from 'node:assert/strict';
import { posix } from 'node:path';
/** A top-level function, or a top-level arrow function bound to a const. */
const START = /^(?:export )?(?:(?:async )?function (\w+)\(|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/;

/**
 * Each top-level function's source by name, arrow functions included. A function declaration ends
 * at its closing brace; an arrow function ends where its statement does.
 *
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function functionsIn(source) {
  const bodies = new Map();
  let open = null;
  for (const line of source.split('\n')) {
    if (open) {
      open.lines.push(line);
      if (open.ends(line)) {
        bodies.set(open.name, open.lines.join('\n'));
        open = null;
      }
      continue;
    }
    const start = START.exec(line);
    if (!start) continue;
    const end = line.trimEnd();
    if (start[1] && end.endsWith('}')) bodies.set(start[1], line);
    else if (start[1]) open = { name: start[1], lines: [line], ends: (next) => next === '}' };
    else if (end.endsWith(';')) bodies.set(start[2], line);
    else if (end.endsWith('{')) open = { name: start[2], lines: [line], ends: (next) => next === '};' };
    else open = { name: start[2], lines: [line], ends: (next) => next.trimEnd().endsWith(';') };
  }
  return bodies;
}


/** Board functions handed a function to call, and the one the CLI and the runner hand them. */
export const MACHINE_CALLBACKS = {
  'board-claim.js': { freeze: 'cli.js#freezer', foreignBlockers: 'board.js#foreignBlockers' },
  'board-refreeze.js': { freeze: 'cli.js#freezer' },
  'board-verify.js': { 'board.nativePorts.landingEnvironment.requireVerdict': 'landing-environment-guards.js#requireVerdict' },
  'board-reopen.js': {
    'board.nativePorts.sealSourceAdvanceReturn': 'source-advance-origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': 'computed-conflict-receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': 'rigor-auto.js#deriveRigorCause',
  },
  'board-record-landing-batch.js': {
    'board.nativePorts.landingEnvironment.requireBatch': 'landing-environment-guards.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': 'landing-environment-guards.js#requireRevision',
  },
  'board-finish-landing-batch.js': {
    'board.nativePorts.landingEnvironment.requireTrunk': 'landing-environment-guards.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': 'landing-environment-guards.js#requireStoredBatch',
  },
  // Real higher command roots bind runnerExecutionServices; admission snapshots these functions onto the lease.
  'gate-execution.js': {
    'gateLease.executionServices.runners.runOnRunner': 'runners.js#runOnRunner',
    'gateLease.executionServices.runners.runOnRunnerAsync': 'runners.js#runOnRunnerAsync',
  },
  // Explicit item ports preserve these canonical authority and sandbox refusal paths.
  'reopen-authority.js': {
    verdictWithdrawalTarget: 'verdict-withdrawal.js#verdictWithdrawalTarget',
    computedConflictProblem: 'computed-conflict-receipt.js#computedConflictProblem',
  },
  'reject-clause.js': { deriveRigorCause: 'rigor-auto.js#deriveRigorCause' },
  'board-health.js': {
    normalizedDispatch: 'dispatch-health.js#normalizedDispatch',
    rejectedWorkReturns: 'rejected-work-return.js#rejectedWorkReturns',
  },
  'outside-verify.js': { verifyOutsideSandbox: 'sandbox-verify.js#verifyOutsideSandbox' },
  'item-authors.js': { strictReviewProblem: 'review-independence.js#strictReviewProblem' },
  // Native verification ports retain these exact receipt and projection guards.
  'proof-cli.js': { proofRunReceipt: 'proof-receipts.js#proofRunReceipt' },
  'proof-counters.js': {
    appendRigorCounter: 'rigor-counters.js#appendRigorCounter',
    ensureRigorCounters: 'rigor-counters.js#ensureRigorCounters',
  },
  // The native root supplies these setup guards through the physical store's explicit ports.
  'board-store.js': {
    readEventLogVersion: 'board-read-open.js#readEventLogVersion',
    boardNotWritable: 'board-access.js#boardNotWritable',
    boardBusyError: 'board-access.js#boardBusyError',
  },
  'board.js': {
    freeze: 'cli.js#freezer',
    'board.nativePorts.sealSourceAdvanceReturn': 'source-advance-origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': 'computed-conflict-receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': 'rigor-auto.js#deriveRigorCause',
    'board.nativePorts.recordAutomaticRigorDrafts': 'rigor-auto.js#recordAutomaticRigorDrafts',
    'board.nativePorts.newRigorNotices': 'rigor-notices.js#newRigorNotices',
    'board.nativePorts.rigorNoticeText': 'rigor-notices.js#rigorNoticeText',
    'board.nativePorts.landingEnvironment.requireVerdict': 'landing-environment-guards.js#requireVerdict',
    'board.nativePorts.landingEnvironment.requireBatch': 'landing-environment-guards.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': 'landing-environment-guards.js#requireRevision',
    'board.nativePorts.landingEnvironment.requireTrunk': 'landing-environment-guards.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': 'landing-environment-guards.js#requireStoredBatch',
  },
  'line-capacity-board.js': {
    nextFor: 'board.js#nextFor',
    reviewerChecks: 'board.js#reviewerChecks',
    reviewReleaseCooldown: 'board.js#reviewReleaseCooldown',
  },
};

/** Parse actual source bytes and preserve named import/re-export and public star-provider edges. */
export function sourceFacts(source, file) {
  const named = new Map();
  // Match the move check's closed shim grammar; mixed implementation modules keep their existing audit semantics.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
  const facade = /^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u.test(code);
  /** Resolve literal relative operands against the actual provider's repository layout. */
  const under = (specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));
  for (const [, kind, names, , specifier] of source.matchAll(/(import|export)\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\3/g)) {
    if (kind === 'export' && !facade) continue;
    for (const part of names.split(',').map(text => text.trim()).filter(Boolean)) {
      const [original, local = original] = part.split(/\s+as\s+/);
      named.set(local, `${under(specifier)}#${original}`);
    }
  }
  const spaces = new Map([...source.matchAll(/import \* as (\w+) from (['"])(\.{1,2}\/[^'"]+\.js)\2/g)]
    .map(([, space, , specifier]) => [space, under(specifier)]));
  const stars = facade ? [...source.matchAll(/export\s*\*\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\1/g)]
    .map(([, , specifier]) => under(specifier)) : [];
  return { bodies: functionsIn(source), named, spaces, source, stars };
}

/** Consume only the exact working-source capability; unknown identities never cause another file read. */
export function sourceReader(rows) {
  const sources = new Map(rows.map(({ file, body }) => [file, Buffer.from(body)]));
  return (file) => {
    const identity = posix.normalize(posix.join('src', file));
    const source = sources.get(identity);
    if (!source) throw new Error(`source identity is outside the closed inventory: ${file}`);
    return source.toString('utf8');
  };
}

/** Keep actual shim/body reachability and unknown-path failures beside the source parser's fixture helpers. */
export function assertSyncFacadeAudit(codeWalk, fromDisk, editedSource) {
  assert.throws(() => fromDisk('../../outside.js'), /outside the closed inventory/u);
  assert.throws(() => fromDisk('unknown-source-file.js'), /outside the closed inventory/u);
  assert.ok(codeWalk(fromDisk).refusalsOf('commands/sync.js#run').has('GIT_REPLACE_REFS'));
  const planted = editedSource('../packages/sync/src/shell/sync.js', /^export async function syncGitBoard\(root, board, io, \{ settlePending = false \} = \{\}\) \{$/m,
    "$&\n  throw new Refused('SYNC_PACKAGE_PROBE', 'planted sync body refusal');");
  assert.ok(codeWalk(planted).refusalsOf('commands/sync.js#run').has('SYNC_PACKAGE_PROBE'));
}

/** Enumerate actual shipped runtime source directories, including public cell fronts and nested command providers. */
export function sourceDirectories(files) {
  return [...new Set(files.filter(file => /^(?:src|bin|packages)\//u.test(file) && file.endsWith('.js'))
    .map(file => posix.dirname(file)))].sort();
}

/**
 * The move with this verb.
 *
 * @param {any} machine
 * @param {string} verb
 * @returns {any}
 */
export const moveOf = (machine, verb) => machine.moves.find((move) => move.verb === verb);

/**
 * The refusal codes a move's board-checked guards raise, in the order the declaration checks them.
 *
 * @param {any} machineRules
 * @param {Record<string, string[]>} prechecked
 * @param {string} verb
 * @returns {string[]}
 */
export function declaredBoardOrder(machineRules, prechecked, verb) {
  const move = moveOf(machineRules.MACHINE, verb);
  return machineRules.effectiveGuards(move)
    .filter((id) => !prechecked[verb].includes(id))
    .map((id) => (id === machineRules.IN_STATE ? move.refuse : machineRules.MACHINE.guards.find((guard) => guard.id === id).refuse));
}
