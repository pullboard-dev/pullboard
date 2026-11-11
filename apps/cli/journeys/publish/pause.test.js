/** Real publish and gate receipts govern the optional landing pause [C7,V4]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Keep the failing input outside Git so the second actual execution tests the identical committed tree. */
function fixture({ enabled = true } = {}) {
  const box = e2e.sandbox();
  delete box.env.NODE_TEST_CONTEXT;
  const input = join(box.dir, 'red-input');
  box.env.PUBLISH_PAUSE_RED_INPUT = input;
  const project = e2e.project('node --test test/publish.test.js', box, { withWorktree: false });
  const { repo } = project;
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test/publish.test.js'), `import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
test('publish contract', () => assert.equal(existsSync(process.env.PUBLISH_PAUSE_RED_INPUT), false));
`);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  config.landing = { ...config.landing, manualOverride: true, publish: 'separate', ...(enabled ? { pauseOnRed: true } : {}) };
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify(config));
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-qm', 'test: add publish contract');
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'init', '--bare', '-q', remote);
  box.git(repo, 'remote', 'add', 'origin', remote);
  return { ...project, input, remote };
}

test('a red full-suite run pauses landing until a green head or a proven flake [C7,V4]', () => {
  const box = fixture();
  writeFileSync(box.input, 'red');
  const red = box.run(box.repo, 'publish');
  assert.equal(red.code, 1, red.out + red.err);
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const blocked = box.run(box.repo, 'land');
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.err + blocked.out, /PUBLISH_RED/);
  assert.ok((blocked.err + blocked.out).includes(head.trim()));
  assert.match(blocked.err + blocked.out, /test\/publish.test.js/);
  assert.match(blocked.err + blocked.out, /last changed by no recorded landed item/);
  const state = join(box.repo, '.git', 'pullboard', 'publish.json');
  const originalRed = readFileSync(state, 'utf8');
  rmSync(box.input);
  const green = box.run(box.repo, 'gate');
  assert.equal(green.code, 0, green.out + green.err);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), head);
  const proven = box.run(box.repo, 'land');
  assert.doesNotMatch(proven.err + proven.out, /PUBLISH_RED/);
  assert.equal(readFileSync(state, 'utf8'), originalRed, 'flake proof leaves the original publish red intact');

  // A later committed tree starts with a new red; the old tree's green cannot clear it.
  writeFileSync(join(box.repo, 'fix.txt'), 'new head');
  box.git(box.repo, 'add', 'fix.txt');
  box.git(box.repo, 'commit', '-qm', 'test: advance publish head');
  writeFileSync(box.input, 'red again');
  assert.equal(box.run(box.repo, 'publish').code, 1);
  assert.match(box.run(box.repo, 'land').err, /PUBLISH_RED/);
  rmSync(box.input);
  writeFileSync(join(box.repo, 'fix.txt'), 'corrected head');
  box.git(box.repo, 'add', 'fix.txt');
  box.git(box.repo, 'commit', '-qm', 'test: correct publish head');
  const pushHook = join(box.remote, 'hooks', 'pre-receive');
  writeFileSync(pushHook, '#!/bin/sh\nexit 1\n');
  chmodSync(pushHook, 0o755);
  const failedPush = box.run(box.repo, 'publish');
  assert.notEqual(failedPush.code, 0);
  assert.match(failedPush.err + failedPush.out, /LAND_PUSH/);
  assert.doesNotMatch(box.run(box.repo, 'land').err, /PUBLISH_RED/);
  rmSync(pushHook);
  const published = box.run(box.repo, 'publish');
  assert.equal(published.code, 0, published.out + published.err);
  assert.doesNotMatch(box.run(box.repo, 'land').err, /PUBLISH_RED/);
});


test('publish pause is off by default and never rewrites the original red [C7,V4]', () => {
  const box = fixture({ enabled: false });
  writeFileSync(box.input, 'red');
  assert.equal(box.run(box.repo, 'publish').code, 1);
  const common = box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const state = join(common, 'pullboard', 'publish.json');
  const original = readFileSync(state, 'utf8');
  assert.ok(JSON.parse(original).receipt);
  assert.doesNotMatch(box.run(box.repo, 'land').err, /PUBLISH_RED/);
  assert.equal(readFileSync(state, 'utf8'), original);
});
