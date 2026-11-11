/** @pullboard-world-pin: clause 2 reads this repo's own .githooks/pre-commit to prove its static check runs inside the hook process. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../../..');

test('clause 2: the repo pre-commit starts one node, the hook CLI, and names its static check for that process [C7]', async () => {
  const script = readFileSync(join(ROOT, '.githooks/pre-commit'), 'utf8');
  const commands = script.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
  const nodes = commands.filter(line => /(?:^|\s)node\s/u.test(line));
  assert.equal(nodes.length, 1, `one node process per pre-commit:\n${script}`);
  const match = /^PULLBOARD_HOOK_STATIC=(\S+) exec node "\$root\/apps\/cli\/pullboard\.js" hook pre-commit$/u.exec(nodes[0].trim());
  assert.ok(match, `the only node is the hook CLI, given the static check to run in its own process:\n${nodes[0]}`);
  assert.ok(existsSync(join(ROOT, match[1])), `${match[1]} exists`);
  const { stagedHookFailures } = await import(pathToFileURL(join(ROOT, match[1])).href);
  assert.equal(typeof stagedHookFailures, 'function', 'the named module exports the staged check the hook calls');
});
