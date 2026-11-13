/** Fixture test files and a private core pool for the file-admission tests [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';
import { TEST_FILE_CORES_ENV } from '../../index.js';
import { TEST_FILE_POOL_ENV } from '../../index.js';

/** A fixture test file that logs when its body starts and ends, holding its token for `ms`. */
export function timedFile(name, ms, body = '') {
  return `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
const mark = at => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ run: process.env.FIXTURE_RUN, file: ${JSON.stringify(name)}, at, t: Date.now() }) + '\\n');
test(${JSON.stringify(name)}, async () => {
  mark('start');
  ${body}
  await new Promise(done => setTimeout(done, ${ms}));
  mark('end');
});
`;
}

/** A Git fixture repository with its own machine home, and an environment whose pool has `cores` tokens. */
export function fixture(t, cores) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-file-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(runFixtureChild('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // The runner reads its policy from the checkout's committed HEAD, so the fixture needs one commit.
  runFixtureGit(['add', 'package.json'], { cwd: root });
  runFixtureGit(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
  const machine = join(root, '.machine');
  mkdirSync(machine);
  // Four gate slots, so the four runs overlap and only the file pool can hold them to the cores.
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 4, browserSlots: 1 }));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: machine, [TEST_FILE_CORES_ENV]: String(cores), FIXTURE_LOG: join(root, 'log.jsonl') };
  // This test file holds a token of its own run's pool; the fixture runs get a pool of their own.
  delete env[TEST_FILE_POOL_ENV];
  return { root, env, log: () => readFileSync(env.FIXTURE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

/** The most file bodies running at one moment in a start/end log. */
export function peak(events) {
  let live = 0;
  let most = 0;
  for (const event of [...events].sort((a, b) => a.t - b.t || (a.at === 'end' ? -1 : 1))) {
    live += event.at === 'start' ? 1 : -1;
    most = Math.max(most, live);
  }
  return most;
}
