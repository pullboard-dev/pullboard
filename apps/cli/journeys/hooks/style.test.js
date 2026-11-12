/** Commit hooks fix mechanical header style in place and say what they changed, so style costs no retry [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { fixCommitHeader } from '../../../../packages/commits/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const RULES = { maxHeader: 72, types: ['feat', 'fix', 'docs', 'test', 'chore', 'refactor'] };

/** A real seat claim in a real project, so the installed commit-msg hook runs on every commit. */
async function claimed() {
  const box = e2e.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Header style', '--criterion', 'the hook fixes header style', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claim = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(claim.code, 0, claim.err);
  return box;
}

test('clause 1, clause 2: a real commit with a capitalised, over-long, full-stopped header lands fixed on the first try and says each fix [C7]', async () => {
  const box = await claimed();
  const long = 'feat(web): Retain the context of every claim across a long and winding session of work. [G1]';
  assert.ok(long.length > 72);
  const result = e2e.commitFile(box, box.web, 'web/style.txt', 'work\n', long);
  assert.equal(result.status, 0, result.stderr);
  const header = box.git(box.web, 'log', '-1', '--format=%s').trim();
  assert.ok(header.length <= 72, `header has ${header.length} characters: ${header}`);
  assert.match(header, /^feat\(web\): retain the context of every claim .* \[G1\]$/u);
  assert.doesNotMatch(header, /\.\s*\[G1\]$/u);
  assert.match(result.stderr, /pullboard commit-msg: fixed: lowercased the subject's first word \("Retain" to "retain"\)/u);
  assert.match(result.stderr, /pullboard commit-msg: fixed: removed the period at the end of the subject/u);
  assert.match(result.stderr, /pullboard commit-msg: fixed: shortened the header from \d+ to \d+ characters by dropping "[^"]+"/u);
  assert.ok(result.stderr.includes(`pullboard commit-msg: fixed: header is now: ${header}`), result.stderr);
});

test('a header already in style passes without a fix note [C7]', async () => {
  const box = await claimed();
  const result = e2e.commitFile(box, box.web, 'web/plain.txt', 'work\n', 'feat(web): retain context [G1]');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /fixed:/u);
});

test('the header fix keeps ids, lowercases whole acronyms, and is idempotent [C7]', () => {
  const once = fixCommitHeader('fix(cli): CLI help names every command and every flag it takes, with examples for each [C7,G1]\n\nPullboard-Item: #4\n', RULES);
  const header = once.message.split('\n')[0];
  assert.ok(header.length <= 72, header);
  assert.match(header, /^fix\(cli\): cli help names .* \[C7,G1\]$/u);
  assert.match(once.message, /\n\nPullboard-Item: #4\n$/u, 'the body and trailers are kept');
  assert.deepEqual(fixCommitHeader(once.message, RULES), { message: once.message, notes: [] }, 'a fixed header is never fixed again');
});

test('comment lines are skipped, and merges, untyped headers and headers with no room are left for the rules [C7]', () => {
  assert.equal(fixCommitHeader('# comment\nfeat: Add it\n', RULES).message, '# comment\nfeat: add it\n');
  for (const raw of ['Merge branch main into core/item-4\n', 'Add a thing\n', `feat(${'a'.repeat(50)}): Subject [${'B1,'.repeat(5)}B2]\n`]) {
    assert.deepEqual(fixCommitHeader(raw, RULES).message, raw.startsWith('feat(') ? raw.replace('Subject', 'subject') : raw);
  }
});
