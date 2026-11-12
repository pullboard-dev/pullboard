/** The runner job runs the real hand-off stages from its ticket, with every stage line in the runner's own log [C7]. */
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/** The hand-off stages in the order the local worker runs them: its refusals come in this order. */
export const HANDOFF_STAGES = Object.freeze(['authorization', 'doctrine', 'cells', 'composition', 'criterion', 'proof']);

/** A refusal carrying the rule code the local worker would record for the same red. */
function refusal(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

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
  const read = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout?.trim();
  if (read(['rev-parse', 'HEAD']) !== input.commit) throw refusal('RUNNER_SOURCE', 'the runner checkout is not the ticket commit; resubmit the captured source');
  if (input.tree && read(['rev-parse', 'HEAD^{tree}']) !== input.tree) throw refusal('RUNNER_SOURCE', 'the runner checkout tree is not the ticket tree; resubmit the captured source');
  if (input.main && spawnSync('git', ['cat-file', '-e', `${input.main}^{commit}`], { cwd: root }).status !== 0) {
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
      withImportParseCache: gate.withImportParseCache, cacheEligible: () => !gate.foreignNodeOptions(process.env.NODE_OPTIONS),
      collectMachinery: true, readCutItems: () => input.cutRows ?? [],
      onInventory: (mode, cause) => log(`  submit cells inventory: ${mode}${cause ? `: ${cause}` : ''}`),
      onAllCells: file => log(`  submit cells: checking all cells because shared policy or root-tool file changed: ${file}`) });
  for (const line of result?.warnings ?? []) log(`  ${line}`);
}

/** Composition: the candidate contains the pinned trunk and proves that same snapshot, when the item requires it. */
async function composition(root, input, log, services) {
  if (!input.composition) return;
  services.composition.requireSubmitComposition(root, input.composition, { commit: input.trunk ?? input.main }, input.main);
}

/**
 * Run a shell command in the checkout, streaming its lines to the runner log, and return its output.
 *
 * @param {string} root
 * @param {string} command
 * @param {(line: string) => void} log
 * @returns {Promise<{ status: number | null, output: string }>}
 */
function shell(root, command, log) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: root });
    let output = '';
    const take = chunk => { const text = chunk.toString('utf8'); output += text; for (const line of text.split(/\r?\n/u).filter(Boolean)) log(`  ${line}`); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', error => resolve({ status: null, output: output + error.message }));
    child.on('close', status => resolve({ status, output }));
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
  return async (root, input, log, services) => {
    const command = name === 'proof' ? input.proofCommand ?? input.commands?.proof : input.check ?? input.commands?.criterion;
    if (!command) return;
    const run = await shell(root, command, log);
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
  const log = line => appendFileSync(logFile, `${new Date().toISOString()} handoff ${input.job} ${line}\n`, { mode: 0o600 });
  const done = [];
  for (const name of HANDOFF_STAGES) {
    const started = now();
    log(`stage ${name} start`);
    try {
      await (stages[name] ?? defaultStage(name))(root, input, log, services);
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
  return { job: input.job, commit: input.commit, green: true, stages: done };
}
