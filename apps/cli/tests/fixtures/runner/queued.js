/** Shared setup for the queued-test-run journeys: a project with one stand-in runner and the seat-shaped CLI calls [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MACHINE_CONTEXT_ENV } from '../../../../../packages/drive/index.js';
import {
  HOST,
  installSshStandIn,
} from './ssh.js';

export { HOST };

export const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";
export const FAILS = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('red case', () => assert.fail('deliberate'));\n";

/** A project (made by the caller's e2e helpers) with one stand-in runner and a green and a red test file on main, merged into the web seat. */
export function runnerProject(e2e) {
  const box = e2e.project('true');
  const bin = join(box.dir, 'runner-bin');
  const worker = join(box.dir, 'runner-worker');
  const home = join(box.dir, 'runner-home');
  const requests = join(box.dir, 'runner-requests.jsonl');
  for (const folder of [bin, worker, home, join(home, '.pullboard')]) mkdirSync(folder, { recursive: true });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  installSshStandIn({ bin, worker, home, machineHome: join(home, '.pullboard'), requests });
  assert.equal(box.run(box.repo, 'runner', 'add', HOST, '--slots', '2', '--browser', '1').code, 0);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const set = box.run(box.repo, 'settings', key, value);
    assert.equal(set.code, 0, `${key} ${value}: ${set.err}`);
  }
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, affectedTests: 'node --test --test-reporter=tap --test-timeout=3000' }, null, 2));
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/green.test.js'), PASSES);
  writeFileSync(join(box.repo, 'test/red.test.js'), FAILS);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one green and one red file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/**
 * Run one CLI command as the seat's agent session at its own prompt, timing it: the agent-shell marker set, and none
 * of the machine-work variables the test runner itself puts in this process's environment.
 */
export function asSeat(box, ...args) {
  return seatRun(box, {}, ...args);
}

/** Run as the seat with only `extra` of the machine variables set; every other one the test runner set is removed. */
export function seatRun(box, extra, ...args) {
  const saved = Object.fromEntries([...MACHINE_CONTEXT_ENV, 'PULLBOARD_CLI_PID', 'CLAUDECODE'].map(name => [name, box.env[name]]));
  for (const name of Object.keys(saved)) delete box.env[name];
  Object.assign(box.env, extra);
  box.env.CLAUDECODE = '1';
  try {
    const started = performance.now();
    const ran = box.run(box.web, ...args);
    return { ...ran, ms: performance.now() - started };
  } finally {
    for (const name of [...Object.keys(saved), ...Object.keys(extra)]) delete box.env[name];
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) box.env[name] = value;
  }
}

/** Run one CLI command as the seat's agent session with extra machine variables set, as machine work starts it. */
export function asSeatInside(box, extra, ...args) {
  return seatRun(box, extra, ...args);
}
