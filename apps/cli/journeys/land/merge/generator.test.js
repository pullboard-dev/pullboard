/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/generated/docs.js apps/cli/tests/fixtures/move/registry/baseline.json docs/api.md docs/tools/update-docs.js */
/** A failing doc generator blocks landing, apart from merge.test.js so each fits its file limit under pull [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { json } from '../../../tests/fixtures/land/board.js';
import { makeMergeBoard } from '../../../tests/fixtures/land/merge-board.js';
import { fixtureProjectPolicy } from '../../../tests/fixtures/testkit.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { boardFixture, accepted, generatedApi } = makeMergeBoard(e2e);

test('a failing doc generator blocks landing without reopening accepted work [B3,R3,C7]', async () => {
  const box = boardFixture();
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('apps/');
  fixtureProjectPolicy(box.repo, { config });
  // Landing runs docs/tools/update-docs.js only where the generated-docs boundary exists.
  mkdirSync(join(box.repo, 'apps/cli/src/io/generated'), { recursive: true });
  mkdirSync(join(box.repo, 'docs/tools'), { recursive: true });
  writeFileSync(join(box.repo, 'apps/cli/src/io/generated/docs.js'), '// generated-docs boundary\n');
  writeFileSync(join(box.repo, 'docs/tools/update-docs.js'), 'process.exit(7);\n');
  writeFileSync(join(box.repo, 'docs/api.md'), generatedApi('base'));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure failing private generator');
  const left = accepted(box, 1, { 'docs/api.md': generatedApi('left') });
  const right = accepted(box, 2, { 'test/snapshot.json': '{"base":true,"right":true}\n' }); // a different file, so the merge is clean and only the generator step fails
  const before = box.git(box.repo, 'rev-parse', 'main');
  const result = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  const settled = await settleLand(box, JSON.parse(result.out));
  assert.deepEqual(settled.landed, [], JSON.stringify(settled.landJob));
  // The generator refusal names the generator command; it is the one landing step that runs it (packages/landing/src/io/docs.js).
  assert.match(String(settled.landJob.receipt.detail), /node docs\/tools\/update-docs\.js failed in the merged tree/u);
  for (const id of [left, right]) assert.equal(json(box, box.repo, 'show', String(id)).item_status, 'verified');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), before, 'generator failure publishes nothing');
});
