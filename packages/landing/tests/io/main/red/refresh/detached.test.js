/** After a landing, the main-red refresh runs in a detached child so the landing worker exits at once [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { refreshPublishedMainReds } from '../../../../../src/io/step/publish.js';

/** A tiny repository on main with two commits, so the published main differs from the previous one. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const previous = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  return { root, previous, published: git('rev-parse', 'HEAD') };
}

test('the refresh is launched detached with the previous and published main, and the landing does not wait for it [C7]', (t) => {
  const { root, previous, published } = repo(t);
  const launches = [];
  const said = [];
  const started = refreshPublishedMainReds({ root, say: line => said.push(line) }, previous,
    { launch: (...args) => { launches.push(args); } });
  assert.deepEqual(launches, [[root, previous, published]], 'one detached launch names the root and both mains');
  assert.deepEqual(started, { previousMain: previous, publishedMain: published });
  assert.deepEqual(said, [], 'nothing waits or reports here');
});

test('an unchanged main launches nothing, and a launch failure is said, never thrown [C7]', (t) => {
  const { root, published } = repo(t);
  const launches = [];
  assert.equal(refreshPublishedMainReds({ root, say() {} }, published, { launch: (...args) => launches.push(args) }), null);
  assert.deepEqual(launches, []);
  const said = [];
  const { previous } = repo(t);
  assert.equal(refreshPublishedMainReds({ root, say: line => said.push(line) }, previous, { launch: () => { throw new Error('no spawn'); } }), null);
  assert.match(said[0], /background main-red refresh could not start: no spawn/u);
});
