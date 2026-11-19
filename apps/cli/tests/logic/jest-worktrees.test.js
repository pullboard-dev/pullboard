/** doctor names a Jest project whose test paths would scan the seat worktrees, and says nothing when the config ignores them or jest is not the test script [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jestWorktreeProblem } from '../../src/logic/jest-worktrees.js';

const JEST_PACKAGE = JSON.stringify({ scripts: { test: 'jest --ci' } });

test('cli.logic-jest-worktrees.unignored-names-fix: clause 1: jestWorktreeProblem, given a jest test script and a Jest config with no ignore entry covering the seat worktrees folder, returns one problem naming the entry to add [C7,#11848]', () => {
  for (const config of [undefined, '', 'module.exports = { testEnvironment: "node" };',
    'module.exports = { testPathIgnorePatterns: ["/node_modules/"] };',
    'module.exports = { testPathIgnorePatterns: ["<rootDir>/dist/"], testMatch: ["**/.claude/worktrees/**"] };']) {
    const problem = jestWorktreeProblem(JEST_PACKAGE, config);
    assert.equal(problem?.code, 'JEST_SCANS_WORKTREES', String(config));
    assert.match(problem.next, /<rootDir>\/\.claude\/worktrees\/.*testPathIgnorePatterns/u);
  }
});

test('cli.logic-jest-worktrees.ignored-or-not-jest: clause 2: a config whose ignore covers the seat worktrees folder, or a test script that runs no jest, returns no problem [C7,#11848]', () => {
  assert.equal(jestWorktreeProblem(JEST_PACKAGE, 'module.exports = { testPathIgnorePatterns: ["/node_modules/", "<rootDir>/.claude/worktrees/"] };'), null);
  assert.equal(jestWorktreeProblem(JEST_PACKAGE, 'export default { modulePathIgnorePatterns: [\'<rootDir>/.claude/worktrees/\'] };'), null);
  assert.equal(jestWorktreeProblem(JEST_PACKAGE, '{"testPathIgnorePatterns": ["<rootDir>/.claude/worktrees"]}'), null);
  assert.equal(jestWorktreeProblem(JSON.stringify({ scripts: { test: 'node --test' } }), undefined), null);
  assert.equal(jestWorktreeProblem(JSON.stringify({ scripts: { test: 'vitest run' } }), ''), null);
  assert.equal(jestWorktreeProblem(JSON.stringify({ scripts: { test: 'npx jest' } }), '')?.code, 'JEST_SCANS_WORKTREES');
  assert.equal(jestWorktreeProblem('not json', ''), null);
  assert.equal(jestWorktreeProblem(undefined, ''), null);
});
