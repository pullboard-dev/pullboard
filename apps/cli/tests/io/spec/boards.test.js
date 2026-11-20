/**
 * Other boards' spec ids [C2,S8]: a commit cites another board's row qualified as `<board>:<id>`,
 * which resolves on that board's spec named in pullboard.json specBoards, never on this SPEC.md;
 * commits that already cite such an id bare carry a recorded correction that spec check reads.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commitMsgProblems } from '../../../../../packages/commits/index.js';
import { CITATIONS_FILE } from '../../../../../packages/spec/index.js';
import { citedIds } from '../../../../../packages/spec/index.js';
import { loadSpec } from '../../../../../packages/spec/index.js';
import { parseSpec } from '../../../../../packages/spec/index.js';
import { specBox } from '../../fixtures/spec/box.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

const RULES = { types: ['feat', 'fix', 'docs', 'test', 'chore'], maxHeader: 72, requireIds: ['feat', 'fix'], banned: [], noEmoji: true, noCoAuthor: false };
const UPGRADES = '# Upgrades\n\n## U\n- U94 [approved, must] Upgrades keep the board. | gate: review\n- U95 [retired, must] An old upgrade rule. | gate: review\n';

/** A spec box whose pullboard.json names an upgrades board at a sibling folder holding its own SPEC.md. */
function boardsBox(t, { reachable = true } = {}) {
  const box = specBox(t);
  const other = `${box.root}-upgrades`;
  if (reachable) {
    mkdirSync(other, { recursive: true });
    fixtureProjectPolicy(other, { config: { spec: 'SPEC.md' }, spec: UPGRADES });
    t.after(() => rmSync(other, { recursive: true, force: true }));
  }
  const config = { ...JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8')), specBoards: { upgrades: `../${other.split('/').at(-1)}` } };
  fixtureProjectPolicy(box.root, { config });
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'chore: name the upgrades board');
  return { ...box, config };
}

/** Record a commit citing `header` without running hooks, as history written before the rule. */
function pastCommit(box, header) {
  const tree = box.git('write-tree');
  const parent = box.git('rev-parse', 'HEAD');
  const sha = box.git('commit-tree', tree, '-p', parent, '-m', header);
  box.git('update-ref', 'refs/heads/main', sha);
  return sha;
}

test('cli.io-spec-boards.a-commit-cites-another-board-qualified-and: a commit cites another board qualified and spec check resolves it there; a bare foreign id is refused [C2,S8]', async (t) => {
  const box = boardsBox(t);
  const spec = loadSpec(box.root, box.config);
  assert.deepEqual(citedIds('feat(web): carry upgrades [upgrades:U94]'), ['upgrades:U94']);
  assert.deepEqual(commitMsgProblems('feat(web): carry upgrades [G1,upgrades:U94]', { rules: RULES, spec }), []);
  assert.match(commitMsgProblems('feat(web): carry upgrades [upgrades:U99]', { rules: RULES, spec })[0], /upgrades:U99 is not in the upgrades board's spec/u);
  assert.match(commitMsgProblems('feat(web): carry upgrades [upgrades:U95]', { rules: RULES, spec })[0], /upgrades:U95 is retired/u);
  assert.match(commitMsgProblems('feat(web): carry upgrades [nowhere:U94]', { rules: RULES, spec })[0], /nowhere:U94 uses an unknown namespace.*specBoards/u);
  // The bare id stays refused: U94 is not in this SPEC.md, and nothing aliases it into this namespace.
  assert.match(commitMsgProblems('feat(web): carry upgrades [U94]', { rules: RULES, spec })[0], /U94 is not in SPEC\.md/u);

  pastCommit(box, 'feat(web): carry upgrades [G1,upgrades:U94]');
  const resolved = await box.spec('check');
  assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`);
  assert.doesNotMatch(resolved.stdout, /U94/u);

  pastCommit(box, 'feat(web): carry more upgrades [upgrades:U99]');
  const missing = await box.spec('check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /upgrades:U99 error: commit [0-9a-f]+ cites it: upgrades:U99 is not in the upgrades board's spec/u);
});

test('cli.io-spec-boards.commits-that-cite-a-foreign-id-bare: commits that cite a foreign id bare carry a recorded correction that spec check reads [S8]', async (t) => {
  const box = boardsBox(t);
  const bare = pastCommit(box, 'feat(web): carry upgrades [U94]');
  const before = await box.spec('check');
  assert.equal(before.status, 1);
  assert.match(before.stdout, /U94 error: commit [0-9a-f]+ cites it, but it was never committed to the spec/u);

  mkdirSync(join(box.root, '.pullboard'), { recursive: true });
  writeFileSync(join(box.root, CITATIONS_FILE), `${JSON.stringify({ commit: bare, cites: 'U94', means: 'upgrades:U94' })}\n`);
  const after = await box.spec('check');
  assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);
  assert.equal(parseSpec(readFileSync(join(box.root, 'SPEC.md'), 'utf8')).rows.some((row) => row.id === 'U94'), false, 'no SPEC.md row');

  // A correction only qualifies a citation; mapping it onto a bare id would alias it, so it is refused.
  writeFileSync(join(box.root, CITATIONS_FILE), `${JSON.stringify({ commit: bare, cites: 'U94', means: 'G1' })}\n`);
  const alias = await box.spec('check');
  assert.equal(alias.status, 1);
  assert.match(alias.stdout, /citations\.jsonl:1 needs/u);
});

test('cli.io-spec-boards.a-named-board-whose-spec-is-not: a named board whose spec is not on this machine warns and leaves its citations unresolved [S8]', async (t) => {
  const box = boardsBox(t, { reachable: false });
  pastCommit(box, 'feat(web): carry upgrades [upgrades:U94]');
  const result = await box.spec('check');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /warning: the upgrades board's spec is not at .*; upgrades:<id> citations are not resolved on this machine/u);
});
