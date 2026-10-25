/** Private Git/SQLite and loopback-provider setup for the real mixed-mode integration drill [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';

/** Create one real repository and board; no runner registration, host settings or credentials are changed. */
export function mixedModeProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Mixed-mode fixture model';
  const box = helpers.project('node web/drill-check.cjs', sandbox);
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.publish = { pullRequest: 'release' };
  config.approvers = ['fixture-person'];
  assert.equal(helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config, null, 2),
    'chore: enable private proposal protocol [G1]').status, 0);
  const check = `const assert = require('node:assert/strict');
const fs = require('node:fs');
for (const path of ['web/local.js', 'web/runner.js', 'web/pull-request.js']) {
  if (fs.existsSync(path)) assert.match(fs.readFileSync(path, 'utf8'), /^PASS\\n$/);
}
console.log('TAP version 13');
console.log('ok 1 - mixed-mode project content stays green');
console.log('1..1'); console.log('# tests 1'); console.log('# pass 1');
console.log('# fail 0'); console.log('# skipped 0');
`;
  assert.equal(helpers.commitFile(box, box.repo, 'web/drill-check.cjs', check,
    'test(web): track the mixed-mode project check [G1]').status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const runner = join(box.dir, 'runner-developer');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/runner', runner, 'main');
  const joined = box.run(runner, 'join', 'web', '--json');
  assert.equal(joined.code, 0, joined.err);
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const published = box.git(remote, 'rev-parse', 'main');
  box.git(box.repo, 'remote', 'set-url', 'origin', 'https://github.com/fixture/repository.git');
  box.git(box.repo, 'config', `url.${remote}.insteadOf`, 'https://github.com/fixture/repository.git');
  const outside = join(box.dir, 'pull-request-developer');
  box.git(box.dir, 'clone', '-q', '--branch', 'main', '--no-hardlinks', remote, outside);
  /** Compare the committed contract rather than mutable rows or developer descriptions. */
  const contract = root => Object.fromEntries(['SPEC.md', 'DOCTRINE.md', 'pullboard.json', 'web/drill-check.cjs'].map(path =>
    [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const baseline = contract(box.repo);
  for (const root of [box.web, runner, outside]) assert.deepEqual(contract(root), baseline);
  return { ...box, ...helpers, runner, outside, remote, published, contract, baseline, mode: 'release' };
}
