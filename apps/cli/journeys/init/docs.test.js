/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/command-docs/heartbeat.json apps/cli/src/logic/help/additions.js docs/api.md docs/cli-help.txt docs/formats.md docs/tools/update-docs.js */
/** @pullboard-test-input docs-tree */
/** @pullboard-test-input apps/cli/src/io/documentation/*.json */
/** @pullboard-test-input apps/cli/src/io/documentation/events/*.json */
/** @pullboard-test-input apps/cli/src/io/command-docs/*.json */
/** @pullboard-test-input docs/tools/update-docs.js */
/** Generated copies drift visibly and independent additions merge without builder resolutions [C7,V4,A1,A5,M1,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { copyPackageSubset } from '../../tests/fixtures/copy.js';
import { createHash } from 'node:crypto';
import { generatedDocDrift } from '../../index.js';
import { openBoard } from '../../../lib/index.js';
import { GENERATED_DOC_PATHS } from '../../../../packages/merge/index.js';
import { resolveMechanicalIndex } from '../../../../packages/merge/index.js';
import { mechanicalConflictFiles } from '../../../../packages/merge/index.js';
import { recordedTrunkMerge } from '../../../../packages/merge/index.js';
import { refreshLandingDocs } from '../../../../packages/landing/index.js';
import { computedConflictFields } from '../../../../packages/landing/index.js';
import { reopen as reopenMove } from '../../../../packages/moves/index.js';
import { GENERATED_DOCS_ENGINE } from '../../../../packages/state/light.js';
import { MECHANICAL_MERGE_ENGINE } from '../../../../packages/state/light.js';
import { SOURCE_ADVANCE_ENGINE } from '../../../../packages/state/light.js';
import { docsRepository } from '../../tests/fixtures/generated/docs.js';
import { addDocumentedCommand } from '../../tests/fixtures/generated/docs.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

test('committed documentation matches all source declarations [C7,A1,A5,M1]', () => {
  assert.deepEqual(generatedDocDrift(join(import.meta.dirname, '../../../..'), undefined, { openBoard }), [], 'run node docs/tools/update-docs.js');
});

test('one command detects and repairs each stale output while retaining authored prose [C7,A1,A5,M1]', t => {
  const box = docsRepository(t);
  for (const file of GENERATED_DOC_PATHS) {
    const path = join(box.root, file), before = readFileSync(path, 'utf8');
    const changed = ['docs/formats.md', 'docs/api.md'].includes(file)
      ? before.replace(/^(\| ---[^\n]*\n)/mu, '$1| stale generated cell | stale |\n')
      : before + (file.endsWith('.js') ? '\n// stale generated output\n' : '\nstale generated output\n');
    assert.notEqual(changed, before, `${file} was actually changed`);
    writeFileSync(path, changed);
    const failed = box.node('docs/tools/update-docs.js', '--check');
    assert.equal(failed.status, 1, failed.context);
    assert.ok(failed.stderr.includes(file), `${file} is named`);
    assert.equal(readFileSync(path, 'utf8'), changed, '--check never writes');
    assert.equal(box.node('docs/tools/update-docs.js').status, 0);
    assert.equal(readFileSync(path, 'utf8'), before, `${file} restored exactly`);
  }
  const api = join(box.root, 'docs/api.md');
  const prose = readFileSync(api, 'utf8').replace('#', 'Authored introduction.\n\n#');
  writeFileSync(api, prose);
  assert.equal(box.node('docs/tools/update-docs.js').status, 0);
  assert.equal(readFileSync(api, 'utf8'), prose, 'authored text outside generated tables survives');
  assert.deepEqual(JSON.parse(box.node('docs/tools/update-docs.js', '--json').stdout).changed, [], 'second refresh is idempotent');
});

test('two command items from one main regenerate real Git conflicts without a builder edit [C7,V4,A1,A5]', t => {
  const box = docsRepository(t), base = box.git('rev-parse', 'HEAD');
  box.git('checkout', '-qb', 'alpha');
  addDocumentedCommand(box, 'fixture-alpha');
  box.git('add', '.'); box.git('commit', '-qm', 'alpha command declaration');
  const alpha = box.git('rev-parse', 'HEAD');
  box.git('checkout', '-qb', 'beta', base);
  addDocumentedCommand(box, 'fixture-beta');
  box.git('add', '.'); box.git('commit', '-qm', 'beta command declaration');
  const beta = box.git('rev-parse', 'HEAD');
  const historical = recordedTrunkMerge(join(box.root, '.git'), alpha, beta, { version: 2 });
  assert.ok(historical.includes('apps/cli/src/logic/help/additions.js'), 'old policy retains its actual historical conflict');
  assert.equal(recordedTrunkMerge(join(box.root, '.git'), alpha, beta, { version: 3 }), null, 'new policy proves generated-only conflicts mechanically');
  assert.deepEqual(mechanicalConflictFiles(box.root, alpha, beta), [], 'health uses the same current policy');
  const merged = runFixtureChild('git', ['merge', '--no-commit', '--no-ff', 'alpha'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(merged.status, 1, 'plain Git really produced generated-output conflicts');
  const files = box.git('diff', '--name-only', '--diff-filter=U').split('\n');
  assert.ok(files.includes('docs/api.md') && files.includes('apps/cli/src/logic/help/additions.js'));
  assert.ok(files.every(file => GENERATED_DOC_PATHS.includes(file)), 'source additions merge without shared registry edits');
  const resolved = resolveMechanicalIndex(box.root, files);
  assert.deepEqual(resolved.files, [], JSON.stringify(resolved));
  assert.equal(resolved.failed, undefined, JSON.stringify(resolved));
  refreshLandingDocs(box.root);
  box.git('add', '.'); box.git('commit', '-qm', 'normal generated landing merge');
  assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'actual two-parent merge retained');
  assert.equal(box.node('docs/tools/update-docs.js', '--check').status, 0);
  for (const name of ['fixture-alpha', 'fixture-beta']) {
    const result = box.node('apps/cli/pullboard.js', name, '--json');
    assert.equal(result.status, 0, result.context);
    assert.equal(JSON.parse(result.stdout).fixture, name, 'the actual new command remains callable');
    const help = box.node('apps/cli/pullboard.js', 'help', name);
    assert.equal(help.status, 0, help.context);
    assert.ok(help.stdout.includes(`Usage: pullboard ${name}`));
    assert.ok(readFileSync(join(box.root, 'docs/api.md'), 'utf8').includes(`| \`${name}\` |`));
    assert.ok(readFileSync(join(box.root, 'docs/formats.md'), 'utf8').includes(`| \`${name}\` |`));
    assert.ok(readFileSync(join(box.root, 'docs/cli-help.txt'), 'utf8').includes(`pullboard ${name}`));
  }
});

test('authored narrative conflicts stay real while v1/v2 receipts retain their engine floors [C7,H16]', t => {
  const box = docsRepository(t), base = box.git('rev-parse', 'HEAD'), file = join(box.root, 'docs/api.md');
  const original = readFileSync(file, 'utf8');
  box.git('checkout', '-qb', 'left'); writeFileSync(file, original.replace(/^#[^\n]+/u, '# Left narrative'));
  box.git('add', '.'); box.git('commit', '-qm', 'left prose'); const left = box.git('rev-parse', 'HEAD');
  box.git('checkout', '-qb', 'right', base); writeFileSync(file, original.replace(/^#[^\n]+/u, '# Right narrative'));
  box.git('add', '.'); box.git('commit', '-qm', 'right prose'); const right = box.git('rev-parse', 'HEAD');
  assert.deepEqual(mechanicalConflictFiles(box.root, left, right), ['docs/api.md']);
  const fields = { version: 3, id: '11111111-1111-4111-8111-111111111111', board: 'a'.repeat(32), item: 1,
    actor: 'fixture', head: left, trunk: right, files: ['docs/api.md'], at: '2026-10-28T00:00:00.000Z', submission: 1 };
  const receipt = { ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
  assert.deepEqual(computedConflictFields(receipt), receipt);
  assert.equal(computedConflictFields({ ...receipt, version: 5 }), null);
  assert.equal(reopenMove.minimumEngine([1, { computedConflict: receipt }]), GENERATED_DOCS_ENGINE);
  assert.equal(reopenMove.minimumEngine([1, { sourceAdvanceReturn: {} }]), SOURCE_ADVANCE_ENGINE);
  assert.equal(reopenMove.minimumEngine([1, { sourceAdvanceReturn: {}, computedConflict: receipt }]),
    Math.max(SOURCE_ADVANCE_ENGINE, GENERATED_DOCS_ENGINE));
  assert.equal(reopenMove.minimumEngine([1, { computedConflict: { version: 2 } }]), MECHANICAL_MERGE_ENGINE);
  assert.ok(reopenMove.minimumEngine([1, { computedConflict: { version: 1 } }]) < MECHANICAL_MERGE_ENGINE);
});

test('duplicate or symlinked command declarations refuse before any generated copy changes [C7,A1]', t => {
  const box = docsRepository(t);
  const copies = new Map(GENERATED_DOC_PATHS.map(file => [file, readFileSync(join(box.root, file))]));
  const file = join(box.root, 'apps/cli/src/io/command-docs/duplicate.json');
  copyPackageSubset(resolve(import.meta.dirname, '../../../..'), box.root,
    [{ path: 'apps/cli/src/io/command-docs/heartbeat.json', as: 'apps/cli/src/io/command-docs/duplicate.json' }]);
  assert.notEqual(box.node('docs/tools/update-docs.js').status, 0);
  for (const [name, bytes] of copies) assert.deepEqual(readFileSync(join(box.root, name)), bytes);
  unlinkSync(file);
  symlinkSync(join(box.root, 'apps/cli/src/io/command-docs/heartbeat.json'), file);
  assert.notEqual(box.node('docs/tools/update-docs.js').status, 0);
  for (const [name, bytes] of copies) assert.deepEqual(readFileSync(join(box.root, name)), bytes);
});
