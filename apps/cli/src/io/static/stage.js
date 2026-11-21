/** The pullboard gate --static mode, in its own module so the gate command stays small [C7,#8318]. */
import { runShell } from '../../../../../packages/gate/heavy.js';
import { analysisChange } from '../../../../../packages/gate/heavy.js';
import { analysisKey } from '../../../../../packages/gate/heavy.js';
import { readAnalysisMemo } from '../../../../../packages/gate/heavy.js';
import { writeAnalysisMemo } from '../../../../../packages/gate/heavy.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { takeResource } from '../../../../../packages/resources/index.js';
import { staticCheckSlots } from '../../../../../packages/config/index.js';
import { staticMemoOn } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { setTimeout as pause } from 'node:timers/promises';
import { HOOK_RUNNER_CLAIM_MS } from '../hook/runner.js';
import { HOOK_RUNNER_ANSWER_MS } from '../hook/runner.js';

/** The rule code the gate reports a red static stage under. */
export const STATIC_RULE = 'STATIC_RED';

/** The `path:line: text` rows a static check prints, plus its `keyless:<path>: <text>` rows (a finding with no line), in output order. */
function findingRows(output) {
  return String(output ?? '').split('\n').map(line => line.trim()).map(line => {
    const keyless = /^keyless:(\S+?): (.+)$/u.exec(line);
    if (keyless) return { rule: STATIC_RULE, file: keyless[1], line: null, text: keyless[2] };
    const keyed = /^(\S+?):(\d+): (.+)$/u.exec(line);
    return keyed ? { rule: STATIC_RULE, file: keyed[1], line: Number(keyed[2]), text: keyed[3] } : null;
  }).filter(Boolean);
}

/**
 * Run the gate's own static stage (the project's configured staticChecks, from accepted main) on this checkout and print
 * each finding with its rule code. Why: about a third of gate runs came back STATIC_RED and cost a full round trip; this
 * is the same command, run locally with no queue slot, before submit.
 *
 * @param {object} io - The CLI output channel.
 * @param {string} root - The item folder or checkout to judge.
 * @param {{ command?: string }} [options] - `command` replaces the configured stage, for a test that needs no project policy.
 * @returns {number} 0 when the stage is green, 1 when any finding stands.
 */
export function runStaticStage(io, root, { command = mainPolicy(root).config.staticChecks?.trim() } = {}) {
  if (!command) throw new Refused('NO_STATIC_STAGE', 'this project configures no static stage', 'pullboard gate to run the whole gate');
  const run = runShell(root, command, { readOnlyGit: true });
  const findings = findingRows(run.output);
  io.result?.({ green: run.isGreen, findings });
  for (const row of findings) io.say(`${row.rule} ${row.file}${row.line === null ? '' : `:${row.line}`}: ${row.text}`);
  if (run.isGreen) io.say('static stage green: the gate will not return STATIC_RED for this tree');
  else if (!findings.length) io.say(`${STATIC_RULE} the static stage failed with no file:line finding:\n${String(run.output).trim().slice(-1500)}`);
  return run.isGreen ? 0 : 1;
}

/** The machine pool name every local static run shares. */
export const STATIC_POOL = 'static-checks';

// Reuse #12570's bounded runner budgets: a free runner gets a short take window and a claimed runner a bounded answer.
const STATIC_RUNNER_POLL_MS = 1_000;

/** Whether this clean, committed static check can be offered to a registered pulled runner. */
function staticRunnerWanted(root) {
  if (runnerDispatchMode() !== 'pull' || !(loadMachineSettings().runners ?? []).length) return false;
  const status = tryGit(root, ['status', '--porcelain', '--untracked-files=normal']);
  return status.status === 0 && !status.stdout && tryGit(root, ['rev-parse', '--verify', 'HEAD']).status === 0;
}

/** Read a static runner receipt only when it proves the exact offered source and accepted main. */
function staticRunnerAnswer(view, { commit, main }) {
  const posted = [...(view?.steps ?? [])].reverse().find(step => step.name === 'receipt');
  if (!posted) return { answered: false, findings: null };
  const outer = posted.payload?.receipt ?? {};
  const gate = outer.gate ?? {};
  const phase = gate.phases?.[0] ?? null;
  if (gate.source !== commit || gate.main !== main || !phase || ![0, 1].includes(phase.status)) return { answered: true, findings: null };
  const findings = findingRows(phase.tail ?? '');
  return { answered: true, findings: { green: outer.status === 0 && gate.green === true && phase.status === 0, rows: findings,
    failure: phase.status !== 0 && !findings.length ? String(phase.tail ?? '').trim().slice(-1500) : '' } };
}

/** Offer the configured static command as one normal pulled job; null means the local command must run. */
async function staticOnRunner(io, root, { command, main, claimMs = HOOK_RUNNER_CLAIM_MS, answerMs = HOOK_RUNNER_ANSWER_MS,
  now = Date.now, wait = pause, offer, read, settle, commit: getCommit } = {}) {
  if (!staticRunnerWanted(root)) return null;
  const ctx = (await import('../context.js')).context(io);
  const policy = mainPolicy(root);
  const acceptedMain = policy.commit;
  const config = policy.config;
  const source = getCommit ? getCommit(root) : tryGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (!source || main && main !== acceptedMain) return null;
  command ??= config.staticChecks?.trim();
  if (!command) return null;
  const pull = await import('../test/pull.js');
  const api = await import('../../../../../packages/api/index.js');
  const contextPorts = await import('../context.js');
  if (!ctx.nativeBoard) ctx.nativeBoard = await (io.loadNativeBoard ?? (await import('../ports/process.js')).loadNativeBoard)();
  const runs = pull.testRunsHolder(ctx);
  const built = await pull.testJobRow(ctx, { item: undefined, commit: source, main: acceptedMain, command, files: [] });
  let offered;
  try {
    offered = offer ? await offer(ctx, built, runs) : (() => {
      const job = runs ? pull.offerTestRow(api.offerJob, { runs }, built.row)
        : contextPorts.withBoard(ctx, board => pull.offerTestRow(api.offerJob, { board }, built.row));
      return { job: job.id, ref: built.ref };
    })();
  } catch (error) {
    try { tryGit(root, ['update-ref', '-d', built.ref]); } catch { /* an unpinned commit is harmless */ }
    io.say?.(`static runner unavailable (${error?.code ?? error?.message}); running the static stage here`);
    return null;
  }
  const started = now();
  let answer = null, claimed = false;
  try {
    while (now() - started < answerMs && (claimed || now() - started < claimMs)) {
      const view = read ? await read(ctx, offered) : runs ? pull.readTestRow({ runs }, offered.job)
        : contextPorts.withBoardRead(ctx, board => pull.readTestRow({ board }, offered.job));
      const posted = staticRunnerAnswer(view, { commit: source, main: acceptedMain });
      if (posted.answered) { answer = posted.findings; break; }
      if (view?.leaseOwner) claimed = true;
      await wait(STATIC_RUNNER_POLL_MS);
    }
  } catch (error) {
    io.say?.(`static runner could not return a receipt (${error?.code ?? error?.message}); running the static stage here`);
  } finally {
    try {
      if (settle) await settle(ctx, offered, { cancel: answer === null });
      else {
        if (answer === null) {
          const { runsPort } = await import('../../../../../packages/store/index.js');
          try { if (runs) runsPort(runs).cancel(offered.job, { reason: 'static stage ran on the host' });
            else contextPorts.withBoard(ctx, board => runsPort(board).cancel(offered.job, { reason: 'static stage ran on the host' })); } catch { /* fallback remains bounded if cancellation is unavailable */ }
        }
        tryGit(root, ['update-ref', '-d', offered.ref]);
      }
    } catch { /* cleanup is best effort; the runner wait is already bounded */ }
  }
  if (answer === null) {
    io.say?.(`no runner ${claimed ? 'answered' : 'took the static job'} within ${Math.round((claimed ? answerMs : claimMs) / 1000)} s; running the static stage here`);
    return null;
  }
  io.result?.({ green: answer.green, findings: answer.rows, runner: true });
  for (const row of answer.rows) io.say(`${row.rule} ${row.file}${row.line === null ? '' : `:${row.line}`}: ${row.text}`);
  if (answer.green) io.say('static stage green: the gate will not return STATIC_RED for this tree');
  else if (!answer.rows.length) io.say(`${STATIC_RULE} the static stage failed with no file:line finding:\n${answer.failure}`);
  return answer.green ? 0 : 1;
}

/**
 * Run the static stage behind a machine-wide admission slot: at most gate.staticSlots (default 2) run at once on this
 * machine, and a further run waits in line. Why: about 14 concurrent runs of ~50 s of full-CPU work drove a Mac to load
 * 104. A waiting run prints `STATIC_WAIT` with its place once per change, and the slot goes back on any exit.
 *
 * @param {object} io - The CLI output channel.
 * @param {string} root - The item folder or checkout to judge.
 * With gate.staticMemo on, a green run is kept for its exact clean tree and main, and a rerun on that tree answers at once.
 *
 * @param {{ command?: string, main?: string, slots?: () => number, run?: Function, memo?: () => boolean, runner?: Function }} [options] - `slots` and `memo` replace machine settings; `run` replaces the host stage and `runner` the bounded runner attempt.
 * @returns {Promise<number>} The stage's exit code.
 */
export async function runStaticStageAdmitted(io, root, { slots = staticCheckSlots, run = runStaticStage, memo = staticMemoOn, runner = staticOnRunner, ...stage } = {}) {
  const key = memo() ? keptStaticKey(root, stage) : null;
  if (key && readAnalysisMemo(key)) {
    io.result?.({ green: true, findings: [], kept: true });
    io.say('static stage green: kept from a green run of this exact clean tree and main (gate.staticMemo); the gate will not return STATIC_RED for this tree');
    return 0;
  }
  let said = '';
  const capacity = slots();
  const lease = await takeResource({
    name: STATIC_POOL, capacity, capacityProvider: slots, scope: 'machine', root, kind: 'static',
    allowIdleCapacityUpdate: true, allowCapacityGrowth: true, allowCapacityShrink: true,
    /** Name why the run waits and where it stands, only when the place changes. */
    onWait(state) {
      if (state.admitted) return;
      const place = Math.max(1, Number(state.position) || 1);
      const line = `STATIC_WAIT static checks run ${slots()} at a time on this machine (${state.holders?.length ?? 0} running); you are number ${place} in line`;
      if (line !== said) io.say(line);
      said = line;
    },
  });
  try {
    const remote = await runner(io, root, stage);
    if (remote !== null) return remote;
    const code = await run(io, root, stage);
    if (code === 0 && key) writeAnalysisMemo(key, { green: true });
    return code;
  } finally { lease.release(); }
}

/**
 * The key a green local static run is kept under: main's commit, HEAD, their change and the static command, the same parts
 * the submit gate keeps its static result under. Null when the tree has any uncommitted or untracked change or git cannot
 * say, so only an exact committed tree is ever answered from memory [C7].
 *
 * @param {string} root - The item folder or checkout to judge.
 * @param {{ command?: string, main?: string }} [stage] - `main` replaces accepted main's commit, for a test with no coordinator checkout.
 * @returns {string | null}
 */
export function keptStaticKey(root, { command, main } = {}) {
  const status = tryGit(root, ['status', '--porcelain', '--untracked-files=normal']);
  const head = tryGit(root, ['rev-parse', 'HEAD']);
  if (status.status !== 0 || status.stdout || head.status !== 0) return null;
  let policy = null;
  if (!main || !command) { try { policy = mainPolicy(root); } catch { return null; } }
  const base = main ?? policy.commit, definition = command ?? policy.config.staticChecks?.trim();
  const change = definition ? analysisChange(root, base, head.stdout) : null;
  return change ? analysisKey(root, { kind: 'local-static', main: base, source: head.stdout, raw: change.raw, definition }) : null;
}
