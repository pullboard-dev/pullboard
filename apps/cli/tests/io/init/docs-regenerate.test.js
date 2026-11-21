/** @pullboard-test-input docs-tree */
/** @pullboard-test-input apps/cli/src/io/documentation/*.json */
/** @pullboard-test-input apps/cli/src/io/documentation/events/*.json */
/** @pullboard-test-input apps/cli/src/io/command-docs/*.json */
/** @pullboard-test-input docs/tools/update-docs.js */
/** With docs.regenerateOnCommit on, the pre-commit step regenerates the generated documentation copies and stages them [C7,#9664]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regenerateStagedDocs } from '../../../index.js';
import { openBoard } from '../../../../../packages/board/index.js';
import { GENERATED_DOC_PATHS } from '../../../../../packages/merge/index.js';
import { docsRepository } from '../../fixtures/generated/docs.js';
import { addDocumentedCommand } from '../../fixtures/generated/docs.js';

// The command-line child below only adds the fixture's declarations and checks the result of the in-process regeneration (#8276).
test('cli.journeys-init-docs-regenerate.a-commit-that-adds-declarations-leaves: clause 1: a commit that adds declarations leaves the generated copies matching update-docs output once regenerateStagedDocs ran [C7,#9664]', t => {
  const box = docsRepository(t);
  addDocumentedCommand(box, 'fixture-regen');
  box.git('add', '.');
  box.git('reset', '-q', 'HEAD', '--', ...GENERATED_DOC_PATHS);
  box.git('checkout', '--', ...GENERATED_DOC_PATHS);
  assert.notEqual(box.node('docs/tools/update-docs.js', '--check').status, 0, 'the staged declarations leave the copies stale');
  const notes = regenerateStagedDocs(box.root, { openBoard });
  assert.ok(notes.some(note => note.includes('docs/formats.md')), notes.join('\n'));
  // The command shapes in api.md come from the running checkout's code, so only the declaration-built copy is compared with the box's own output.
  const printed = box.node('docs/tools/update-docs.js', '--print', 'docs/formats.md');
  assert.equal(printed.status, 0, printed.context);
  assert.equal(readFileSync(join(box.root, 'docs/formats.md'), 'utf8'), printed.stdout, 'docs/formats.md matches update-docs output');
  assert.ok(box.git('diff', '--cached', '--name-only').split('\n').includes('docs/formats.md'), 'docs/formats.md is staged');
  assert.ok(!regenerateStagedDocs(box.root, { openBoard }).some(note => note.includes('docs/formats.md')), 'a second run leaves formats.md alone');
});

test('cli.journeys-init-docs-regenerate.a-commit-that-touches-no-declaration: clause 1: a commit that touches no declaration source regenerates nothing [C7,#9664]', t => {
  const box = docsRepository(t);
  writeFileSync(join(box.root, 'notes.txt'), 'plain\n');
  box.git('add', '.');
  assert.deepEqual(regenerateStagedDocs(box.root, { openBoard }), []);
});
