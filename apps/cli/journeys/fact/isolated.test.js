/** Fixtures never inherit the agent's PULLBOARD environment [C7]. */
import {
  after,
  test,
} from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const FIXTURE_KEYS = ['PULLBOARD_HOME', 'PULLBOARD_INFRA_RETRY_BACKOFF_MS', 'PULLBOARD_MACHINE_HOME', 'PULLBOARD_MODEL', 'PULLBOARD_USAGE_CHECKPOINT'];

test('clause 1: sandbox carries only its own PULLBOARD_ values and the fixed fixture model [C7]', () => {
  const saved = { ...process.env };
  process.env.PULLBOARD_MODEL = 'junk-agent-model';
  process.env.PULLBOARD_HOME = '/junk/agent/home';
  process.env.PULLBOARD_JUNK = 'junk';
  try {
    const box = e2e.sandbox();
    const pullboardKeys = Object.keys(box.env).filter(key => key.startsWith('PULLBOARD_')).sort();
    assert.deepEqual(pullboardKeys, FIXTURE_KEYS);
    assert.equal(box.env.PULLBOARD_MODEL, FIXTURE_MODEL);
    assert.equal(box.env.PULLBOARD_INFRA_RETRY_BACKOFF_MS, '0');
    assert.notEqual(box.env.PULLBOARD_HOME, '/junk/agent/home');
    assert.ok(box.env.PULLBOARD_HOME.startsWith(box.dir));
  } finally {
    for (const key of ['PULLBOARD_MODEL', 'PULLBOARD_HOME', 'PULLBOARD_JUNK']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('clause 2: land batch passes with PULLBOARD_MODEL unset in the parent environment [C7]', { timeout: 320_000 }, () => {
  const env = { ...process.env };
  delete env.PULLBOARD_MODEL;
  const result = spawnSync(process.execPath, ['--test', resolve(import.meta.dirname, '../land/batch/whole.test.js')], {
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
