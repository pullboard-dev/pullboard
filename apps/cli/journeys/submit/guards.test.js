/** Registry obligations survive submit deferral and use the project's own runner, driven through the real CLI [C7,V4,V16]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Write a private fixture input without changing the repository under test. */
function put(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Commit through the private board's real installed hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
}

/** Set accepted registry policy and one real move guard with no JavaScript import edge to new leaves. */
async function registryBox({ deferred = true } = {}) {
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

test('submit runs the move registry guard for an item that adds a move and refuses it by name when the credential is missing [C7,V4,V16]', async () => {
  const box = (await registryBox());
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  // An unrelated source change makes the normal import selection exceed its submit budget.
  put(box.web, 'src/other.js', 'export const other = 1;\n');
  for (const number of [1, 2]) put(box.web, `web/other${number}.test.js`,
    "import { other } from '../src/other.js';\nimport { test } from 'node:test';\ntest('other works [G1]', () => {});\n");
  commit(box, box.web, 'feat(core): add fixture move [G1]');
  const submitted = (await box.runLocal(box.web, 'submit', String(box.id)));
  assert.equal(submitted.code, 1, 'a green item check cannot defer a touched registry guard: ' + submitted.out);
  assert.match(submitted.err + submitted.out, /apps\/cli\/journeys\/relay\/credential\.test\.js/u, 'the refusal names the guard');
  assert.match(submitted.err + submitted.out, /missing actor credential for newMove\.js/u, 'the refusal retains the missing entry');
  const state = (await box.runLocal(box.web, 'show', String(box.id), '--json'));
  assert.equal(state.code, 0, state.err);
  assert.equal(JSON.parse(state.out).item_status, 'claimed', 'the rejected proof records no submission');

  // A real repair passes, and its native submission retains the guard among the files actually proved.
  const guard = join(box.web, 'apps/cli/journeys/relay/credential.test.js');
  writeFileSync(guard, readFileSync(guard, 'utf8').replace("['known.js']", "['known.js', 'newMove.js']"));
  commit(box, box.web, 'fix(core): map the fixture actor [G1]');
  const repaired = (await box.runLocal(box.web, 'submit', String(box.id)));
  assert.equal(repaired.code, 0, repaired.err + repaired.out);
  const exported = (await box.runLocal(box.web, 'export', '--json'));
  assert.equal(exported.code, 0, exported.err);
  const event = JSON.parse(exported.out).tables.event.findLast(row => row.event_kind === 'submit');
  assert.ok(JSON.parse(event.event_detail).submissionProof.files.includes('apps/cli/journeys/relay/credential.test.js'));
});

test('full fallback and candidate policy edits cannot omit an accepted registry guard [C7,V4,V16]', async () => {
  const box = (await registryBox({ deferred: false }));
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  // Unknown data forces a full gate, which is deliberately true and does not include this guard.
  put(box.web, 'web/opaque.data', 'forces full fallback\n');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.registryGuards = [];
  config.affectedTests = 'true';
  put(box.web, 'pullboard.json', JSON.stringify(config));
  commit(box, box.web, 'feat(core): add a move with candidate policy edits [G1]');
  const submitted = (await box.runLocal(box.web, 'submit', String(box.id)));
  assert.equal(submitted.code, 1, submitted.out);
  assert.match(submitted.err, /registry guards: apps\/cli\/journeys\/relay\/credential\.test\.js/u);
  assert.match(submitted.err, /missing actor credential for newMove\.js/u);
});

test('affected tests include dirty registry changes without changing HEAD or the real index [C7,V4]', async () => {
  const box = (await registryBox());
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const index = box.git(box.web, 'write-tree').trim();
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.registryGuards = [];
  config.affectedTests = 'true';
  put(box.web, 'pullboard.json', JSON.stringify(config));
  const result = (await box.runLocal(box.web, 'test', '--affected', '--json'));
  assert.equal(result.code, 1, result.err + result.out);
  const output = JSON.parse(result.out);
  assert.ok(output.files.includes('apps/cli/journeys/relay/credential.test.js'));
  assert.match(output.output, /missing actor credential for newMove\.js/u);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(box.git(box.web, 'write-tree').trim(), index);
});
