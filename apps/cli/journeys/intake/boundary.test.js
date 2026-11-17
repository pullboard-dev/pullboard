/** @pullboard-test-input packages/kernel/src/logic/seal.js */
/** Outside pull request sensitive-path and sandbox-image intake cases split from main.test.js [V3,B26,V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  advanceOutsideFixture,
  configureFixtureSandbox,
  fixtureJSON,
  intakeFixture,
} from "../../tests/fixtures/intake.js";

test('only trusted main can extend outside sensitive paths and ordinary source stays ordinary [B26,V4]', t => {
  const box = intakeFixture(t);
  const configPath = new URL('pullboard.json', 'file://' + box.repo + '/');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.intake = { sensitivePaths: ['data/regulated.json'] };
  writeFileSync(configPath, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: declare private sensitive data');
  advanceOutsideFixture(box, 'data/regulated.json', '{"fixture":true}\n', ['apps/relay/src/io/deploy/outside.js']);
  advanceOutsideFixture(box, 'lib/ordinary.js', 'export const add = (left, right) => left + right;\n');
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.ok(filed.item.outside.sensitivity.some(reason => reason.path === 'data/regulated.json' && reason.rule === 'configured-sensitive-path'));
  assert.equal(filed.item.outside.sensitivity.some(reason => reason.path === 'lib/ordinary.js'), false, 'source files are not all sensitive just for being source');
});

test('renaming an existing sealing boundary cannot hide its touched old path [B26,V3]', t => {
  const content = 'export const sealFixture = value => value;\n';
  const box = intakeFixture(t, { baseFiles: { 'packages/kernel/src/logic/seal.js': content } });
  advanceOutsideFixture(box, 'lib/moved-boundary.js', content, ['packages/kernel/src/logic/seal.js', 'apps/relay/src/io/deploy/outside.js']);
  const facts = JSON.parse(readFileSync(box.facts, 'utf8'));
  facts.files = facts.files.filter(file => file.filename !== 'lib/moved-boundary.js');
  facts.files.push({ filename: 'lib/moved-boundary.js', previous_filename: 'packages/kernel/src/logic/seal.js', status: 'renamed' });
  writeFileSync(box.facts, JSON.stringify(facts));
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  assert.ok(filed.item.outside.sensitivity.some(reason => reason.path === 'packages/kernel/src/logic/seal.js' && reason.rule === 'declared-sensitive-path'), 'the exact old trust-boundary path remains part of the owner decision after a GitHub rename');
});

test('trusted pinned browser images use the sandbox protocol without changing actual Node roles [V3,C7]', t => {
  const box = intakeFixture(t);
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, '--criterion', 'the fixture behavior works', '--check', 'node --test test/contribution.test.js');
  const id = String(filed.item.item_id);
  // A transport double models the custom image reference; this case is not real Chrome/container execution.
  const images = { minimum: 'ghcr.io/fixture/node-chrome-min@sha256:' + '3'.repeat(64), current: 'ghcr.io/fixture/node-chrome-current@sha256:' + '4'.repeat(64) };
  configureFixtureSandbox(box, { images });
  assert.equal(fixtureJSON(box, box.web, 'verify', id, 'accept', '--sandbox', '--note', 'trusted browser image protocol').decision, 'ACCEPT');
  const runs = fixtureJSON(box, box.repo, 'show', id).outside.sandbox.runs;
  assert.deepEqual(runs.map(run => run.image), [images.minimum, images.current]);
  assert.deepEqual(runs.map(run => run.environment.node), ['22.13.1', '24.21.0']);
});
