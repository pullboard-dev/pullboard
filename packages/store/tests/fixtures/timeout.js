/** Exercise landing timeout custody and cadence against a private real board [E27,E29]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { landingLeaseState } from '../../index.js';

/** A configured timeout must stop the gate and its detached child before releasing the trunk. */
export function landingTimeoutFixture({ landProject, itemWorktree, submitItem, acceptItem, onBoard, json }) {
  const box = landProject();
  const armed = join(box.dir, 'timeout-armed');
  const identities = join(box.dir, 'timeout-processes.json');
  const gate = join(box.dir, 'timeout-gate.cjs');
  writeFileSync(gate, [
    "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
    `if (!fs.existsSync(${JSON.stringify(armed)})) { console.log('TAP version 13\\nok 1 - fixture gate\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0'); process.exit(0); }`,
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { detached: true, stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(identities)}, JSON.stringify([process.pid, child.pid]));`,
    "setTimeout(() => { console.log('TAP version 13\\nok 1 - fixture gate\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0'); }, 6000);",
  ].join('\n'));
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.gate = `node '${gate.replaceAll("'", "'\\''")}'`;
  config.landing = { ...config.landing, manualOverride: true, timeout: '2s', cadence: '1m' };
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure timed landing');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  writeFileSync(armed, 'armed');
  const result = json(box, box.repo, 'land');
  assert.ok(existsSync(identities), 'the real stand-in gate started');
  assert.equal(result.batch.gateResults.at(-1).timedOut, true, 'the 2s budget records a timed-out red');
  assert.equal(result.batch.state, 'blocked');
  assert.deepEqual(result.culprits, [], 'timeout does not accuse the candidate');
  for (const pid of JSON.parse(readFileSync(identities, 'utf8'))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `owned gate process ${pid} is gone`);
  }
  assert.equal(onBoard(box, board => landingLeaseState(board).holder), null, 'cleanup precedes trunk release');
  const deferred = json(box, box.repo, 'land');
  assert.equal(deferred.batch, null);
  assert.ok(Date.parse(deferred.deferredUntil) > Date.now(), 'cadence gives the next admission time');
  assert.equal(onBoard(box, board => landingLeaseState(board).holder), null, 'cadence never holds the lease');
}
