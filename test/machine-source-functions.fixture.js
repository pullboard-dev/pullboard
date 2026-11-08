import assert from 'node:assert/strict';
import { posix } from 'node:path';
/** A top-level function (including generators), or a top-level arrow function bound to a const. */
const START = /^(?:export )?(?:(?:async )?function\s*\*?\s+(\w+)\(|const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/;

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
  'board-verify.js': { 'board.nativePorts.landingEnvironment.requireVerdict': '../packages/landing/src/core/landing-environment-guards.js#requireVerdict' },
  'board-reopen.js': {
    'board.nativePorts.sealSourceAdvanceReturn': '../packages/sandbox/src/shell/source-advance-origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': '../packages/landing/src/shell/computed-conflict-receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': '../packages/rigor/src/shell/rigor-auto.js#deriveRigorCause',
  },
  'board-record-landing-batch.js': {
    'board.nativePorts.landingEnvironment.requireBatch': '../packages/landing/src/core/landing-environment-guards.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': '../packages/landing/src/core/landing-environment-guards.js#requireRevision',
  },
  'board-finish-landing-batch.js': {
    'board.nativePorts.landingEnvironment.requireTrunk': '../packages/landing/src/core/landing-environment-guards.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': '../packages/landing/src/core/landing-environment-guards.js#requireStoredBatch',
  },
  // Real higher command roots bind runnerExecutionServices; admission snapshots these functions onto the lease.
  'gate-execution.js': {
    'gateLease.executionServices.runners.runOnRunner': 'runners.js#runOnRunner',
    'gateLease.executionServices.runners.runOnRunnerAsync': 'runners.js#runOnRunnerAsync',
  },
  // Explicit item ports preserve these canonical authority and sandbox refusal paths.
  'reopen-authority.js': {
    verdictWithdrawalTarget: '../packages/verify/src/shell/verdict-withdrawal.js#verdictWithdrawalTarget',
    computedConflictProblem: '../packages/landing/src/shell/computed-conflict-receipt.js#computedConflictProblem',
  },
  '../packages/verify/src/shell/reject-clause.js': { deriveRigorCause: '../packages/rigor/src/shell/rigor-auto.js#deriveRigorCause' },
  'board-health.js': {
    normalizedDispatch: '../packages/sentinels/src/shell/dispatch-health.js#normalizedDispatch',
    rejectedWorkReturns: '../packages/sentinels/src/shell/rejected-work-return.js#rejectedWorkReturns',
  },
  'outside-verify.js': { verifyOutsideSandbox: '../packages/sandbox/src/shell/sandbox-verify.js#verifyOutsideSandbox' },
  'item-authors.js': { strictReviewProblem: '../packages/verify/src/shell/review-independence.js#strictReviewProblem' },
  // Native verification ports retain these exact receipt and projection guards.
  '../packages/verify/src/core/proof-cli.js': { proofRunReceipt: '../packages/store/src/shell/proof-receipts.js#proofRunReceipt' },
  '../packages/verify/src/shell/proof-counters.js': {
    appendRigorCounter: '../packages/rigor/src/shell/rigor-counters.js#appendRigorCounter',
    ensureRigorCounters: '../packages/rigor/src/shell/rigor-counters.js#ensureRigorCounters',
  },
  // The native root supplies these setup guards through the physical store's explicit ports.
  'board-store.js': {
    readEventLogVersion: '../packages/store/src/shell/board-read-open.js#readEventLogVersion',
    boardNotWritable: '../packages/store/src/shell/board-access.js#boardNotWritable',
    boardBusyError: '../packages/store/src/shell/board-access.js#boardBusyError',
  },
  'board.js': {
    freeze: 'cli.js#freezer',
    'board.nativePorts.sealSourceAdvanceReturn': '../packages/sandbox/src/shell/source-advance-origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': '../packages/landing/src/shell/computed-conflict-receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': '../packages/rigor/src/shell/rigor-auto.js#deriveRigorCause',
    'board.nativePorts.recordAutomaticRigorDrafts': '../packages/rigor/src/shell/rigor-auto.js#recordAutomaticRigorDrafts',
    'board.nativePorts.newRigorNotices': '../packages/rigor/src/core/rigor-notices.js#newRigorNotices',
    'board.nativePorts.rigorNoticeText': '../packages/rigor/src/core/rigor-notices.js#rigorNoticeText',
    'board.nativePorts.landingEnvironment.requireVerdict': '../packages/landing/src/core/landing-environment-guards.js#requireVerdict',
    'board.nativePorts.landingEnvironment.requireBatch': '../packages/landing/src/core/landing-environment-guards.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': '../packages/landing/src/core/landing-environment-guards.js#requireRevision',
    'board.nativePorts.landingEnvironment.requireTrunk': '../packages/landing/src/core/landing-environment-guards.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': '../packages/landing/src/core/landing-environment-guards.js#requireStoredBatch',
  },
  '../packages/seats/src/core/line-capacity-board.js': {
    nextFor: 'board.js#nextFor',
    reviewerChecks: 'board.js#reviewerChecks',
    reviewReleaseCooldown: 'board.js#reviewReleaseCooldown',
  },
};

/**
 * The source with the text inside template and quoted string literals blanked, so import-looking text inside generated code is never read as a real import.
 * Why: apps/cli builds analysis-job modules in template strings; their import lines named files that do not exist beside the builder [#3758].
 * A string that directly follows `from` or `import` is a real specifier and stays.
 *
 * @param {string} source
 * @returns {string}
 */
export function withoutStringText(source) {
  let out = '';
  const nest = [];
  /** Copy a blanked run of text, keeping its newlines. */
  const blank = (text) => text.replace(/[^\n]/gu, ' ');
  for (let at = 0; at < source.length;) {
    const ch = source[at];
    if (ch === '/' && source[at + 1] === '/') { const end = source.indexOf('\n', at); const stop = end < 0 ? source.length : end; out += source.slice(at, stop); at = stop; continue; }
    if (ch === '/' && source[at + 1] === '*') { const end = source.indexOf('*/', at + 2); const stop = end < 0 ? source.length : end + 2; out += source.slice(at, stop); at = stop; continue; }
    if (ch === '`') {
      out += ch; at += 1;
      for (; at < source.length; ) {
        if (source[at] === '\\') { out += blank(source.slice(at, at + 2)); at += 2; continue; }
        if (source[at] === '`') break;
        if (source[at] === '$' && source[at + 1] === '{') { nest.push(true); out += '${'; at += 2; break; }
        out += blank(source[at]); at += 1;
      }
      if (source[at] === '`') { out += '`'; at += 1; }
      continue;
    }
    if (ch === '}' && nest.length) {
      // Close of a template substitution: resume the template text.
      const resumes = nest.pop(); out += '}'; at += 1;
      if (!resumes) continue;
      for (; at < source.length; ) {
        if (source[at] === '\\') { out += blank(source.slice(at, at + 2)); at += 2; continue; }
        if (source[at] === '`') { out += '`'; at += 1; break; }
        if (source[at] === '$' && source[at + 1] === '{') { nest.push(true); out += '${'; at += 2; break; }
        out += blank(source[at]); at += 1;
      }
      continue;
    }
    if (ch === '{' && nest.length) { nest.push(false); out += ch; at += 1; continue; }
    if (ch === '"' || ch === "'") {
      let end = at + 1;
      while (end < source.length && source[end] !== ch && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      const literal = source.slice(at, end + 1);
      out += /(?:\bfrom|\bimport)\s*$/u.test(out) ? literal : ch + blank(literal.slice(1, -1)) + (source[end] === ch ? ch : '');
      at = end + 1; continue;
    }
    out += ch; at += 1;
  }
  return out;
}

/** Parse actual source bytes and preserve named import/re-export and public star-provider edges. */
export function sourceFacts(source, file) {
  const named = new Map();
  const text = withoutStringText(source);
  // Match the move check's closed shim grammar; mixed implementation modules keep their existing audit semantics.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '').replace(/\s/gu, '');
  const facade = /^(?:export(?:\*|\{[^}]*\})from(?:'[^']*'|"[^"]*");)+$/u.test(code);
  /** Resolve literal relative operands against the actual provider's repository layout. */
  const under = (specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));
  for (const [, kind, names, , specifier] of text.matchAll(/(import|export)\s*\{([^}]*)\}\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\3/g)) {
    if (kind === 'export' && !facade) continue;
    for (const part of names.split(',').map(text => text.trim()).filter(Boolean)) {
      const [original, local = original] = part.split(/\s+as\s+/);
      named.set(local, `${under(specifier)}#${original}`);
    }
  }
  const spaces = new Map([...text.matchAll(/import \* as (\w+) from (['"])(\.{1,2}\/[^'"]+\.js)\2/g)]
    .map(([, space, , specifier]) => [space, under(specifier)]));
  const stars = facade ? [...text.matchAll(/export\s*\*\s*from\s*(['"])(\.{1,2}\/[^'"]+\.js)\1/g)]
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
  assert.ok(codeWalk(fromDisk).refusalsOf('../apps/cli/src/shell/commands/sync.js#run').has('GIT_REPLACE_REFS'));
  const planted = editedSource('../packages/sync/src/shell/sync.js', /^export async function syncGitBoard\(root, board, io, \{ settlePending = false \} = \{\}\) \{$/m,
    "$&\n  throw new Refused('SYNC_PACKAGE_PROBE', 'planted sync body refusal');");
  assert.ok(codeWalk(planted).refusalsOf('../apps/cli/src/shell/commands/sync.js#run').has('SYNC_PACKAGE_PROBE'));
}

/** Enumerate actual shipped runtime source directories, including public cell fronts and nested command providers. */
export function sourceDirectories(files) {
  return [...new Set(files.filter(file => /^(?:src|bin|packages|apps)\//u.test(file) && file.endsWith('.js'))
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

/** Preserve actual Git refusal reachability and detect a newly planted moved-body refusal. */
export function assertGitFacadeAudit(codeWalk, fromDisk, editedSource) {
  const entry = 'git.js#repoInfo';
  assert.ok(codeWalk(fromDisk).refusalsOf(entry).has('NOT_A_REPO'));
  const planted = editedSource('../packages/git/src/shell/git.js', /^export function repoInfo\(cwd, options = \{\}\) \{$/m,
    "$&\n  throw new Refused('GIT_PACKAGE_PROBE', 'planted Git body refusal');");
  assert.ok(codeWalk(planted).refusalsOf(entry).has('GIT_PACKAGE_PROBE'),
    'a Git compatibility shim cannot hide a new refusal in its actual implementation');
}

/** Prove that only the exact caught landing effect is excluded from verification's refusal audit [B35,M1,M4]. */
export function assertPostVerdictLandingAudit(editedSource, codeProblems, machine) {
  const caught = editedSource('../apps/cli/src/shell/commands/land.js', /^export async function landAfterAcceptance\([^\n]+\) \{$/m,
    "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machine, caught), [], 'only the exact call after the committed verdict is caught');
  const uncaught = editedSource('../apps/cli/src/shell/commands/verify.js', /^export async function verifyHere\(ctx, id, \{ second, values \}\) \{$/m,
    "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machine, uncaught), ['MOON_PHASE is raised by accept and reject but not declared there'], 'a real verification refusal remains audited');
}

/** Exact relocated provider identities for the existing caller-specific audit metadata. */
const SOURCE_AUDIT_IDENTITIES = {
  "../packages/link/src/shell/relay.js": "relay.js",
  "../packages/gate/src/shell/gate-execution.js": "gate-execution.js",
  "../packages/gate/src/shell/gate-submit.js": "gate-submit.js",
  "../packages/gate/src/shell/gate.js": "gate.js",
  "../packages/store/src/core/exit-rules-continuation.js": "exit-rules-continuation.js",
  "../packages/store/src/shell/board-access.js": "board-access.js",
  "../packages/store/src/shell/board-health.js": "board-health.js",
  "../packages/store/src/core/board-link-state.js": "board-link-state.js",
  "../packages/store/src/shell/board-query.js": "board-query.js",
  "../packages/store/src/shell/board-read-open.js": "board-read-open.js",
  "../packages/store/src/shell/board.js": "board.js",
  "../packages/store/src/shell/proof-receipts.js": "proof-receipts.js",
  "../packages/store/src/shell/board-store.js": "board-store.js",
  "../packages/store/src/core/board-rigor-auto-source.js": "board-rigor-auto-source.js",
  "../packages/store/src/core/board-rigor-source.js": "board-rigor-source.js",
  "../packages/store/src/core/board-rigor.js": "board-rigor.js",
  "../packages/store/src/shell/board-claim.js": "board-claim.js",
  "../packages/store/src/shell/board-finish-landing-batch.js": "board-finish-landing-batch.js",
  "../packages/store/src/shell/board-next-for.js": "board-next-for.js",
  "../packages/store/src/shell/board-record-landing-batch.js": "board-record-landing-batch.js",
  "../packages/store/src/shell/board-refreeze.js": "board-refreeze.js",
  "../packages/store/src/shell/board-reopen.js": "board-reopen.js",
  "../packages/store/src/shell/board-verify.js": "board-verify.js"
};

/** Compare physical aliases without changing function names or expanding any caught boundary. */
export function auditKey(key) {
  const [file, name] = key.split('#');
  const physical = posix.relative('src', posix.normalize(posix.join('src', file)));
  return `${SOURCE_AUDIT_IDENTITIES[physical] ?? physical}#${name}`;
}
