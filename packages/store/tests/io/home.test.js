/** @pullboard-test-input packages/store/src/io/home.js */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncMayAct } from '../../src/io/home.js';
import { cellRepo } from '../fixtures/cell.js';

/** A fresh repository with no relay link (cellRepo), and a pullboard home inside it whose files the test chooses; PULLBOARD_HOME points there until the test ends. */
function machine(t, homeFiles) {
  const repo = cellRepo(t, { real: true }).root;
  // The home sits inside the private fixture folder that cellRepo removes after the test.
  const home = join(repo, 'pullboard-home');
  mkdirSync(home);
  for (const [file, bytes] of Object.entries(homeFiles)) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), bytes);
  }
  const saved = { home: process.env.PULLBOARD_HOME, token: process.env.PULLBOARD_RELAY_TOKEN, key: process.env.PULLBOARD_RELAY_KEY };
  process.env.PULLBOARD_HOME = home;
  delete process.env.PULLBOARD_RELAY_TOKEN;
  delete process.env.PULLBOARD_RELAY_KEY;
  t.after(() => {
    for (const [name, value] of [['PULLBOARD_HOME', saved.home], ['PULLBOARD_RELAY_TOKEN', saved.token], ['PULLBOARD_RELAY_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return repo;
}

/** The files a runner machine keeps in its pullboard home: jobs, runtimes and signing keys, and no relay state. */
const RUNNER_HOME = {
  'runner-jobs/job-1.json': '{}\n',
  'runner-probes/probe.json': '{}\n',
  'runner-runtimes.json': '{}\n',
  'runner-signing-0123.pem': 'key\n',
  'resources.sqlite': '',
  'config.json': '{}\n',
};

test('store.io-home.syncmayact-is-false-for-a-home: syncMayAct is false for a home holding only runner state, so a runner command never loads the sync work [C7,#6085]', t => {
  const repo = machine(t, RUNNER_HOME);
  assert.equal(syncMayAct(repo), false);
});

test('store.io-home.syncmayact-stays-true-for-a-home: syncMayAct stays true for a home with relay machine state, so real relay use keeps its start-up sync [C7,#6085]', t => {
  const repo = machine(t, { ...RUNNER_HOME, 'relay-machine/state.json': '{}\n' });
  assert.equal(syncMayAct(repo), true);
});

test('store.io-home.syncmayact-stays-true-for-a-runner: syncMayAct stays true for a runner home in a repository with a relay link [C7,#6085]', t => {
  const repo = machine(t, RUNNER_HOME);
  writeFileSync(join(repo, '.git', 'pullboard', 'relay.json'), '{}\n');
  assert.equal(syncMayAct(repo), true);
});
