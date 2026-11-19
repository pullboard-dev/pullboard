/** The runner job runs the real hand-off stages from its ticket, with every stage line in the runner's own log [C7]. */
import { environmentAdapter } from '../../../../packages/env/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';

const disk = fileSystemAdapter();
import { spawn } from 'node:child_process';
import { runnerGit } from './private/privacy.js';
import { performance } from 'node:perf_hooks';

/** The hand-off stages in the order the local worker runs them: its refusals come in this order. */
export const HANDOFF_STAGES = Object.freeze(['authorization', 'doctrine', 'cells', 'composition', 'criterion', 'proof']);

/** A refusal carrying the rule code the local worker would record for the same red. */
function refusal(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

/** Read Git's trimmed stdout in the runner checkout; empty when the command fails, so a caller compares rather than parses an error. */
function gitOut(root, args) { return runnerGit(args, { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? ''; }

/**
 * Authorization and source: the runner checkout is exactly the ticket's commit and tree, and the pinned main is
 * contained in no unreadable state. Why first: every later stage reads this checkout, so a wrong source ends the job
 * before any proof can be taken for the candidate.
 *
 * @param {string} root - The runner's checkout.
 * @param {{ commit: string, tree?: string, main?: string }} input - The ticket's source.
 * @returns {Promise<void>}
 */
async function authorize(root, input) {
  const read = args => gitOut(root, args);
  if (read(['rev-parse', 'HEAD']) !== input.commit) throw refusal('RUNNER_SOURCE', 'the runner checkout is not the ticket commit; resubmit the captured source');
  if (input.tree && read(['rev-parse', 'HEAD^{tree}']) !== input.tree) throw refusal('RUNNER_SOURCE', 'the runner checkout tree is not the ticket tree; resubmit the captured source');
  if (input.main && runnerGit(['cat-file', '-e', `${input.main}^{commit}`], { cwd: root }).status !== 0) {
    throw refusal('RUNNER_SOURCE', `the runner checkout lacks the ticket's main ${input.main.slice(0, 12)}; resubmit so it ships main`);
  }
}

/**
 * Doctrine: the same hold the local worker takes, from accepted main's rules at this exact commit.
 *
 * @param {string} root
 * @param {object} input - The ticket: main, commit, practice, timeoutMs.
 * @param {(line: string) => void} log
 */
async function doctrine(root, input, log, services) {
  const { holdDoctrineAsync, ruleLine } = services.doctrine;
  const rules = await holdDoctrineAsync(root, { mainCommit: input.main, commit: input.commit, practice: input.practice, timeoutMs: input.timeoutMs });
  for (const rule of rules ?? []) log(`  doctrine: ${ruleLine(rule)}`);
}

/**
 * Cells: the submit cells check of accepted main against this commit, the inventory as the producing item (#2711)
 * provides it, with the board's cut rows carried in the ticket because the runner reads no board.
 */
async function cells(root, input, log, services) {
  const { requireSubmitCells, gate, landing } = services.cells;
  const result = await requireSubmitCells(root, input.main, input.commit,
    { item_frozen: JSON.stringify({ criterion: input.criterion ?? '' }), item_title: input.title ?? '' }, {
      withMainCheckout: landing.withMainCheckout, parsers: { importsIn: gate.importsIn, commonJsIn: gate.commonJsIn },
      withImportParseCache: gate.withImportParseCache, cacheEligible: () => !gate.foreignNodeOptions(environmentAdapter().get('NODE_OPTIONS')),
      collectMachinery: true, readCutItems: () => input.cutRows ?? [],
      onInventory: (mode, cause) => log(`  submit cells inventory: ${mode}${cause ? `: ${cause}` : ''}`),
      onAllCells: file => log(`  submit cells: checking all cells because shared policy or root-tool file changed: ${file}`) });
  for (const line of result?.warnings ?? []) log(`  ${line}`);
}

/**
 * Recompute a submit composition in the runner checkout and refuse COMPOSITION_MISMATCH when its tree is not the one the submit sent.
 * The composition is a pure function of main and head, so the runner needs neither the composed object nor the builder's word: it
 * runs `git merge-tree --write-tree` on the two commits it already holds and compares tree ids. A conflict or a missing object
 * yields no equal tree, so it refuses too.
 *
 * @param {string} root - The runner's checkout.
 * @param {{ main: string, head: string, tree: string }} triple - The submit's main, builder head and composed tree.
 * @returns {string} The composed tree id.
 * @throws {Error} COMPOSITION_MISMATCH, naming both tree ids.
 */
export function requireComposedTree(root, { main, head, tree }) {
  const id = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const run = id.test(main) && id.test(head) ? runnerGit(['--no-replace-objects', 'merge-tree', '--write-tree', '--no-messages', main, head], { cwd: root, encoding: 'utf8' }) : null;
  // A conflicted merge-tree still prints a tree id but exits non-zero: only a clean exit is a composition.
  const composed = run?.status === 0 ? (run.stdout ?? '').split('\n')[0].trim() : '';
  // A triple with no tree is a submit that left composing to the runner (submit.composeOnRunner): any clean composition is the tree to prove.
  if (composed && (!tree || composed === tree)) return composed;
  throw refusal('COMPOSITION_MISMATCH', tree
    ? `the submit composed main ${String(main).slice(0, 12)} with head ${String(head).slice(0, 12)} as tree ${tree}, but the runner composes tree ${composed || 'none (Git could not compose them here)'}; run pullboard submit again, and if it repeats report both tree ids to the coordinator (a merge driver or Git version difference)`
    : `the runner could not compose main ${String(main).slice(0, 12)} with head ${String(head).slice(0, 12)} (they conflict); merge main into the item branch, fix the conflict, and submit again`);
}

/**
 * Regenerate the declared generated files the composed tree makes stale, then leave the regenerated tree checked out so every later stage proves it
 * (submit.composeOnRunner with submit.regenerateDeclared). Why here: the command no longer regenerates when the runner composes, so this is the one place a stale generated file is caught.
 * A failed generator is a GENERATED_STALE red with its message, never a silent pass.
 *
 * @param {string} root - The runner's checkout.
 * @param {{ main: string, compositionTriple: { main: string, head: string }, generated?: object[], item?: number }} input - The ticket.
 * @param {string} composed - The composed tree id requireComposedTree accepted.
 * @param {{ regenerate: { regenerateDeclaredFiles: Function } }} services
 * @param {(line: string) => void} log
 */
function regenerateComposed(root, input, composed, services, log) {
  const { main, head } = input.compositionTriple;
  // The runner has no author of its own, so the two commits made here (the composition and the regeneration) carry a fixed one when the machine sets none.
  const identity = { GIT_AUTHOR_NAME: 'Pullboard runner', GIT_AUTHOR_EMAIL: 'runner@pullboard.invalid', GIT_COMMITTER_NAME: 'Pullboard runner', GIT_COMMITTER_EMAIL: 'runner@pullboard.invalid' };
  const environment = environmentAdapter();
  const saved = Object.fromEntries(Object.keys(identity).map(key => [key, environment.get(key)]));
  for (const [key, value] of Object.entries(identity)) if (environment.get(key) === undefined) environment.set(key, value);
  try {
    const made = runnerGit(['commit-tree', composed, '-p', main, '-p', head, '-m', 'composition'], { cwd: root, encoding: 'utf8' });
    const commit = made.status === 0 ? made.stdout.trim() : '';
    if (!commit || runnerGit(['checkout', '-q', '--detach', commit], { cwd: root }).status !== 0) {
      throw refusal('GENERATED_STALE', `the runner could not check out the composed tree to regenerate its declared generated files: ${String(made.stderr).trim() || 'checkout failed'}; submit again`);
    }
    try {
      services.regenerate.regenerateDeclaredFiles(root, { submit: { regenerateDeclared: true }, generated: input.generated ?? [] }, { base: main, item: input.item ?? null });
    } catch (error) {
      throw refusal('GENERATED_STALE', String(error.message));
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) environment.delete(key); else environment.set(key, value); }
  }
  input.regeneratedTree = gitOut(root, ['rev-parse', 'HEAD^{tree}']);
  log(`  composed tree ${composed} regenerated as ${input.regeneratedTree}`);
}

/**
 * Composition: the candidate contains the pinned trunk and proves that same snapshot, when the item requires it. The
 * ticket's claim base rides along as the parent base, so a head already in main's history composes on its parent (#9445).
 */
async function composition(root, input, log, services) {
  // A submit that composed main as an object (submit.composeAsObject) sends {main, head, tree}: the runner recomputes the tree itself [U159].
  if (input.compositionTriple) {
    const composed = requireComposedTree(root, input.compositionTriple);
    if (input.regenerateDeclared === true && services.regenerate) regenerateComposed(root, input, composed, services, log);
    return;
  }
  if (!input.composition) return;
  services.composition.requireSubmitComposition(root, input.composition, { commit: input.trunk ?? input.main }, input.main, input.base ?? null);
}

/** The runner's bounded-shell entry: every stage command runs under its process custody, never a bare /bin/sh [C7,E27]. */
const TIMED_SHELL = fileURLToPath(new URL('./shell.js', import.meta.url));

/** A stage's wall-clock bound when its ticket names none. */
const STAGE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Run a shell command in the checkout through the runner's timed shell entry and return its output, each line also sent
 * to the runner log once the stage ends. Why the entry: it drains the command's descendants on timeout or exit, so a
 * stage cannot leave processes holding the runner slot.
 *
 * @param {string} root
 * @param {string} command
 * @param {(line: string) => void} log
 * @param {string} scratch - The runner's own private folder (the log's folder), where the worker's output spool lives for the stage.
 * @param {number} [timeoutMs] - The stage's wall-clock bound.
 * @returns {Promise<{ status: number | null, output: string }>}
 */
function shell(root, command, log, scratch, timeoutMs = STAGE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const directory = disk.mkdtemp(join(scratch, 'stage-'));
    const outputFile = join(directory, 'output.log');
    const child = spawn(process.execPath, [TIMED_SHELL], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let result = '';
    /** End the stage: the worker's own output file is the stage output, and its directory is removed either way. */
    const finish = (status, extra = '') => {
      let output = '';
      try { output = disk.readFile(outputFile, 'utf8'); } catch { /* a worker that never started leaves no output */ }
      disk.rm(directory, { recursive: true, force: true });
      for (const line of output.split(/\r?\n/u).filter(Boolean)) log(`  ${line}`);
      resolve({ status, output: output + extra });
    };
    child.stdout.on('data', chunk => { result += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => log(`  ${chunk.toString('utf8').trim()}`));
    child.on('error', error => finish(null, error.message));
    child.on('close', status => {
      let outcome = null;
      try { outcome = JSON.parse(result); } catch { /* an unreadable result is the worker's failure */ }
      if (status !== 0 || !outcome) return finish(null, `\ntimed shell failed (exit ${status})`);
      return finish(outcome.timedOut || outcome.overflow || outcome.error ? outcome.status ?? 1 : outcome.status);
    });
    child.stdin.end(JSON.stringify({ command, timeoutMs, outputFile }));
  });
}

/**
 * The failure account of a red run, read as the local worker reads it: each failing top-level case with its file and
 * its signature, so a reader of the recorded result sees the same rows wherever the stage ran [C7].
 *
 * @param {string} output - The red command's output.
 * @param {string} root
 * @param {object} services - The shared readers: tapTests and failureSignatures.
 * @returns {Promise<{ file: string, case: string, signature: string | null }[]>}
 */
export async function failureAccount(output, root, services) {
  const { tapTests, failureSignatures } = services.failures;
  const cases = tapTests(output, root)
    .filter(row => !row.passed && row.type !== 'suite' && row.indent === 0 && row.file && row.name && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType));
  let signed = null;
  try {
    signed = failureSignatures({ output, isGreen: false, executionRoot: root, stages: [{ status: 1, output }] }, root, { raw: true });
  } catch { /* an unreadable account leaves signatures null, as the local worker records it */ }
  return cases.map((row, index) => ({ file: row.file, case: row.name,
    signature: signed && signed.length === cases.length && signed[index].name === row.name ? signed[index].signature : null }));
}

/**
 * The frozen item check and the proof run: the command the ticket names for the stage, run in the checkout. A red
 * ends the job with the failing cases, file and signature.
 */
function commandStage(name) {
  return async (root, input, log, services, scratch) => {
    const command = name === 'proof' ? input.proofCommand ?? input.commands?.proof : input.check ?? input.commands?.criterion;
    if (!command) return;
    const run = await shell(root, command, log, scratch, input.timeoutMs);
    if (run.status === 0) return;
    throw refusal(name === 'proof' ? 'TEST_FAILURE' : 'GATE_RED', `${name} exited ${run.status ?? 'without a status'}`,
      { failures: await failureAccount(run.output, root, services) });
  };
}

/** The default stage for a name. */
function defaultStage(name) {
  return { authorization: authorize, doctrine, cells, composition, criterion: commandStage('criterion'), proof: commandStage('proof') }[name];
}

/**
 * Run the stages in order on the runner and stop at the first red. Each stage line (start, end, duration) goes to the
 * runner's log file only; the returned result holds names, timings and the failure account, never a log line.
 *
 * @param {string} root - The runner's checkout of the ticket commit.
 * @param {{ job: string, commit: string, tree?: string, main?: string, check?: string, proofCommand?: string }} input - The ticket.
 * @param {{ logFile: string, services: object, stages?: object, now?: () => number }} ports - The runner's log, the shared stage services (doctrine, cells, composition and failure readers; see runner-handoff-services.js) and optional stage overrides.
 * @returns {Promise<{ job: string, commit: string, green: boolean, stages: { name: string, ms: number, state: string }[], failed?: { stage: string, code: string, message: string, failures: object[] } }>}
 */
export async function runHandoffStages(root, input, { logFile, services, stages = {}, now = () => performance.now() }) {
  const log = line => disk.appendFile(logFile, `${new Date().toISOString()} handoff ${input.job} ${line}\n`, { mode: 0o600 });
  const done = [];
  for (const name of HANDOFF_STAGES) {
    const started = now();
    log(`stage ${name} start`);
    try {
      await (stages[name] ?? defaultStage(name))(root, input, log, services, dirname(logFile));
    } catch (error) {
      const ms = Math.round(now() - started);
      log(`stage ${name} red ${ms}ms ${error.message}`);
      done.push({ name, ms, state: 'red' });
      return { job: input.job, commit: input.commit, green: false, stages: done,
        failed: { stage: name, code: error.code ?? 'GATE_RED', message: String(error.message), failures: error.failures ?? [] } };
    }
    const ms = Math.round(now() - started);
    log(`stage ${name} ok ${ms}ms`);
    done.push({ name, ms, state: 'ok' });
  }
  return { job: input.job, commit: input.commit, green: true, stages: done, ...(input.regeneratedTree ? { tree: input.regeneratedTree } : {}) };
}
