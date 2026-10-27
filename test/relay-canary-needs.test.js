/** Offline canary needs retain local queue evidence without loading the relay writer [C7,H5]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { relayCanaryNeeds } from '../src/relay-canary-needs.js';
import { observeRelayHealth } from '../src/relay-canary-health.js';
import { outboxFile, outboxSummaryFile, readOutboxCount } from '../src/relay-outbox-summary.js';
import { readRelayLink } from '../src/relay-link-read.js';
import { runFixtureGit } from './fixture-child.js';

/** A real private Git repository with a persisted two-probe alert and no transport or native board. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-canary-needs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Canary fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Canary fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  runFixtureGit(['commit', '-q', '--allow-empty', '-m', 'chore: private canary fixture'], { cwd: root, env });
  const failed = { ok: false, step: 'pull', code: 'RELAY_READ', roundTripMs: 2 };
  observeRelayHealth(root, failed);
  assert.equal(observeRelayHealth(root, failed).transition, 'alert');
  const file = join(root, '.git', 'pullboard', 'relay.json');
  /** Save local metadata without a credential, so reading cannot silently migrate it. */
  function link(overrides = {}) {
    const state = { version: 1, board: 'a'.repeat(32), url: 'https://example.invalid', sequence: 0, cursor: 0,
      outbox: { moves: [{ id: 'legacy' }] }, ...overrides };
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return state;
  }
  return { root, file, link };
}

/** Assert the actual Needs-you projection and preserve all supplied local evidence byte for byte. */
function assertQueued(box, count, label = 'the local queued-move count stays accurate') {
  const files = [box.file, outboxSummaryFile(box.file), outboxFile(box.file),
    join(box.root, '.git', 'pullboard', 'relay-health.sqlite')];
  const before = files.map(file => existsSync(file) ? readFileSync(file) : null);
  const needs = relayCanaryNeeds(box.root);
  assert.equal(needs.length, 1, 'the persisted local alert remains visible');
  assert.equal(needs[0].queued, count, label);
  assert.match(needs[0].text, new RegExp(`queued locally \\(${count}\\)$`, 'u'));
  for (const [index, file] of files.entries()) {
    assert.deepEqual(existsSync(file) ? readFileSync(file) : null, before[index], 'a count read preserves local evidence');
  }
}

test('offline canary needs retain alerts and do not create a relay link or board [C7,H5]', t => {
  const box = fixture(t);
  assertQueued(box, 0);
  assert.equal(existsSync(join(box.root, '.git', 'pullboard', 'board.sqlite')), false);
});

test('canary queue counts prefer the modern summary and retain the sealed legacy fallback [C7,H5]', t => {
  const box = fixture(t);
  box.link();
  writeFileSync(outboxFile(box.file), 'opaque legacy fixture; count reads never unseal it');
  assertQueued(box, 1);
  writeFileSync(outboxSummaryFile(box.file), JSON.stringify({ moves: [{ id: 'first' }, { id: 'second' }] }));
  assertQueued(box, 2);
  writeFileSync(outboxSummaryFile(box.file), '{broken');
  assertQueued(box, 1);
  writeFileSync(outboxSummaryFile(box.file), JSON.stringify({ moves: [] }));
  assertQueued(box, 1);
  rmSync(outboxFile(box.file));
  assertQueued(box, 0);
  writeFileSync(outboxSummaryFile(box.file), JSON.stringify({ moves: [{ id: 'independent-summary' }] }));
  assertQueued(box, 1, 'the independently saved summary does not require the sealed file');
  box.link({ unlinking: true });
  assertQueued(box, 0);
  rmSync(box.file);
  assertQueued(box, 0, 'an orphaned summary is not a linked queue');
});

test('canary count reads preserve private-file and link validation without migrating metadata [C7,H5]', t => {
  const box = fixture(t);
  const state = box.link();
  assert.deepEqual(readRelayLink(box.file), state);
  writeFileSync(outboxSummaryFile(box.file), JSON.stringify({ moves: [{ id: 'queued' }] }));
  assert.equal(readOutboxCount(box.file), 1);
  assertQueued(box, 1);
  chmodSync(box.file, 0o644);
  assert.throws(() => readRelayLink(box.file), /RELAY_STORAGE/u);
  assertQueued(box, 0);
  chmodSync(box.file, 0o600);
  box.link({ cursor: -1 });
  assert.throws(() => readRelayLink(box.file), /RELAY_STORAGE/u);
  assertQueued(box, 0);
  box.link({ url: 'https://example.invalid/not-an-origin' });
  assert.throws(() => readRelayLink(box.file), /RELAY_URL/u);
  assertQueued(box, 0);
});
