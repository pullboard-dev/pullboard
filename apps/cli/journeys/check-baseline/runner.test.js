/** A check's baseline runs on a registered runner like any gate run, never on the coordinator machine [C7,#2520]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  HOST,
  installSshStandIn,
  shellQuote,
} from '../../tests/fixtures/runner/ssh.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Demand a genuine CLI success before reading its native document. */
function document(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** A check that logs the folder it ran in to an absolute file, then exits with `code`. */
function loggingCheck(log, tag, code) {
  const script = `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tag)} + ' ' + process.cwd() + '\\n'); process.exit(${code});`;
  return `node -e ${shellQuote(script)}`;
}

/** The dispatched worker requests the SSH stand-in recorded. */
function dispatched(requests) {
  return existsSync(requests) ? readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.workerStarted) : [];
}

test('edit --check on a board with a registered runner dispatches the baseline there and starts no local test process [C7]', { timeout: 240_000 }, async () => {
  const box = e2e.project('true');
  const bin = join(box.dir, 'ssh-bin');
  const worker = join(box.dir, 'worker');
  const remoteHome = join(box.dir, 'worker-home');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  const requests = join(box.dir, 'ssh-requests.jsonl');
  for (const folder of [bin, worker, remoteHome, remoteMachineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  box.env.PATH = bin + ':' + box.env.PATH;
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  document(await box.runLocal(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json'));
  document(await box.runLocal(box.repo, 'settings', 'gate.loadAwareDispatch', 'off', '--json'));
  const log = join(box.dir, 'baseline-runs.log');

  const id = document(fixtureAdd(box.run, box.repo, 'web', 'Runner baseline', '--criterion', 'the page is ready',
    '--check', loggingCheck(log, 'added', 0), '--specs', 'G1', '--wait', '--json')).item.item_id;
  const edited = document(await box.runLocal(box.repo, 'edit', String(id), '--check', loggingCheck(log, 'edited', 1), '--wait', '--json'));

  const main = box.git(box.repo, 'rev-parse', 'main');
  assert.equal(edited.item.item_check_baseline.main, main);
  assert.equal(edited.item.item_check_baseline.result, 'red', 'the edited check ran and its red exit was recorded');
  const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' '));
  assert.deepEqual(runs.map(([tag]) => tag), ['added', 'edited'], 'each baseline ran exactly once');
  for (const [tag, cwd] of runs) {
    assert.ok(cwd.startsWith(worker), `the ${tag} baseline ran in the runner's checkout, not on this machine: ${cwd}`);
    assert.doesNotMatch(cwd, /pullboard-check-base-/u, `the ${tag} baseline used no local temporary clone`);
  }
  // The stand-in writes its record as its SSH session closes, which can trail the recorded baseline by a moment.
  await e2e.waitFor(() => dispatched(requests).length > 0, 'the registered runner stand-in recorded its native worker', 30_000); // budget: SSH stand-in record ceiling, not a timing claim.
});
