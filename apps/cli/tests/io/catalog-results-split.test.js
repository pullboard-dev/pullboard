/** The catalog's single results case is split in two by command root, and no root is dropped [A1,C7,#9750]. @pullboard-test-input source-cell cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogCases } from '../fixtures/catalog/cases.js';
import { catalogGroups } from '../fixtures/catalog/cases.js';

/** The roots the one results case declared before the split. */
const ORIGINAL_ROOTS = ['add', 'agents', 'answer', 'badge', 'blueprint', 'capacity', 'check', 'claim', 'decisions', 'doctor', 'doctrine', 'done', 'edit', 'escalate', 'fact', 'forget', 'gate', 'health', 'heartbeat', 'help', 'hold', 'hook', 'hooks', 'inbox', 'init', 'join', 'lanes', 'ledger', 'lifecycle', 'list', 'log', 'merged', 'next', 'pass', 'patch', 'prompt', 'refreeze', 'release', 'request', 'resources', 'resume', 'run', 'settings', 'shout', 'show', 'skills', 'spec', 'stats', 'status', 'submit', 'sweep', 'tour', 'verify', 'version', 'whoami', 'why', 'withdraw', 'worktree'];

test('clause 1: catalogCases holds two results cases whose roots together equal the roots the single results case covered [A1,C7,#9750]', () => {
  const results = catalogCases.filter(({ name }) => catalogGroups.results.some(grouped => grouped.name === name));
  assert.equal(results.length, 2, 'the results group holds exactly two cases');
  const union = [...new Set(results.flatMap(({ roots }) => roots))].sort();
  assert.deepEqual(union, [...ORIGINAL_ROOTS].sort());
  for (const { roots, name } of results) assert.ok(roots.length < ORIGINAL_ROOTS.length, `"${name}" covers only part of the roots`);
  const keys = [...new Set(results.flatMap(({ covers }) => covers))];
  assert.equal(keys.length, results.flatMap(({ covers }) => covers).length, 'no covered key is listed in both cases');
});
