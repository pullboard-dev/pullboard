/** New companion metadata uses the item format while historical commits remain readable [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  buildCommitMessage,
  commitMessageProblems,
  parseCommitMessage,
} from '../../../packages/commits/index.js';
import { landingMessage } from '../../../packages/landing/index.js';
import { commitMsgProblems } from '../../../packages/commits/index.js';
import { defaults } from '../../../packages/config/index.js';
import { parseSpec } from '../../../packages/spec/index.js';
import { itemsTouching } from '../../../packages/commits/index.js';
import { cellSandbox } from '../../../packages/store/tests/fixtures/cell.js';

const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each sandbox's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

/** Real Git history without installed hooks models old recorded messages, never a live-board write. */
function historyFixture() {
  const box = cellSandbox(owner);
  const root = join(box.dir, 'metadata');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  /** Commit literal fixture history and return the actual persisted message. */
  function commit(text, message) {
    writeFileSync(join(root, 'guide.txt'), text);
    box.git(root, 'add', 'guide.txt');
    box.git(root, 'commit', '-q', '-m', message);
    return box.git(root, 'log', '-1', '--format=%B').trimEnd();
  }
  return { root, commit };
}

test('lib.metadata.a-new-companion-commit-carries-pullboard-item: a new companion commit carries Pullboard-Item and an old one still parses [C7]', () => {
  const box = historyFixture();
  // Synthetic frozen item shape isolates message generation; the commit and stored bytes are real Git.
  const item = { item_id: 17, item_parent_id: 8, item_lane: 'docs', item_title: 'Companion guide',
    item_spec_ids: 'C7', item_frozen: JSON.stringify({ rows: [{ id: 'C7' }] }) };
  const generated = landingMessage(item, { type: 'docs' });
  const current = box.commit('current\n', generated.message);
  assert.match(current, /^Pullboard-Item: #17$/mu);
  assert.doesNotMatch(current, /Pullboard-Companion:/u);
  assert.equal(parseCommitMessage(current).item, 17);
  assert.deepEqual(commitMessageProblems(current, { item: 17, rows: ['C7'] }), []);

  const historical = box.commit('historical\n', current.replace('Pullboard-Item:', 'Pullboard-Companion:'));
  const parsed = parseCommitMessage(historical);
  assert.equal(parsed.item, 17, 'the retired trailer remains an item identity when reading history');
  assert.deepEqual(parsed.rows, ['C7']);
  const rewritten = buildCommitMessage({ type: parsed.type, scope: parsed.scope, title: parsed.title,
    item: parsed.item, rows: parsed.rows });
  assert.match(rewritten.message, /^Pullboard-Item: #17$/mu, 'new generation always uses the current name');
  assert.doesNotMatch(rewritten.message, /Pullboard-Companion:/u);
  assert.ok(commitMessageProblems(historical, { item: 17, rows: ['C7'] }).some(problem => /retired/u.test(problem)),
    'historical readability never authorizes a new legacy trailer');
  assert.ok(commitMsgProblems('feat(merge): old rowless\n\nPullboard-Companion: #17', {
    rules: defaults().commits, spec: parseSpec(''), rowlessLandings: [17],
  }).some(problem => /retired/u.test(problem)), 'legacy reading cannot borrow the hook exemption for a new rowless landing');
  const mixed = historical.replace('Pullboard-Companion: #17', 'Pullboard-Item: #18\nPullboard-Companion: #17');
  assert.equal(parseCommitMessage(mixed).item, 18, 'the canonical trailer takes precedence');
  assert.equal(parseCommitMessage(mixed.replace('Pullboard-Item: #18', 'Pullboard-Item: invalid')).item, null,
    'a malformed canonical identity never borrows the legacy value');
});

test('lib.metadata.file-history-retains-old-companion-items-alongside: file history retains old companion items alongside newly generated item trailers [C7]', () => {
  const box = historyFixture();
  box.commit('old\n', 'docs(merge): old guide [C7]\n\nPullboard-Companion: #11');
  box.commit('new\n', buildCommitMessage({ type: 'docs', scope: 'merge', title: 'new guide', item: 12, rows: ['C7'] }).message);
  assert.deepEqual(itemsTouching(box.root, { file: 'guide.txt', line: null }), [11, 12]);
});
