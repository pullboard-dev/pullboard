/** The pullboard gate --static mode, in its own module so the gate command stays small [C7,#8318]. */
import { runShell } from '../../../../../packages/gate/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';

/** The rule code the gate reports a red static stage under. */
export const STATIC_RULE = 'STATIC_RED';

/** The `path:line: text` rows a static check prints, one per finding. */
function findingRows(output) {
  return String(output ?? '').split('\n').map(line => /^(\S+?):(\d+): (.+)$/u.exec(line.trim())).filter(Boolean)
    .map(match => ({ rule: STATIC_RULE, file: match[1], line: Number(match[2]), text: match[3] }));
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
  for (const row of findings) io.say(`${row.rule} ${row.file}:${row.line}: ${row.text}`);
  if (run.isGreen) io.say('static stage green: the gate will not return STATIC_RED for this tree');
  else if (!findings.length) io.say(`${STATIC_RULE} the static stage failed with no file:line finding:\n${String(run.output).trim().slice(-1500)}`);
  return run.isGreen ? 0 : 1;
}
