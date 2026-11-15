/** Shared private-project builder for the submit registry guard journeys [C7,V4,V16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { fixtureAdd } from './testkit.js';

export const e2e = createE2eHelpers();

/** Write a private fixture input without changing the repository under test. */
export function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Commit through the private board's real installed hooks. */
export function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
}

/** Set accepted registry policy and one real move guard with no JavaScript import edge to new leaves. */
export async function registryBox({ deferred = true } = {}) {
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('src/', 'test/', 'pullboard.json', 'apps/cli/journeys/relay/credential.test.js');
  config.affectedTests = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap';
  config.submitGate = 'landing';
  config.submitDeferAbove = 1;
  if (!deferred) { delete config.submitGate; delete config.submitDeferAbove; }
  config.registryGuards = [{ inputs: ['src/moves/**'], tests: ['apps/cli/journeys/relay/credential.test.js'] }];
  put(box.repo, 'pullboard.json', JSON.stringify(config));
  put(box.repo, 'package.json', '{"type":"module"}\n');
  put(box.repo, 'src/moves/known.js', 'export const operation = "known";\n');
  put(box.repo, 'apps/cli/journeys/relay/credential.test.js', [
    "import { readdirSync } from 'node:fs';",
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "test('each move has an actor credential [G1]', () => {",
    "  const credentials = new Set(['known.js']);",
    "  for (const move of readdirSync(new URL('../../../../src/moves/', import.meta.url)))",
    "    assert.ok(credentials.has(move), 'missing actor credential for ' + move);",
    '});',
  ].join('\n'));
  put(box.repo, 'web/item.test.js', "import { test } from 'node:test';\ntest('item works [G1]', () => {});\n");
  commit(box, box.repo, 'test: accepted registry policy');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const made = (await fixtureAdd(box.runLocal, box.repo, 'web', 'new move fixture', '--specs', 'G1',
    '--criterion', 'The item and its registry obligations pass.', '--check', 'node --test web/item.test.js', '--json'));
  assert.equal(made.code, 0, made.err + made.out);
  const id = JSON.parse(made.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  return { ...box, id };
}
