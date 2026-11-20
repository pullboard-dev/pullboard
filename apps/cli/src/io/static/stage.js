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

/**
 * Run the static stage behind a machine-wide admission slot: at most gate.staticSlots (default 2) run at once on this
 * machine, and a further run waits in line. Why: about 14 concurrent runs of ~50 s of full-CPU work drove a Mac to load
 * 104. A waiting run prints `STATIC_WAIT` with its place once per change, and the slot goes back on any exit.
 *
 * @param {object} io - The CLI output channel.
 * @param {string} root - The item folder or checkout to judge.
 * With gate.staticMemo on, a green run is kept for its exact clean tree and main, and a rerun on that tree answers at once.
 *
 * @param {{ command?: string, main?: string, slots?: () => number, run?: Function, memo?: () => boolean }} [options] - `slots` and `memo` replace the machine settings; `run` replaces the stage.
 * @returns {Promise<number>} The stage's exit code.
 */
export async function runStaticStageAdmitted(io, root, { slots = staticCheckSlots, run = runStaticStage, memo = staticMemoOn, ...stage } = {}) {
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
