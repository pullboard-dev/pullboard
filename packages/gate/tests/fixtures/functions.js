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
  '../packages/store/src/io/board/claim.js': { freeze: '../apps/cli/src/io/entry.js#freezer', foreignBlockers: '../packages/store/src/io/board.js#foreignBlockers' },
  '../packages/store/src/io/board/refreeze.js': { freeze: '../apps/cli/src/io/entry.js#freezer' },
  '../packages/store/src/io/board/verify.js': { 'board.nativePorts.landingEnvironment.requireVerdict': '../packages/landing/src/logic/environment.js#requireVerdict' },
  '../packages/store/src/io/board/reopen.js': {
    'board.nativePorts.sealSourceAdvanceReturn': '../packages/sandbox/src/io/source/advance/origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': '../packages/landing/src/io/computed/conflict/receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': '../packages/rigor/src/io/auto.js#deriveRigorCause',
  },
  '../packages/store/src/io/board/record/landing/batch.js': {
    'board.nativePorts.landingEnvironment.requireBatch': '../packages/landing/src/logic/environment.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': '../packages/landing/src/logic/environment.js#requireRevision',
  },
  '../packages/store/src/io/board/batch.js': {
    'board.nativePorts.landingEnvironment.requireTrunk': '../packages/landing/src/logic/environment.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': '../packages/landing/src/logic/environment.js#requireStoredBatch',
  },
  // Real higher command roots bind runnerExecutionServices; admission snapshots these functions onto the lease.
  '../packages/gate/src/io/execution.js': {
    'gateLease.executionServices.runners.runOnRunnerAsync': '../packages/runners/src/io/main.js#runOnRunnerAsync',
  },
  // Explicit item ports preserve these canonical authority and sandbox refusal paths.
  '../packages/items/src/logic/reopen/authority.js': {
    verdictWithdrawalTarget: '../packages/verify/src/io/verdict/withdrawal.js#verdictWithdrawalTarget',
    computedConflictProblem: '../packages/landing/src/io/computed/conflict/receipt.js#computedConflictProblem',
  },
  '../packages/verify/src/io/rejection.js': { deriveRigorCause: '../packages/rigor/src/io/auto.js#deriveRigorCause' },
  '../packages/store/src/io/board/health.js': {
    normalizedDispatch: '../packages/sentinels/src/io/dispatch.js#normalizedDispatch',
    rejectedWorkReturns: '../packages/sentinels/src/io/returns.js#rejectedWorkReturns',
  },
  '../packages/items/src/io/outside/verify.js': { verifyOutsideSandbox: '../packages/sandbox/src/io/verify.js#verifyOutsideSandbox' },
  '../packages/items/src/io/authors.js': { strictReviewProblem: '../packages/verify/src/io/review/independence.js#strictReviewProblem' },
  // Native verification ports retain these exact receipt and projection guards.
  '../packages/verify/src/logic/proof/native.js': { proofRunReceipt: '../packages/store/src/io/receipts.js#proofRunReceipt' },
  '../packages/verify/src/io/proof/counters.js': {
    appendRigorCounter: '../packages/rigor/src/io/counters.js#appendRigorCounter',
    ensureRigorCounters: '../packages/rigor/src/io/counters.js#ensureRigorCounters',
  },
  // The native root supplies these setup guards through the physical store's explicit ports.
  '../packages/store/src/io/board/sqlite.js': {
    readEventLogVersion: '../packages/store/src/io/board/read/snapshot.js#readEventLogVersion',
    boardNotWritable: '../packages/store/src/io/board/access.js#boardNotWritable',
    boardBusyError: '../packages/store/src/io/board/access.js#boardBusyError',
  },
  '../packages/store/src/io/board.js': {
    freeze: '../apps/cli/src/io/entry.js#freezer',
    'board.nativePorts.sealSourceAdvanceReturn': '../packages/sandbox/src/io/source/advance/origin.js#sealSourceAdvanceReturn',
    'board.nativePorts.conflictValue': '../packages/landing/src/io/computed/conflict/receipt.js#conflictValue',
    'board.nativePorts.deriveRigorCause': '../packages/rigor/src/io/auto.js#deriveRigorCause',
    'board.nativePorts.recordAutomaticRigorDrafts': '../packages/rigor/src/io/auto.js#recordAutomaticRigorDrafts',
    'board.nativePorts.newRigorNotices': '../packages/rigor/src/logic/notices.js#newRigorNotices',
    'board.nativePorts.rigorNoticeText': '../packages/rigor/src/logic/notices.js#rigorNoticeText',
    'board.nativePorts.landingEnvironment.requireVerdict': '../packages/landing/src/logic/environment.js#requireVerdict',
    'board.nativePorts.landingEnvironment.requireBatch': '../packages/landing/src/logic/environment.js#requireBatch',
    'board.nativePorts.landingEnvironment.requireRevision': '../packages/landing/src/logic/environment.js#requireRevision',
    'board.nativePorts.landingEnvironment.requireTrunk': '../packages/landing/src/logic/environment.js#requireTrunk',
    'board.nativePorts.landingEnvironment.requireStoredBatch': '../packages/landing/src/logic/environment.js#requireStoredBatch',
  },
  '../packages/seats/src/logic/line/capacity/board.js': {
    nextFor: '../packages/store/src/io/board.js#nextFor',
    reviewerChecks: '../packages/store/src/io/board.js#reviewerChecks',
    reviewReleaseCooldown: '../packages/store/src/io/board.js#reviewReleaseCooldown',
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
    const identity = posix.normalize(`src/${file}`);
    const source = sources.get(identity);
    if (!source) throw new Error(`source identity is outside the closed inventory: ${file}`);
    return source.toString('utf8');
  };
}

/** Keep actual shim/body reachability and unknown-path failures beside the source parser's fixture helpers. */
export function assertSyncFacadeAudit(codeWalk, fromDisk, editedSource) {
  assert.throws(() => fromDisk('../../outside.js'), /outside the closed inventory/u);
  assert.throws(() => fromDisk('unknown-source-file.js'), /outside the closed inventory/u);
  assert.ok(codeWalk(fromDisk).refusalsOf('../apps/cli/src/io/commands/sync.js#run').has('GIT_REPLACE_REFS'));
  const planted = editedSource('../packages/sync/src/io/main.js', /^export async function syncGitBoard\(root, board, io, \{ settlePending = false \} = \{\}\) \{$/m,
    "$&\n  throw new Refused('SYNC_PACKAGE_PROBE', 'planted sync body refusal');");
  assert.ok(codeWalk(planted).refusalsOf('../apps/cli/src/io/commands/sync.js#run').has('SYNC_PACKAGE_PROBE'));
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
  const entry = '../packages/git/src/io/main.js#repoInfo';
  assert.ok(codeWalk(fromDisk).refusalsOf(entry).has('NOT_A_REPO'));
  const planted = editedSource('../packages/git/src/io/main.js', /^export function repoInfo\(cwd, options = \{\}\) \{$/m,
    "$&\n  throw new Refused('GIT_PACKAGE_PROBE', 'planted Git body refusal');");
  assert.ok(codeWalk(planted).refusalsOf(entry).has('GIT_PACKAGE_PROBE'),
    'a Git compatibility shim cannot hide a new refusal in its actual implementation');
}

/**
 * Prove that only the exact caught landing effect is excluded from verification's refusal audit [B35,M1,M4].
 * Why: the audited commands live in the CLI, so the caller names their source paths and this package fixture reaches no app.
 *
 * @param {{ land: string, verify: string }} paths - The land and verify command sources, relative to the audit's source root.
 */
export function assertPostVerdictLandingAudit(editedSource, codeProblems, machine, paths) {
  const caught = editedSource(paths.land, /^export async function landAfterAcceptance\([^\n]+\) \{$/m,
    "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machine, caught), [], 'only the exact call after the committed verdict is caught');
  const uncaught = editedSource(paths.verify, /^export async function verifyHere\(ctx, id, \{ second, values \}\) \{$/m,
    "$&\n  throw new Refused('MOON_PHASE', 'wait for the full moon');");
  assert.deepEqual(codeProblems(machine, uncaught), ['MOON_PHASE is raised by accept and reject but not declared there'], 'a real verification refusal remains audited');
}
