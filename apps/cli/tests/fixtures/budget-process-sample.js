/** Give independently loaded normal CLI renderers one immutable process observation for a paired output measurement [C7,N26]. */
import { createHash } from 'node:crypto';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { setProcessSamplePort } from '../../../../packages/resources/index.js';
import {
  privateFixtureFiles,
  runFixtureChildAsync,
} from './child.js';

/** Preserve the existing measured-command child limit; it is not a size allowance. */
export const BUDGET_COMMAND_KILL_MS = 20_000;

/** Bind bytes to their digest; a sample string and its identity cannot change halfway through the pair. */
export function processObservation(text) {
  if (typeof text !== 'string') throw new TypeError('a process observation must be text');
  return Object.freeze({ text, sha256: createHash('sha256').update(text).digest('hex') });
}

/** Capture the real producer's ps input once, without logging command lines or inventing an empty successful observation. */
export async function observeProcesses() {
  const result = await runFixtureChildAsync('/bin/ps', ['-axo', 'pcpu=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 || result.signal) throw new Error(`process observation unavailable: status ${result.status}, signal ${result.signal ?? 'none'}`);
  return processObservation(result.stdout);
}

/**
 * Run the ordinary agents command against this version's own Resources and Seats modules. The working version retains
 * its normal in-process command path; a comparison version uses Node's ordinary preload to supply the same observation
 * through its own supported sample port. No runtime module or CLI output is substituted. Private sample files are removed
 * on every terminal path and never enter a receipt or a public environment option [C7].
 */
export async function renderAgents(box, bin, observation, { inProcess = null } = {}) {
  if (!Object.isFrozen(observation) || observation.sha256 !== createHash('sha256').update(observation.text).digest('hex')) throw new Error('process observation changed');
  if (inProcess) {
    const restore = setProcessSamplePort({ ps: () => observation.text });
    try { return await inProcess(box.repo, 'agents'); }
    finally { restore(); }
  }
  const root = privateFixtureFiles('pullboard-budget-process-sample-').root;
  const sample = join(root, 'observation.txt'), preload = join(root, 'sample.mjs');
  try {
    writeFileSync(sample, observation.text, { flag: 'wx', mode: 0o600 });
    const resources = pathToFileURL(resolve(dirname(bin), '../..', 'packages/resources/index.js')).href;
    writeFileSync(preload, `import { readFileSync } from 'node:fs';\nimport { setProcessSamplePort } from ${JSON.stringify(resources)};\nconst text = readFileSync(${JSON.stringify(sample)}, 'utf8');\nsetProcessSamplePort({ ps: () => text });\n`, { flag: 'wx', mode: 0o600 });
    const pending = runFixtureChildAsync(process.execPath, ['--import', preload, bin, 'agents'], { cwd: box.repo, env: box.env });
    const timer = setTimeout(() => pending.child.kill('SIGKILL'), BUDGET_COMMAND_KILL_MS);
    try { return await pending; }
    finally { clearTimeout(timer); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
