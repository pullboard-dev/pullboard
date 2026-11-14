/** @pullboard-test-input docs/formats.md packages/config/src/logic/json.js packages/spec/src/logic/grammar.js packages/store/src/io/board/schema/source.js */
/** @pullboard-test-input packages/state/src/io/formats/*.json */
/** Real train merges retain additive registry changes and refuse edits [B3,R3,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { copyPackageSubset } from '../../tests/fixtures/copy.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { json } from '../../tests/fixtures/land/board.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import {
  mergeMechanicalSources,
  resolveMechanicalMerge,
} from '../../../../packages/merge/index.js';
import {
  discoverFormats,
  formatTable,
  writeFormatTable,
} from '../../../../packages/state/index.js';
import { discoverMoves } from '../../../../packages/moves/index.js';
import {
  GATE_SLOT_HELD_ENV,
  GATE_SLOT_POOL_ENV,
  GATE_SLOT_TOKEN_ENV,
  BROWSER_SLOT_HELD_ENV,
} from '../../../../packages/resources/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const FILE = 'src/api-moves.js';
const BASE = "const MOVES = {\n  base: { item: true },\n};\nexport { MOVES };\n";

/** Create a real private board and remote whose web builders own the fixture registry. */
function project(parallel = false) {
  const box = e2e.project('true');
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.lanes.web.owns.push('src/');
  config.affectedTests = 'true';
  if (parallel) {
    config.landing = { ...config.landing, manualOverride: true, parallel: true };
    for (const key of [GATE_SLOT_HELD_ENV, GATE_SLOT_POOL_ENV, GATE_SLOT_TOKEN_ENV, BROWSER_SLOT_HELD_ENV]) delete box.env[key];
  }
  writeFileSync(path, JSON.stringify(config, null, 2));
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, FILE), BASE);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: configure private train registry');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return { ...box, remote };
}

/** Submit and independently verify a real item from its own private checkout. */
async function item(t, box, number, text) {
  const path = join(box.dir, `builder-${number}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
  json(box, path, 'join', 'web', '--model', 'fixture-model');
  const added = json(box, box.repo, 'add', 'web', `Registry addition ${number}`, '--specs', 'G1',
    '--criterion', 'retain this registry entry', '--check', 'true', '--accept-green', 'the fixture check is a passing guard', '--brief', 'Files: src/registry.js\nTest: the registry keeps this entry');
  const id = added.item.item_id;
  json(box, path, 'claim', String(id));
  writeFileSync(join(path, FILE), text);
  const commit = e2e.commitFile(box, path, FILE, text, `feat(web): registry addition ${number} [G1]`);
  assert.equal(commit.status, 0, commit.stderr);
  const head = box.git(path, 'rev-parse', 'HEAD');
  await settleSubmit(t, box, json(box, path, 'submit', String(id)));
  box.git(box.repo, 'checkout', '-q', '--detach', head);
  try { json(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'private registry item checked'); }
  finally { box.git(box.repo, 'checkout', '-q', 'main'); }
  return id;
}

test('non-UTF8 bytes outside a registry stay untouched when resolution is refused [B3,R3,C7]', () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'raw-registry');
  mkdirSync(join(root, 'src'), { recursive: true });
  box.git(root, 'init', '-q', '-b', 'main');
  const source = text => Buffer.concat([Buffer.from([0xff]), Buffer.from('\n' + text)]);
  writeFileSync(join(root, FILE), source(BASE));
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: preserve raw private registry');
  const base = box.git(root, 'rev-parse', 'HEAD');
  for (const name of ['alpha', 'beta']) {
    box.git(root, 'checkout', '-q', '--detach', base);
    writeFileSync(join(root, FILE), source(BASE.replace('  base:', `  ${name}: { item: true },\n  base:`)));
    box.git(root, 'add', '-A');
    box.git(root, 'commit', '-q', '-m', `chore: add ${name} to raw private registry`);
    box.git(root, 'tag', name);
  }
  box.git(root, 'checkout', '-q', '--detach', 'alpha');
  assert.notEqual(box.tryGit(root, 'merge', '--no-edit', 'beta').status, 0);
  const before = readFileSync(join(root, FILE));
  assert.equal(resolveMechanicalMerge(root, [FILE]), null);
  assert.deepEqual(readFileSync(join(root, FILE)), before, 'refusal preserves every byte of the unmerged working file');
});

test('a registry edit remains a conflict and reopens instead of being unioned [B3,R3,C7]', async t => {
  const box = project();
  const first = await item(t, box, 1, BASE.replace('item: true', 'item: false'));
  const second = await item(t, box, 2, BASE.replace('item: true', "positions: ['id']"));
  const landed = await settleLand(box, json(box, box.repo, 'land'));
  // The pulled lander merges in its own order; the item that merges second is the one the registry edit conflicts with.
  const conflict = (landed.returned ?? []).find(entry => entry.reason === 'conflict');
  assert.ok(conflict && [first, second].includes(conflict.id), JSON.stringify(landed.landJob));
  const winner = conflict.id === first ? second : first;
  assert.equal(json(box, box.repo, 'show', String(conflict.id)).item_status, 'open');
  assert.deepEqual(landed.landed, [winner]);
});

test('mechanical resolution refuses changed context, duplicate disagreements and unknown files [B3,R3,C7]', () => {
  const alpha = BASE.replace('  base:', '  alpha: { item: true },\n  base:');
  const beta = BASE.replace('  base:', '  beta: { item: true },\n  base:');
  assert.ok(mergeMechanicalSources(FILE, BASE, alpha, beta));
  for (const changed of [beta.replace('base: { item: true', 'base: { item: false'), beta + '// changed context\n',
    BASE.replace('  base:', '  alpha: { item: false },\n  base:'),
    BASE.replace('  base:', '  beta: { item: true }; steal(); { item: true },\n  base:')]) {
    assert.equal(mergeMechanicalSources(FILE, BASE, alpha, changed), null);
  }
  assert.equal(mergeMechanicalSources('src/unknown.js', BASE, alpha, beta), null);
  const header = '<!-- format-versions:start -->\n| Format | Version | Version source | Upgrade rule |\n| --- | --- | --- | --- |\n';
  const table = header + '| `base` | `1` | source | preserve |\n<!-- format-versions:end -->\n';
  const inserted = name => table.replace('| `base`', `| \`${name}\` | \`1\` | source | preserve |\n| \`base\``);
  assert.match(mergeMechanicalSources('docs/formats.md', table, inserted('alpha'), inserted('beta')).source, /`alpha`[\s\S]*`beta`[\s\S]*`base`/u);
  assert.equal(mergeMechanicalSources('docs/formats.md', table, inserted('alpha'), table.replace('`1`', '`2`')), null);
});

test('new format declarations and move files are discovered without a shared registry edit [A5,C7,V4]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-format-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  copyPackageSubset(resolve(import.meta.dirname, '../../../..'), root,
    [...packageFiles(resolve(import.meta.dirname, '../../../..')).filter(file => file.startsWith('packages/state/src/io/formats/')),
      'packages/config/src/logic/json.js', 'packages/spec/src/logic/grammar.js', 'packages/store/src/io/board/schema/source.js'].map(path => ({ path, as: path })));
  mkdirSync(join(root, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(root, 'packages/state/src/logic/engines/fixture-engine.js'), 'export const FIXTURE_ENGINE = 110;\n');
  const original = discoverFormats(root);
  assert.equal(original.length, 5);
  writeFileSync(join(root, 'packages/state/src/io/formats/fixture.json'), JSON.stringify({ name: 'fixture', order: 60,
    version: { kind: 'constant', file: 'src/fixture.js', constant: 'FIXTURE_VERSION' }, source: '`FIXTURE_VERSION`', upgrade: 'preserve' }));
  writeFileSync(join(root, 'src/fixture.js'), 'export const FIXTURE_VERSION = 7;\n');
  assert.equal(discoverFormats(root).find(entry => entry.name === 'fixture').version, 7);
  for (const file of ['../src/fixture.js', '/src/fixture.js', 'packages/spec/src/logic/../grammar.js', 'packages/spec/src/logic//grammar.js']) {
    writeFileSync(join(root, 'packages/state/src/io/formats/fixture.json'), JSON.stringify({ name: 'fixture', order: 60,
      version: { kind: 'constant', file, constant: 'FIXTURE_VERSION' }, source: '`FIXTURE_VERSION`', upgrade: 'preserve' }));
    assert.throws(() => discoverFormats(root), /format version source must name its source module/u, file);
  }
  writeFileSync(join(root, 'packages/state/src/io/formats/fixture.json'), JSON.stringify({ name: 'fixture', order: 60,
    version: { kind: 'constant', file: 'src/fixture.js', constant: 'FIXTURE_VERSION' }, source: '`FIXTURE_VERSION`', upgrade: 'preserve' }));
  rmSync(join(root, 'src/fixture.js'));
  assert.throws(() => discoverFormats(root), /ENOENT.*fixture\.js/u, 'a descriptor cannot name a missing source');
  writeFileSync(join(root, 'src/fixture.js'), 'export const FIXTURE_VERSION = 7;\n');
  mkdirSync(join(root, 'docs'));
  const guide = 'before\n<!-- format-versions:start -->\nstale\n<!-- format-versions:end -->\nafter\n';
  writeFileSync(join(root, 'docs', 'formats.md'), guide);
  assert.equal(writeFormatTable(root), true);
  assert.equal(readFileSync(join(root, 'docs', 'formats.md'), 'utf8'), guide.replace('stale', formatTable(root)));
  assert.equal(writeFormatTable(root), false);
  writeFileSync(join(root, 'src/fixture.js'), 'export const FIXTURE_VERSION = 8;\n');
  assert.equal(writeFormatTable(root), true);
  assert.match(readFileSync(join(root, 'docs', 'formats.md'), 'utf8'), /`fixture` \| `8`/u);
  const moves = join(root, 'moves');
  mkdirSync(moves);
  for (const operation of ['alpha', 'beta']) writeFileSync(join(moves, operation + '.js'),
    `export default {operation: '${operation}', engine: 1, itemIdFirstArgument: false, minimumEngine: () => 1, actor: () => null, nextSteps: {}};\n`);
  assert.deepEqual((await discoverMoves(pathToFileURL(moves + '/'))).operations, ['alpha', 'beta']);
});
