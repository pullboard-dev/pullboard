/** In-process CLI runs end cleanly: a process that ran commands exits on its own, with no handle left open [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';

const HELPER = pathToFileURL(new URL('../../tests/fixtures/process.js', import.meta.url).pathname).href;
const DIRS = [];
after(() => { for (const dir of DIRS) rmSync(dir, { recursive: true, force: true }); });

test('a process that ran init and a board command in-process exits by itself with only stdio left open [C7]', () => {
  const dir = privateFixtureFiles('pullboard-inproc-handles-').root;
  DIRS.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Handles', GIT_AUTHOR_EMAIL: 'h@example.invalid',
    GIT_COMMITTER_NAME: 'Handles', GIT_COMMITTER_EMAIL: 'h@example.invalid', PULLBOARD_VIEW_BACKGROUND: '0' };
  delete env.NODE_TEST_CONTEXT;
  // The script never calls process.exit, so only an empty event loop lets it end.
  const script = `import { execFileSync } from 'node:child_process';
import { runCliInProcess } from ${JSON.stringify(HELPER)};
execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'init', '-q', '-b', 'main']);
const init = await runCliInProcess(['init'], { cwd: ${JSON.stringify(repo)}, env: process.env });
const list = await runCliInProcess(['list', '--json'], { cwd: ${JSON.stringify(repo)}, env: process.env });
const open = process._getActiveHandles().filter(handle => !(handle?.fd === 0 || handle?.fd === 1 || handle?.fd === 2));
process.stdout.write(JSON.stringify({ init: init.status, list: list.status, open: open.map(handle => handle.constructor.name) }));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.signal ?? null, null, 'the process ended by itself and was not killed at the timeout: ' + result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.init, 0);
  assert.equal(seen.list, 0);
  assert.deepEqual(seen.open, [], 'no timer, socket, child or other handle outlives the commands');
});
