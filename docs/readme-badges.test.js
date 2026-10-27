/** @pullboard-test-input source-tree */
/** README board badges use tracked endpoints that a real landing refreshes [I10,B3,V1]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from '../test/e2e-helpers.js';
import { runFixtureGit } from '../test/fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');
const e2e = createE2eHelpers();
after(e2e.cleanup);

test('README board-count badges read tracked main endpoint documents [I10,B3,V1]', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const badges = [...readme.matchAll(/<img\b[^>]*alt="(pullboard|agent-verified)(?:: [^"]*)?"[^>]*src="([^"]+)"/gu)];
  assert.deepEqual(badges.map(([, label]) => label).sort(), ['pullboard'],
    'only the item-count badge is live; the verification badge returns after #1306');
  for (const [, label, source] of badges) {
    const url = new URL(source.replaceAll('&amp;', '&'));
    assert.equal(url.origin, 'https://img.shields.io');
    assert.equal(url.pathname, '/endpoint', `${label} reads live endpoint data`);
    const path = `docs/badges/${label === 'pullboard' ? 'items' : 'checked'}.json`;
    assert.equal(url.searchParams.get('url'), `https://raw.githubusercontent.com/pullboard-dev/pullboard/main/${path}`);
    assert.equal(url.searchParams.get('style'), 'flat-square');
    assert.equal(runFixtureGit(['ls-files', '--error-unmatch', '--', path], { cwd: ROOT }), path,
      'the endpoint is tracked, so publishing main makes it reachable');
    const document = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.label, label);
    assert.match(document.message, label === 'pullboard' ? /^\d+ items$/u : /^\d+%$/u);
    assert.equal(document.isError, undefined);
  }
});

test('landing rewrites stale tracked board badge counts inside the containing merge [B3,V1]', () => {
  const check = 'node --test --test-reporter=tap web/badge.test.cjs';
  const box = e2e.project(check);
  // These are fresh fixture CLIs; retain native admission while avoiding nested Node worker suppression.
  delete box.env.NODE_TEST_CONTEXT;
  assert.equal(box.run(box.web, 'join', 'web', '--model', 'Badge fixture', '--parent', 'readme-badge-builder').code, 0);
  assert.equal(box.run(box.repo, 'join', 'coordinator', '--model', 'Badge fixture', '--parent', 'readme-badge-reviewer').code, 0);
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, landing: { publish: 'separate' } }, null, 2));
  mkdirSync(join(box.repo, 'docs/badges'), { recursive: true });
  const stale = [
    ['items', { schemaVersion: 1, label: 'pullboard', message: '99 items', color: '2f7d5b' }],
    ['checked', { schemaVersion: 1, label: 'agent-verified', message: '0%', color: '6e7781' }],
  ];
  for (const [name, document] of stale) writeFileSync(join(box.repo, `docs/badges/${name}.json`), JSON.stringify(document, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json', ...stale.map(([name]) => `docs/badges/${name}.json`));
  box.git(box.repo, 'commit', '-q', '-m', 'test: seed stale tracked badge endpoints');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = box.run(box.repo, 'add', 'web', 'Refresh tracked badges', '--criterion', 'The native probe passes.',
    '--check', check, '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  const committed = e2e.commitFile(box, box.web, 'web/badge.test.cjs',
    "const { test } = require('node:test'); test('the badge probe passes [G1]', () => {});\n", 'test(web): badge probe [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = box.run(box.web, 'submit', String(id));
  assert.equal(submitted.code, 0, submitted.err || submitted.out);
  const checkLog = box.git(box.web, 'rev-parse', '--git-path', 'pullboard-submit.log.check.log');
  const proof = readFileSync(resolve(box.web, checkLog), 'utf8');
  assert.match(proof, /ok 1 - the badge probe passes \[G1\]/u, 'submit executes the real probe body');
  assert.match(proof, /# tests 1\b/u);
  assert.match(proof, /# fail 0\b/u);
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const accepted = box.run(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'The real native probe passed.');
    assert.equal(accepted.code, 0, accepted.err || accepted.out);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const before = box.git(box.repo, 'rev-parse', 'HEAD');
  for (const [name, document] of stale) assert.deepEqual(JSON.parse(box.git(box.repo, 'show', `HEAD:docs/badges/${name}.json`)), document);
  const result = box.run(box.repo, 'land', '--json');
  assert.equal(result.code, 0, result.err || result.out);
  const landed = JSON.parse(result.out);
  assert.deepEqual(landed.landed, [id]);
  const item = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.equal(item.item_merged_commit, landed.batch.tip);
  assert.deepEqual(box.git(box.repo, 'rev-list', '--parents', '-n', '1', landed.batch.tip).split(' '),
    [landed.batch.tip, before, commit], 'the refresh preserves both real merge parents');
  for (const [name, label, message, color] of [
    ['items', 'pullboard', '1 items', '2f7d5b'], ['checked', 'agent-verified', '100%', '6e7781'],
  ]) {
    assert.deepEqual(JSON.parse(box.git(box.repo, 'show', `${landed.batch.tip}:docs/badges/${name}.json`)),
      { schemaVersion: 1, label, message, color },
      'the landed commit replaces the stale count with the actual independent board count');
  }
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), landed.batch.tip);
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '', 'the refreshed endpoints are committed');
});
