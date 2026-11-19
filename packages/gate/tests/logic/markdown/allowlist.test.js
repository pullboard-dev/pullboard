/** @pullboard-world-pin reads the shipped allowlist and judges this checkout's tracked .md files, because the bar is that main holds only allowed ones. */
/** The markdown allowlist refuses a staged .md that is not listed, names the fix, and lists every tracked .md today [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changedStaticFailures } from '../../../heavy.js';
import { MARKDOWN_ALLOWLIST } from '../../../src/logic/markdown/allowlist.js';
import { markdownProblems } from '../../../src/logic/markdown/allowlist.js';
import { fixtureCommittedGraph } from '../../fixtures/testkit.js';
import { runFixtureGit } from '../../fixtures/child.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const SHIPPED = readFileSync(join(ROOT, MARKDOWN_ALLOWLIST), 'utf8');
const REAL = JSON.stringify({ ...JSON.parse(SHIPPED), enforce: true });

/** A private repository holding the real allowlist and the named files, all staged. */
function stagedRepo(t, files, allowlist = REAL) {
  const repo = fixtureCommittedGraph('pullboard-markdown-allowlist-');
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries({ [MARKDOWN_ALLOWLIST]: allowlist, ...files })) repo.put(file, source);
  runFixtureGit(['add', '-A'], { cwd: repo.root });
  return repo.root;
}

/** What the pre-commit hook's static check says about a repository's index. */
const judge = root => changedStaticFailures(root, [], { staged: true, only: ['markdown-allowlist'] });

test('gate.logic-markdown-allowlist.a-staged-md-that-is: clause 1: a staged .md that is not on the allowlist is refused with the three fixes; an allowed one passes [C7]', t => {
  const root = stagedRepo(t, { 'docs/notes.md': '# notes\n', 'skills/plan/SKILL.md': '# plan\n', 'docs/rfcs/0010-x.md': '# rfc\n', 'README.md': '# r\n' });
  const failures = judge(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^docs\/notes\.md:1: this \.md file is not on the allowlist; delete it, move its content into CLI help or a skill \(skills\/<name>\/SKILL\.md\), or add an entry with a reason to packages\/gate\/data\/ceilings\/markdown-allowlist\.json$/u);
});

test('gate.logic-markdown-allowlist.an-entry-added-with-a: clause 1: an entry added with a reason lets the file through, and a nested folder is not matched by a one-level star [C7]', t => {
  const added = JSON.stringify({ enforce: true, entries: [{ pattern: 'docs/*.md', reason: 'one level of docs' }] });
  assert.deepEqual(judge(stagedRepo(t, { 'docs/a.md': '#\n' }, added)), []);
  assert.equal(judge(stagedRepo(t, { 'docs/deep/a.md': '#\n' }, added)).length, 1);
});

test('gate.logic-markdown-allowlist.an-entry-with-no-reason: clause 2: an entry with no reason is refused by name [C7]', () => {
  const rows = markdownProblems(JSON.stringify({ entries: [{ pattern: 'a.md', reason: ' ' }, { pattern: 'b.md', reason: 'ok' }] }), ['b.md']);
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /the entry for a\.md has no reason/u);
  assert.equal(markdownProblems('not json', []).length, 1);
});

test('gate.logic-markdown-allowlist.the-allowlist-is-one-file: clause 2: the allowlist is one file, every entry has a reason, and it lists the permanent files and the pending ones with their dropping item [C7]', () => {
  const { entries } = JSON.parse(REAL);
  for (const entry of entries) assert.ok(entry.pattern && entry.reason.trim(), `${entry.pattern} needs a reason`);
  const patterns = entries.map(entry => entry.pattern);
  for (const expected of ['skills/*/SKILL.md', 'SPEC.md', 'DOCTRINE.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CLA.md', 'AGENTS.md',
    'COORDINATOR.md', 'CLAUDE.md', 'CHANGELOG.md', 'docs/rfcs/*.md', '.github/ISSUE_TEMPLATE/*.md', '.github/pull_request_template.md']) assert.ok(patterns.includes(expected), expected);
  const temporary = entries.filter(entry => entry.reason.startsWith('temporary:'));
  for (const entry of temporary) assert.match(entry.reason, /#\d+|under review \(Corey's checklist\)/u, `${entry.pattern} names what drops it`);
  for (const file of ['docs/method.md', 'docs/proof/spec.md', 'docs/sentinels.md', 'docs/rigor.md', 'docs/handoff.md', 'docs/contributing-runbook.md']) {
    assert.match(entries.find(entry => entry.pattern === file || entry.pattern === 'docs/proof/*.md' && file.startsWith('docs/proof/')).reason, /#5310/u, file);
  }
  assert.match(entries.find(entry => entry.pattern === 'docs/lifecycle.md').reason, /#5309/u);
});

test('gate.logic-markdown-allowlist.the-refusal-ships-on: clause 1: the shipped allowlist enforces, so a staged .md that is not on the list is refused [C7]', t => {
  assert.equal(JSON.parse(SHIPPED).enforce, true);
  const problems = judge(stagedRepo(t, { 'docs/notes.md': '# notes\n' }, SHIPPED));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/notes\.md/u);
});

test('gate.logic-markdown-allowlist.every-md-this-checkout-tracks: clause 2: every .md this checkout tracks is allowed, so turning the switch on stays green [C7]', () => {
  const tracked = runFixtureGit(['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).split('\0').filter(Boolean);
  assert.deepEqual(markdownProblems(REAL, tracked), []);
});
