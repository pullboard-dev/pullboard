/** @pullboard-test-gui */
/** Bounded compile-only binding proof never executes candidate source or weakens shadow uncertainty [C7,CD62]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  machine as snapshotMachine,
  project as snapshotProject,
} from '../../tests/fixtures/cockpit/machine.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readGateReceipt,
  receiptBody,
} from '../../../../packages/gate/index.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  privateFixtureFiles,
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { lex } from '../../../../packages/kernel/index.js';
import {
  bindingReadsForModules,
  localFunctionCallSets,
  readOnlyMemberRanges,
} from '../../../../packages/codemap/index.js';
import { fixtureSourceEdits } from '../../../../packages/codemap/index.js';
import { mainAuditKey } from '../../../../packages/gate/index.js';
import { readAuditJob } from '../../tests/fixtures/main/audit/project.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  mappedWorkingSource,
  workingSourceInventory,
} from '../../../../packages/gate/src/io/scan.js';
import { importsIn } from '../../../../packages/gate/index.js';

const IMPORT = "import { join } from 'node:path';\n";

test('named metadata leaves and complete moved-body tails keep their exact input boundary [C7]', () => {
  const prefix = "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\n";
  const options = { file: 'test/input-boundaries.js', moves: [
    ['packages/git/index.js', 'packages/git/src/io/main.js'],
    ['src/git-launch-baseline.json', 'packages/git/src/io/launch/baseline.json'],
  ] };
  for (const body of [
    "const FILE = 'packages/codemap/data/plan/transition.json'; readFileSync(join(root, FILE));",
    "readFileSync(join(box.repo, 'packages/git/src/io/main.js'));",
  ]) assert.deepEqual(fixtureSourceEdits(prefix + body, options), { edits: [], problems: [] });
  for (const body of [
    "const FILE = 'src/git-launch-baseline.json'; readFileSync(join(root, FILE));",
    "readFileSync(join(root, 'packages/git/index.js'));",
    "readFileSync(join(root, 'packages/../src/git.js'));",
    "const FILE = 'transition.json'; function read(FILE) { readFileSync(join(root, FILE)); }",
    "let FILE = 'transition.json'; FILE = unknown; readFileSync(join(root, FILE));",
  ]) assert.ok(fixtureSourceEdits(prefix + body, options).problems.length, body);
});

test('recursive fixture copies remain explicit inputs even with apparently private path tails [C7]', () => {
  const prefix = "import { cpSync } from 'node:fs'; import { join } from 'node:path';\n";
  const options = { file: 'test/private-copy.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']] };
  for (const body of [
    "cpSync(join(box.root, '.git', 'pullboard'), target, {recursive:true});",
    "cpSync(join(root, 'src'), target, {recursive:true});",
    "cpSync(join(root, 'packages/git/index.js'), target, {recursive:true});",
    "cpSync(join(root, 'git.js'), target, {recursive:true});",
    "cpSync(join(root, '.git', '..', 'src'), target, {recursive:true});",
    "cpSync(box.input, target, {recursive:true});",
  ]) assert.ok(fixtureSourceEdits(prefix + body, options).problems.length, body);
});

test('native receipt input retains exact bytes and rejects missing or changed format [C7]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pb-receipt-format-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = { version: 1, id: '11111111-1111-4111-8111-111111111111', kind: 'gate',
    tree: 'a'.repeat(40), head: 'b'.repeat(40), main: null, command: 'c'.repeat(64), green: true, failures: [],
    load: { average: [0, 0, 0], cpus: 1, freeMB: 1 }, at: '2026-10-28T12:00:00.000Z' };
  const bytes = receiptBody(value);
  assert.equal(typeof bytes, 'string', 'synthetic format input is valid, without claiming native execution');
  const file = join(directory, `${value.id}.json`);
  writeFileSync(file, bytes);
  assert.equal(receiptBody(readGateReceipt(directory, value.id)), bytes);
  assert.equal(readGateReceipt(directory, '22222222-2222-4222-8222-222222222222'), null);
  assert.equal(readGateReceipt(directory, '../untrusted'), null);
  for (const changed of ['{malformed', bytes + '\n', bytes.replace('"green":true', '"green": true')]) {
    writeFileSync(file, changed);
    assert.equal(readGateReceipt(directory, value.id), null, 'same JSON value with altered bytes is not a bound receipt');
  }
});

test('native audit journal input refuses missing, malformed and mismatched identities [C7]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pb-audit-format-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const job = { version: 1, board: 'format-only-board', batchId: 'format-only-batch',
    tip: 'a'.repeat(40), tree: 'b'.repeat(40), state: 'running' };
  const key = mainAuditKey(job);
  const file = join(directory, `${key}.json`);
  assert.throws(() => readAuditJob(directory, key), /actual native audit journal exists/u);
  assert.throws(() => readAuditJob(directory, '../untrusted'), /audit journal identity/u);
  writeFileSync(file, JSON.stringify(job));
  assert.deepEqual(readAuditJob(directory, key), job, 'synthetic schema control makes no runtime-proof claim');
  writeFileSync(file, '{malformed');
  assert.throws(() => readAuditJob(directory, key), SyntaxError);
  writeFileSync(file, JSON.stringify({ ...job, tree: 'c'.repeat(40) }));
  assert.throws(() => readAuditJob(directory, key), /journal binds/u);
  writeFileSync(file, JSON.stringify({ ...job, version: 2 }));
  assert.throws(() => readAuditJob(directory, key), /journal schema/u);
});

test('mapped working source preserves implementation, shim and exact Buffer obligations [C7]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pb-mapped-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'packages', 'git'), { recursive: true });
  const oldPath = 'packages/git/index.js', bodyPath = 'packages/git/light.js';
  const shim = "export * from '../../../../packages/git/light.js';\n";
  const original = Buffer.from([0x2f, 0x2f, 0xff, 0x0a]);
  writeFileSync(join(root, oldPath), shim);
  writeFileSync(join(root, bodyPath), original);
  writeFileSync(join(root, 'path-map.json'), JSON.stringify({ [oldPath]: bodyPath }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Commit only the private fixture's source identity. */
  function git(...args) { return runFixtureGit(args, { cwd: root, env }); }
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'chore: mapped source format');
  const first = mappedWorkingSource(root, oldPath);
  assert.equal(first.implementationPath, bodyPath);
  assert.deepEqual(first.body, original, 'invalid UTF-8 bytes are not decoded and re-encoded');
  assert.deepEqual(first.shimBody, Buffer.from(shim));
  writeFileSync(join(root, bodyPath), "import 'node:child_process';\n");
  const changed = mappedWorkingSource(root, oldPath);
  assert.notDeepEqual(changed.body, first.body, 'changed implementation is visible even with an unchanged shim');
  assert.deepEqual(changed.shimBody, first.shimBody);
  const edges = importsIn([changed.body.toString('utf8')])[0];
  assert.ok(edges.includes('node:child_process'), 'the actual graph parser sees the changed implementation');
  assert.throws(() => assert.ok(!edges.includes('node:child_process')), 'the unchanged process-free invariant refuses that body');
  writeFileSync(join(root, oldPath), shim + '// changed shim\n');
  assert.notDeepEqual(mappedWorkingSource(root, oldPath).shimBody, first.shimBody, 'copy equality still observes changed shim bytes');
  assert.throws(() => mappedWorkingSource(root, '../escape'), /identity/u);
  writeFileSync(join(root, 'path-map.json'), '{}');
  assert.throws(() => mappedWorkingSource(root, oldPath), /stale or uncommitted/u);
  git('checkout', '--', 'path-map.json');
  rmSync(join(root, bodyPath));
  assert.throws(() => mappedWorkingSource(root, oldPath), { code: 'ENOENT' });
  symlinkSync(join(root, oldPath), join(root, bodyPath));
  assert.throws(() => mappedWorkingSource(root, oldPath), /contained regular file/u);
  mkdirSync(join(root, 'packages/codemap/data/plan/path-map'), { recursive: true });
  writeFileSync(join(root, 'packages/codemap/data/plan/path-map/duplicate.json'), JSON.stringify({ [oldPath]: bodyPath }));
  git('add', '-A'); git('commit', '-q', '-m', 'chore: ambiguous map format control');
  assert.throws(() => mappedWorkingSource(root, oldPath), { code: 'NO_POLICY' });
});

test('native file URL composition retains the actual repository body and refuses unknown roots [C7]', () => {
  const prefix = "import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {fileURLToPath} from 'node:url';\n";
  const root = "const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));\n";
  const read = "readFileSync(join(ROOT, 'src/local-fetch.js'), 'utf8');";
  const options = { file: 'apps/cli/journeys/init/boundary.test.js', moves: [['src/local-fetch.js', 'packages/sync/src/io/local.js']] };
  const proved = fixtureSourceEdits(prefix + root + read, options);
  assert.deepEqual(proved.problems, []);
  assert.equal(proved.edits.length, 1);
  assert.match(proved.edits[0].text, /packages\/sync\/src\/io\/local\.js/u);
  const moved = read.replace("'src/local-fetch.js'", "'packages/sync/src/io/local.js'");
  assert.deepEqual(fixtureSourceEdits(prefix + root + moved, options), { edits: [], problems: [] });
  const alias = (prefix + root + read).replace('{fileURLToPath}', '{fileURLToPath as nativePath}').replace('= fileURLToPath(', '= nativePath(');
  assert.deepEqual(fixtureSourceEdits(alias, options).problems, []);
  for (const unknown of [
    root.replace("new URL('../../../..', import.meta.url)", 'unknown'),
    root.replace("new URL('../../../..', import.meta.url)", 'new URL(unknown, import.meta.url)'),
    root.replace("'../../../..'", "'https://outside.invalid/source'"),
    root.replace("'../../../..'", "'../%2e/source'"),
    root.replace("'../../../..'", "'../source?query'"),
    root.replace("'../../../..'", "'../source#fragment'"),
    "const URL = unknown;\n" + root,
    root.replace('fileURLToPath(', 'arbitraryPath('),
  ]) assert.ok(fixtureSourceEdits(prefix + unknown + read, options).problems.length, unknown);
});

test('working source inventory retains shim, mapped and private body bytes without source filters [C7]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pb-source-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'packages', 'sample'), { recursive: true });
  const bodyPath = 'packages/sample/body.js', privatePath = 'packages/sample/private.js';
  const shim = "export * from '../packages/sample/body.js';\n";
  const original = Buffer.from([0x2f, 0x2f, 0xff, 0x0a]);
  writeFileSync(join(root, 'src/value.js'), shim);
  writeFileSync(join(root, bodyPath), original);
  writeFileSync(join(root, privatePath), 'export const privateValue = true;\n');
  writeFileSync(join(root, 'bin/check.js'), 'void 0;\n');
  writeFileSync(join(root, 'path-map.json'), JSON.stringify({ 'src/value.js': bodyPath, 'src/private.js': privatePath }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Commit only this real private source map; subsequent working bytes remain actual test inputs. */
  function git(...args) { return runFixtureGit(args, { cwd: root, env }); }
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'chore: working source inventory');
  writeFileSync(join(root, 'src/untracked.js'), 'void 1;\n');
  const rows = workingSourceInventory(root, ['src', 'bin']);
  const byPath = new Map(rows.map(row => [row.file, row.body]));
  assert.deepEqual(byPath.get(bodyPath), original, 'actual invalid UTF-8 bytes are never replaced by a seed or shim');
  assert.deepEqual(byPath.get('src/value.js'), Buffer.from(shim));
  assert.ok(byPath.has(privatePath), 'a mapped body with no surviving old shim remains scanned');
  assert.ok(byPath.has('src/untracked.js'), 'the original working-directory enumeration is not narrowed to Git files');
  const changedBody = "import 'node:https';\n";
  writeFileSync(join(root, bodyPath), changedBody);
  const changed = workingSourceInventory(root, ['src', 'bin']);
  assert.throws(() => assert.deepEqual(changed.filter(row => row.body.includes(Buffer.from('node:https'))), []),
    'the unchanged network guard catches changed implementation bytes even when the shim is unchanged');
  writeFileSync(join(root, 'src/value.js'), "import 'node:net';\n" + shim);
  assert.ok(workingSourceInventory(root, ['src', 'bin']).some(row => row.file === 'src/value.js' && row.body.includes(Buffer.from('node:net'))));
  assert.throws(() => workingSourceInventory(root, ['../outside']), /invalid working source directory/u);
  symlinkSync(tmpdir(), join(root, 'outside'));
  assert.throws(() => workingSourceInventory(root, ['outside']), /contained and regular/u);
  symlinkSync(join(root, 'bin/check.js'), join(root, 'src/linked.js'));
  assert.throws(() => workingSourceInventory(root, ['src']), /contained regular file/u);
});

test('snapshot output capability retains all actual export bytes and refuses foreign roots [C7,N26]', async (t) => {
  const box = snapshotMachine(), alpha = snapshotProject(box, 'private export inputs');
  const output = box.exportSnapshot(alpha.repo, 'owned-export');
  const index = join(output.root, 'index.html');
  assert.deepEqual(output.readFile(index), readFileSync(index), 'HTTP input retains the actual export Buffer');
  mkdirSync(join(output.root, 'extra-source', 'nested'), { recursive: true });
  const secret = Buffer.from(box.dir), raw = Buffer.from([0xff, 0x00, 0xfe]);
  const planted = join(output.root, 'extra-source', 'nested', 'body.js');
  writeFileSync(planted, secret);
  writeFileSync(join(output.root, 'unexpected.lock'), raw);
  const bytes = output.files();
  assert.ok(bytes.some(row => row.file === planted && row.body.equals(secret)), 'nested copied source is never filtered from the privacy audit');
  assert.ok(bytes.some(row => row.body.equals(raw)), 'every extension and invalid UTF-8 Buffer remains covered');
  assert.throws(() => assert.ok(!bytes.map(row => row.body.toString('utf8')).join('\n').includes(box.dir)),
    'the original privacy assertion catches a planted actual private path');
  writeFileSync(planted, 'changed actual export bytes');
  assert.deepEqual(output.readFile(planted), Buffer.from('changed actual export bytes'), 'reads never return seeded or cached output');
  assert.throws(() => output.readFile(join(output.root, 'missing.json')), { code: 'ENOENT' });
  const outsider = mkdtempSync(join(tmpdir(), 'pb-foreign-output-'));
  t.after(() => rmSync(outsider, { recursive: true, force: true }));
  const before = box.invocations.length;
  assert.throws(() => box.exportSnapshot(outsider, 'foreign-export'), /belongs/u);
  assert.throws(() => box.exportSnapshot(alpha.repo, '../escape'), /private leaf/u);
  assert.throws(() => box.exportSnapshot(alpha.repo, 'owned-export'), /fresh/u);
  assert.equal(box.invocations.length, before, 'refused roots never launch a substitute producer');
  assert.throws(() => output.readFile(join(outsider, 'source.js')), /belongs/u);
  assert.throws(() => output.readFile(join(output.root, '..', 'source.js')), /belongs/u);
  symlinkSync(outsider, join(output.root, 'outside'));
  assert.throws(() => output.files(), /contained regular file/u);
});

test('mechanical fixture input owns its origin and reads actual post-component bytes [C7]', (t) => {
  const inputs = privateFixtureFiles('pb-private-input-');
  t.after(() => rmSync(inputs.root, { recursive: true, force: true }));
  const original = Buffer.from([0xff, 0x00, 0x41]);
  inputs.write('src/actual.js', original);
  assert.deepEqual(inputs.read('src/actual.js'), original);
  const changed = Buffer.from("throw new Error('actual component output');\n");
  writeFileSync(join(inputs.root, 'src/actual.js'), changed);
  assert.deepEqual(inputs.read('src/actual.js'), changed, 'the port reads working bytes rather than its own seed or Git/index');
  assert.throws(() => inputs.read('src/unknown.js'), /not owned/u);
  writeFileSync(join(inputs.root, 'unowned.txt'), 'existing unowned input');
  assert.throws(() => inputs.write('unowned.txt', 'replacement'), /not owned/u);
  assert.throws(() => inputs.write('../escape', 'no'), /invalid private fixture file/u);
  assert.throws(() => privateFixtureFiles(inputs.root), /invalid private fixture prefix/u);
  rmSync(join(inputs.root, 'src/actual.js'));
  symlinkSync(join(inputs.root, 'unowned.txt'), join(inputs.root, 'src/actual.js'));
  assert.throws(() => inputs.read('src/actual.js'), /not regular/u);
  assert.throws(() => inputs.write('src/actual.js', 'no'), /not owned/u);
  symlinkSync(join(inputs.root, 'src'), join(inputs.root, 'linked'));
  assert.throws(() => inputs.write('linked/new.txt', 'no'), /ancestor/u);
});

test('relay fixture inputs retain every metadata/source byte and reject foreign roots and keys [C7]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  const boardId = box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const destination = join(box.root, '..', 'input-copy');
  mkdirSync(join(destination, '.git'), { recursive: true });
  const metadata = join(box.root, '.git', 'pullboard');
  const metadataSecret = 'ps_' + 'M'.repeat(43), sourceSecret = 'pg_' + 'S'.repeat(43);
  writeFileSync(join(metadata, 'planted-credential.txt'), metadataSecret);
  writeFileSync(join(metadata, 'excluded.lock'), 'the original copy excludes lock files');
  box.copyOwnBoardMetadata(destination);
  mkdirSync(join(destination, 'copied-source', 'nested'), { recursive: true });
  writeFileSync(join(destination, 'copied-source', 'nested', 'body.js'), sourceSecret);
  const bytes = box.privateTreeBytes(destination);
  assert.ok(bytes.some(value => value.equals(Buffer.from(metadataSecret))), 'metadata credentials remain covered');
  assert.ok(bytes.some(value => value.equals(Buffer.from(sourceSecret))), 'copied source subtree credentials remain covered');
  assert.ok(!bytes.some(value => value.equals(Buffer.from('the original copy excludes lock files'))), 'copy retains exactly its original lock exclusion');
  const home = join(box.root, '..', 'input-copy-home');
  mkdirSync(join(home, 'relay-keys'), { recursive: true });
  box.copyOwnKey(home, boardId);
  const keyHash = createHash('sha256').update(box.readKey()).digest('hex');
  assert.ok(box.privateTreeBytes(home).some(value => createHash('sha256').update(value).digest('hex') === keyHash), 'key copy retains exact actual bytes without printing the secret');
  assert.throws(() => box.copyOwnKey(home, (boardId[0] === 'f' ? 'e' : 'f') + boardId.slice(1)), /exactly this fixture board/u);
  assert.throws(() => box.copyOwnKey(home, '../unknown'), /canonical board/u);
  assert.throws(() => box.copyOwnBoardMetadata(tmpdir()), /fixture origin/u);
  assert.throws(() => box.copyOwnKey(tmpdir(), boardId), /fixture origin/u);
  assert.throws(() => box.privateTreeBytes(tmpdir()), /fixture origin/u);
  symlinkSync(tmpdir(), join(destination, 'escaping-link'));
  assert.throws(() => box.privateTreeBytes(destination), /escaping symlink/u);
});

/** Hide only this actual import declaration, just as the production callers do; every other spelling stays visible. */
function proof(body) {
  const source = IMPORT + body;
  const scanned = lex(source).code;
  const probeBody = ' '.repeat(IMPORT.length - 1) + '\n' + scanned.slice(IMPORT.length);
  return bindingReadsForModules([{ file: 'fixture.js', source, body: probeBody, bindings: [{ local: 'join' }] }]).get('fixture.js').get('join');
}

test('qualified property spellings do not consume binding probes or conceal actual shadow and spread [C7]', () => {
  const properties = Array.from({ length: 240 }, () => "const object = { value: [] }; object.value.join(',');").map(line => `{ ${line} }`).join('\n');
  const body = properties + "\nconst result = join(root, 'actual.json');";
  const row = proof(body);
  assert.equal(row.opaque, null);
  assert.equal(row.potentialShadow, false);
  assert.equal(row.reads.length, 1, 'only the actual imported identifier contributes a read');
  const spread = proof(properties + '\nconst values = [...join];');
  assert.ok(spread.reads.length, 'spread remains an actual binding read');
  const shadow = proof(properties + "\nfunction nested(join) { return join(root, 'unknown'); }");
  assert.equal(shadow.potentialShadow, true);
  const write = proof(properties + '\njoin = replacement;');
  assert.ok(write.potentialShadow || write.opaque, 'an actual write cannot acquire immutable import authority');
});

test('qualified property skipping retains optional namespace receivers and shorthand bindings [C7]', () => {
  const prefix = "import * as path from 'node:path'; import * as fs from 'node:fs'; import {join} from 'node:path';\n";
  const body = "const names = [path?.join(root, 'actual.json'), fs?.readFileSync(input)]; const shorthand = {join};";
  const source = prefix + body;
  const scanned = lex(source).code;
  const probeBody = ' '.repeat(prefix.length - 1) + '\n' + scanned.slice(prefix.length);
  const rows = bindingReadsForModules([{ file: 'namespace.js', source, body: probeBody,
    bindings: [{ local: 'path' }, { local: 'fs' }, { local: 'join' }] }]).get('namespace.js');
  assert.equal(rows.get('path').reads.length, 1, 'optional path receiver is a real capability read');
  assert.equal(rows.get('fs').reads.length, 1, 'optional filesystem receiver is a real capability read');
  assert.equal(rows.get('join').reads.length, 1, 'shorthand retains the actual imported binding');
  const unknown = fixtureSourceEdits(prefix + "fs?.readFileSync(input);", {
    file: 'test/optional-reader.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']],
  });
  assert.ok(unknown.problems.length, 'an optional unknown filesystem read never becomes a success');
});

/** Produce enough real expression calls to exceed the old full-source variant budget without any candidate evaluation. */
function manyCalls() {
  return Array.from({ length: 300 }, (_, index) => `const output${index} = join(root, 'leaf-${index}');`).join('\n');
}

/**
 * Supply exactly one producer's committed bytes: its original identity and, once a cells move maps it, the shim at
 * that identity, its canonical package front door and the body the committed path map names. Why: the fixture bar stays the actual imported producer
 * while a move changes where its body lives, so no move has to edit these cases.
 */
function mappedProducer(identity) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const mapped = mappedWorkingSource(root, identity);
  const files = new Map([[mapped.implementationPath, mapped.body], ...(mapped.shimPath ? [[mapped.shimPath, mapped.shimBody]] : [])]);
  if (mapped.implementationPath.startsWith('packages/seats/')) {
    const front = mappedWorkingSource(root, 'packages/seats/index.js');
    files.set(front.implementationPath, front.body);
  }
  return file => {
    assert.ok(files.has(file) && files.get(file) !== null, 'this fixture supplies exactly its actual imported producer source');
    return { source: files.get(file).toString('utf8'), object: runFixtureGit(['rev-parse', `HEAD:${file}`], { cwd: root }) };
  };
}

/** Read exact regular committed producer bytes from this source-only test checkout, never machine state. */
const sourceSnapshot = file => mappedProducer('packages/seats/src/io/projects.js')(file);

test('actual api-http fixture config reads resolve without changing their source or move proof [C7]', () => {
  assert.throws(() => sourceSnapshot('packages/git/index.js'), /exactly its actual imported producer source/);
  const source = readFileSync(new URL('../shout/http.test.js', import.meta.url), 'utf8');
  const result = fixtureSourceEdits(source, { file: 'apps/cli/journeys/shout/http.test.js',
    moves: [['packages/git/index.js', 'packages/git/src/io/main.js']], readSource: sourceSnapshot });
  assert.deepEqual(result, { edits: [], problems: [] });
});

test('many expression calls avoid variants while distant parameters and destructuring still invalidate binding identity [C7]', () => {
  const calls = manyCalls();
  const direct = proof(calls + "\nthrow new Error('candidate source must never execute');\n");
  assert.equal(direct.opaque, null);
  assert.equal(direct.potentialShadow, false);
  assert.equal(direct.reads.length, 300);
  for (const shadow of ['function nested(join) { return join; }',
    'function nested({ join }) { return join; }', 'try {} catch (join) {}',
    'function nested() { const join = () => 1; return join(); }',
    'join = () => 1;', '({ join } = replacement);']) {
    const row = proof(calls + '\n' + shadow);
    assert.ok(row.potentialShadow || row.opaque, 'the distant lexical declaration still receives the original compiler probes');
  }
});

test('193 ambiguous spellings retain the original per-binding budget refusal [C7]', () => {
  const row = proof(Array.from({ length: 193 }, () => 'const value = { join: 1 };').map((line, index) => line.replace('value', `value${index}`)).join('\n'));
  assert.equal(row.opaque, 'binding analysis complexity budget exceeded');
});

test('properties, methods, optional calls and newline-return fields never become lexical call proofs [C7]', () => {
  for (const source of ['const object = { join() {} };', 'class C { join() {} }',
    'class C { return\njoin() {} }', 'class C { return /*\n*/ join() {} }',
    'const object = {}; object.join();', 'const object = {}; object?.join();']) {
    const row = proof(source);
    assert.equal(row.reads.length, 0, source);
  }
  assert.equal(proof('const values = [...join];').reads.length, 1, 'spread still reads the imported binding');
  const optional = proof('join?.();');
  assert.ok(optional.reads.length || optional.opaque, 'optional invocation retains its original compile-only classification');
});

test('uncertain regex lines retain probes across every physical ECMAScript line boundary [C7]', () => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    for (const regex of ['/(join())/', '/=join()/', '/=>join()/']) {
      const row = proof(`if (true) ${regex}.test('');${separator}const harmless = 1;`);
      assert.ok(row.opaque || row.reads.length === 0, 'regex text cannot prove the imported function is called');
    }
  }
  const divided = proof('const value = 1 / join(2);');
  assert.ok(divided.reads.length || divided.opaque, 'division remains the original compiler decision');
});

test('original modules must compile even when every apparent use could take the lexical path [C7]', () => {
  for (const source of ['const value = join(1); const =', 'const value = join(1); let join;']) {
    const row = proof(source);
    assert.equal(row.reads.length, 0);
    assert.equal(row.opaque, 'original module does not compile within the source budget');
  }
});

/** Use the production recognizer with actual imported readers and module-relative moved paths. */
function recognize(body) {
  const source = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" + body;
  return fixtureSourceEdits(source, { file: 'test/scopes.test.js', moves: [['src/moved.js', 'packages/git/src/io/moved.js']] });
}

test('repeated constants resolve only in their unique containing lexical scope [C7]', () => {
  const result = recognize(`function first() {
    const input = join(import.meta.dirname, '../src/moved.js'); readFileSync(input);
  }
  function second() {
    const input = join(import.meta.dirname, '../config.json'); readFileSync(input);
  }`);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 1);
  assert.match(result.edits[0].text, /packages\/git\/src\/io\/moved\.js/u);
  for (const body of [
    `function outer() { const input = join(import.meta.dirname, '../src/moved.js');
      function inner(input) { readFileSync(input); } }`,
    `function outer() { const input = join(import.meta.dirname, '../src/moved.js');
      input = unknown; readFileSync(input); }`,
    `function outer() { if (flag) { const input = join(import.meta.dirname, '../src/moved.js'); }
      readFileSync(input); }`,
    `function outer() { const input = join(import.meta.dirname, '../config.json');
      { readFileSync(input); const input = join(import.meta.dirname, '../src/moved.js'); } }`,
    `function outer() { switch (flag) { case 0: const input = join(import.meta.dirname, '../src/moved.js');
      break; case 1: readFileSync(input); } }`,
    `function outer() {\nconst input = 'src/moved.js';\nif(true) /{const input='safe.json';/.test('');\nreadFileSync(input);\n}`,
  ]) {
    const uncertain = recognize(body);
    assert.deepEqual(uncertain.edits, []);
    assert.ok(uncertain.problems.length, 'shadows, writes, mixed branches and TDZ remain unsupported');
  }
});

/** Represent one immutable Git blob, as the production snapshot readers do. */
function blob(source) {
  return { source, object: createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex') };
}

test('lazy API imports require exact declared origins and never authorize returned filesystem capabilities [C7]', () => {
  const consumer = "import {readFileSync} from 'node:fs'; const api = await import('../src/api.js'); api.health(); readFileSync('config.json');";
  const options = { file: 'test/lazy-api.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']] };
  const body = "throw new Error('analysis must never execute this');\nexport function health() { return {ok:true}; }\n";
  const sources = { 'src/api.js': "export {health} from './body.js';\n", 'src/body.js': body };
  const inspect = (source = consumer, values = sources) => fixtureSourceEdits(source, { ...options,
    readSource: file => typeof values[file] === 'string' ? blob(values[file]) : null });
  assert.deepEqual(inspect(), { edits: [], problems: [] });
  assert.deepEqual(inspect(consumer, { ...sources, 'src/api.js': "export * from './body.js';\n" }), { edits: [], problems: [] });
  for (const provider of [
    "export {readFileSync as health} from 'node:fs';\n",
    "export * as health from 'node:fs';\n",
    "export const health = unknown;\n",
    "import {readFileSync} from 'node:fs';\nexport function health(file) { return readFileSync(file); }\n",
    "export {health} from './missing.js';\n",
    "export {health} from './cycle.js';\n",
  ]) assert.ok(inspect(consumer, { ...sources, 'src/api.js': provider,
    'src/cycle.js': "export {health} from './api.js';\n" }).problems.length, provider);
  const returned = "export function health() { return unknownCapability; }\n";
  for (const use of [
    "api.health().readFileSync(input);",
    "const fs = api.health(); fs?.readFileSync(input);",
    "api.health()['readFileSync'](input);",
    "const {readFileSync: read} = api.health(); read(input);",
    "api.health().copyFileSync(input, output);",
    "const key = unknown; api.health()[key](input);",
    "Reflect.get(api.health(), unknown)(input);",
    "const {[unknown]: read} = api.health(); read(input);",
  ]) assert.ok(inspect(consumer + use, { 'src/api.js': returned }).problems.length, use);
  const forged = fixtureSourceEdits(consumer, { ...options, readSource: () => ({ source: body, object: '0'.repeat(40) }) });
  assert.ok(forged.problems.length);
  assert.ok(inspect(consumer, { 'src/api.js': 'export function health( {' }).problems.length, 'malformed exact blobs remain refused');
  const common = fixtureSourceEdits("const api = require('../src/api.js'); api.health();", { ...options, readSource: file => blob(body) });
  assert.ok(common.problems.length, 'CommonJS never acquires ESM source-origin authority');
});

test('fixed-leaf producers follow canonical named shims but refuse unresolved or ambiguous star origins [C7]', () => {
  const consumer = "import {readFileSync} from 'node:fs'; import {locate} from '../src/shim.js'; readFileSync(locate(info));";
  const sources = { 'src/shim.js': "export {leaf as locate} from '../packages/git/index.js';\n",
    'packages/git/index.js': "export * from './body.js';\n",
    'packages/git/body.js': "import {join} from 'node:path';\nexport function leaf(info) { return join(info.commonDir, 'settings.json'); }\n" };
  const options = { file: 'test/shim-producer.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']] };
  const inspect = values => fixtureSourceEdits(consumer, { ...options, readSource: file => values[file] ? blob(values[file]) : null });
  assert.deepEqual(inspect(sources), { edits: [], problems: [] });
  assert.ok(inspect({ ...sources, 'packages/git/index.js': "export * from './body.js';\nexport * from './missing.js';\n" }).problems.length);
  assert.ok(inspect({ ...sources, 'packages/git/index.js': "export * from './body.js';\nexport * from './other.js';\n",
    'packages/git/other.js': sources['packages/git/body.js'] }).problems.length);
});

test('all original git-move fixture groups retain their actual source input obligations [C7]', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const plan = JSON.parse(readFileSync(new URL('../../../../packages/codemap/data/plan/02-git.json', import.meta.url), 'utf8'));
  const captured = new Map();
  /** Capture exact regular committed producer bytes, without executing or normalizing their source. */
  function readSource(file) {
    if (captured.has(file)) return captured.get(file);
    if (!/^[\w./-]+$/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const listed = runFixtureGit(['ls-tree', '-z', head, '--', file], { cwd: root });
    const object = /^100(?:644|755) blob ([a-f0-9]+)\t/u.exec(listed)?.[1];
    if (!object) return null;
    const result = runFixtureChild('git', ['show', `${head}:${file}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.failure);
    const value = { source: result.stdout, object };
    captured.set(file, value);
    return value;
  }
  for (const file of ['apps/cli/journeys/fact/board/busy.test.js', 'packages/runners/tests/lints.test.js', 'apps/cli/journeys/fact/e2e/audit.test.js',
    'apps/cli/tests/fixtures/landing/queue.js', 'apps/cli/journeys/land/merge.test.js', 'apps/cli/journeys/move/registry.test.js',
    'apps/cli/journeys/fact/receipts.test.js', 'apps/cli/tests/fixtures/evidence.js', 'apps/cli/journeys/relay/canary.test.js',
    'apps/cli/journeys/runner/policy.test.js',
    'apps/cli/journeys/fact/team/host.test.js',
    'apps/cli/journeys/queue/team/policy.test.js',
    'apps/cli/journeys/queue/team/freshness.test.js',
    'apps/cli/journeys/fact/team/owner/death.test.js',
    'apps/cli/journeys/fact/team/owner/death-guardian.test.js',
    'apps/cli/journeys/fact/team/owner/fence.test.js',
    'apps/cli/journeys/export/team/board.test.js',
    'apps/cli/journeys/verify/team/verdict.test.js',
    'apps/cli/journeys/verify/team/repair.test.js',
    'apps/cli/journeys/shout/people.test.js',
    'apps/cli/journeys/export/team/link.test.js',
    'apps/cli/journeys/export/team/access.test.js',
    'apps/cli/journeys/relay/team/coordinator.test.js',
    'apps/cli/journeys/fact/team/events.test.js',
    'apps/cli/journeys/fact/team/signing.test.js',
    'apps/cli/journeys/fact/team/pin.test.js',
    'apps/cli/journeys/fact/team/apply.test.js',
    'apps/cli/journeys/fact/team/replay.test.js',
    'apps/cli/journeys/fact/team/repo.test.js',
    'apps/cli/journeys/decisions/project.test.js',
    'apps/cli/journeys/fact/team/handover.test.js',
    'apps/cli/tests/fixtures/scenarios/team.js',
  ]) {
    const source = mappedWorkingSource(root, file).body.toString('utf8');
    assert.deepEqual(fixtureSourceEdits(source, { file, moves: plan.paths, readSource }).problems, [], file);
  }
});

test('imported producers need exact source identity and a proven native join return leaf [C7]', () => {
  const consumer = "import { readFileSync } from 'node:fs';\nimport { locate as local } from '../src/producer.js';\nreadFileSync(local());";
  const valid = "import { join } from 'node:path';\nexport function locate() { return join(unknownRoot, 'config.json'); }\n";
  const options = { file: 'test/producer.test.js', moves: [['src/moved.js', 'packages/git/src/io/moved.js']] };
  const inspect = readSource => fixtureSourceEdits(consumer, { ...options, readSource });
  assert.deepEqual(inspect(file => { assert.equal(file, 'src/producer.js'); return blob(valid); }), { edits: [], problems: [] });
  const unrelated = valid + "export async function configure() { return await import('./setup.js'); }\n";
  assert.deepEqual(inspect(() => blob(unrelated)), { edits: [], problems: [] }, 'unrelated dynamic source loading cannot change the proven producer return');
  const changed = valid.replace('config.json', 'moved.js');
  const uncertain = [undefined, () => null,
    () => blob(valid.replace('return join', "return import('./setup.js') || join")),
    () => blob(valid + "export function configure() { return require('./setup.js'); }\n"), () => ({ source: valid, object: '0'.repeat(40) }),
    () => blob(changed), () => blob(valid + "locate = () => 'src/moved.js';\n"),
    () => blob(valid.replace('return join', 'return untrusted')),
    () => blob(valid.replace("'config.json'", '`' + '${unknown}' + '`')),
    () => blob(valid.replace('return join', "const join = untrusted; return join")),
    () => blob("import * as path from 'node:path';\nexport function locate() { return path.join(root, 'config.json'); }\npath.join = untrusted;\n")];
  for (const readSource of uncertain) {
    const result = inspect(readSource);
    assert.deepEqual(result.edits, []);
    assert.ok(result.problems.length, 'absent, changed, shadowed or ambiguous producer evidence stays unsupported');
  }
  let calls = 0;
  assert.ok(inspect(() => blob(calls++ ? changed : valid)).problems.length, 'source mutation during analysis is refused');
});

test('session path producers prove a fixed leaf without granting authority to their argument [C7]', () => {
  const consumer = "import { readFileSync } from 'node:fs'; import { locate } from '../src/producer.js'; readFileSync(locate(info));";
  const options = { file: 'test/session-path.js', moves: [['src/git-launch-baseline.json', 'packages/git/src/io/launch/baseline.json']] };
  const valid = "import { join } from 'node:path'; export function locate(info) { return join(info.gitDir, 'pullboard-checkout-session.json'); }";
  assert.deepEqual(fixtureSourceEdits(consumer, { ...options, readSource: () => blob(valid) }), { edits: [], problems: [] });
  for (const source of [valid.replace('pullboard-checkout-session.json', 'git-launch-baseline.json'),
    valid.replace("'pullboard-checkout-session.json'", 'info.file'),
    valid.replace('locate(info)', 'locate(...info)'),
    valid.replace('return join', "if (info) return info.file; return join"),
  ]) assert.ok(fixtureSourceEdits(consumer, { ...options, readSource: () => blob(source) }).problems.length, source);
  const direct = "import { readFileSync } from 'node:fs'; import { checkoutSessionFile } from '../packages/seats/index.js'; readFileSync(checkoutSessionFile(repoInfo(worker)), 'utf8');";
  assert.deepEqual(fixtureSourceEdits(direct, { ...options, readSource: mappedProducer('packages/seats/src/io/agent/session.js') }), { edits: [], problems: [] });
});

test('a producer moved into a package behind its shim resolves its deep relative imports and keeps its exact bar [C7]', () => {
  const consumer = "import { readFileSync } from 'node:fs'; import { locate } from '../src/producer.js'; readFileSync(locate(info));";
  const options = { file: 'test/moved-producer.js', moves: [['src/producer.js', 'packages/seats/src/io/producer.js']] };
  const body = "import { join } from 'node:path';\nimport { Refused } from '../../../../src/refused.js';\n"
    + "import { guard } from '../../../kernel/src/core/guard.js';\n"
    + "export function locate(info) { return join(info.gitDir, 'pullboard-checkout-session.json'); }\n";
  const sources = { 'src/producer.js': "export { locate } from '../packages/seats/src/io/producer.js';\n",
    'packages/seats/src/io/producer.js': body };
  const inspect = values => fixtureSourceEdits(consumer, { ...options, readSource: file => values[file] ? blob(values[file]) : null });
  assert.deepEqual(inspect(sources), { edits: [], problems: [] }, 'the shim and its ../../../../ body imports resolve');
  assert.ok(inspect({ ...sources, 'packages/seats/src/io/producer.js': undefined }).problems.length, 'an unreadable moved body never proves the read');
  assert.ok(inspect({ ...sources, 'packages/seats/src/io/producer.js': body.replace("'pullboard-checkout-session.json'", "'producer.js'") }).problems.length,
    'a moved body whose leaf is a moved basename still refuses');
});

test('mapped working source path fields follow the path map while lookalikes, other fields and writes stay unproven [C7]', () => {
  const head = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { mappedWorkingSource } from '../packages/gate/src/io/scan.js';\n";
  const options = { file: 'test/mapped-reader.js', moves: [['packages/git/index.js', 'packages/git/src/io/main.js']] };
  const inspect = body => fixtureSourceEdits(head + body, options).problems;
  const valid = "const mapped = mappedWorkingSource(root, 'packages/git/index.js');\nreadFileSync(join(installed, mapped.implementationPath));\nreadFileSync(join(installed, mapped.shimPath));\n";
  assert.deepEqual(inspect(valid), [], 'the map-resolved implementation and shim paths need no repointing');
  for (const body of [valid.replace('mapped.shimPath', 'mapped.identity'),
    valid.replace("'packages/git/index.js'", 'identity'),
    valid + 'mapped.implementationPath = other;\n',
    valid.replace("mappedWorkingSource(root, 'packages/git/index.js')", "copy(root, 'packages/git/index.js')"),
    valid.replace('join(installed, mapped.implementationPath)', "join(installed, mapped.implementationPath, 'index.js')"),
    valid + 'function shadow(mappedWorkingSource) { return mappedWorkingSource; }\n',
  ]) assert.ok(inspect(body).length, body);
  assert.ok(fixtureSourceEdits(head.replace('../packages/gate/src/io/scan.js', './scan-lookalike.js') + valid, options).problems.length,
    'only the real scan module export qualifies');
});

test('named metadata constants follow exact bounded reexports and retain collision refusal [C7]', () => {
  const consumer = "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import { FILE } from '../src/facade.js'; readFileSync(join(root, FILE));";
  const options = { file: 'test/metadata.js', moves: [['src/git-launch-baseline.json', 'packages/git/src/io/launch/baseline.json']] };
  const facade = "export { INPUT as FILE } from './value.js';";
  const sources = { 'src/facade.js': facade, 'src/value.js': "export const INPUT = 'pullboard-runner-policy.json';" };
  const inspect = (replacement, readSource = file => blob({ ...sources, ...replacement }[file])) => fixtureSourceEdits(consumer, { ...options, readSource });
  assert.deepEqual(inspect({}), { edits: [], problems: [] });
  for (const replacement of [
    { 'src/value.js': "export const INPUT = 'git-launch-baseline.json';" },
    { 'src/value.js': 'export const INPUT = unknown;' },
    { 'src/value.js': "export { FILE as INPUT } from './facade.js';" },
    { 'src/value.js': "export let INPUT = 'safe.json'; INPUT = unknown;" },
  ]) assert.ok(inspect(replacement).problems.length, JSON.stringify(replacement));
  assert.ok(inspect({}, () => ({ source: sources['src/facade.js'], object: '0'.repeat(40) })).problems.length);
  const shadowed = consumer.replace('readFileSync(join', 'function read(FILE) { readFileSync(join') + '}';
  assert.ok(fixtureSourceEdits(shadowed, { ...options, readSource: file => blob(sources[file]) }).problems.length);
});


/** Recognize one explicit imported scalar input through the existing compiler identity proof. */
function binaryRead(source) {
  return fixtureSourceEdits("import { readFileSync } from 'node:fs';\n" + source,
    { file: 'test/binary.test.js', moves: [['src/leaf.js', 'packages/git/src/io/leaf.js']] });
}

test('an explicit native executable scalar is disjoint while unknown and shadowed inputs refuse [C7]', () => {
  const imported = "import { execPath as binary } from 'node:process';\n";
  assert.deepEqual(binaryRead(imported + 'readFileSync(binary);'), { edits: [], problems: [] });
  for (const source of [imported + "function nested(binary) { readFileSync(binary); }",
    imported + "binary = 'src/leaf.js'; readFileSync(binary);",
    "import { argv as binary } from 'node:process'; readFileSync(binary);",
    "import { cwd as binary } from 'node:process'; readFileSync(binary());",
    "import process from 'node:process'; readFileSync(process.execPath);",
    "const process = { execPath: 'src/leaf.js' }; readFileSync(process.execPath);"]) {
    assert.ok(binaryRead(source).problems.length, 'unsupported native exports and uncertain binding identity stay unsupported');
  }
});

/** Analyze an actual native filesystem string argument with no candidate prefix evaluation. */
function suffixRead(expression, before = '') {
  return binaryRead("import { join, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n"
    + before + `\nreadFileSync(${expression});`);
}

test('only whole fixed string tails disjoint from every moved basename prove a source read [C7]', () => {
  for (const expression of ["prefix + '_unrelated.trace'", '`web/queue-${entry.id}.trace`',
    "join(root, prefix + '_unrelated.trace')", "(unknown()) + '_unrelated.trace'"]) {
    assert.deepEqual(suffixRead(expression), { edits: [], problems: [] });
  }
  for (const expression of ["prefix || other + '_unrelated.trace'", "prefix && other + '_unrelated.trace'",
    "prefix ?? other + '_unrelated.trace'", "prefix ? other : other + '_unrelated.trace'",
    "(prefix, other + '_unrelated.trace')", "selected = prefix + '_unrelated.trace'",
    "() => prefix + '_unrelated.trace'", "prefix + '_unrelated.trace' || other",
    "prefix + ''", "prefix + '.js'", "prefix + 'leaf.js'", "prefix + '.JS'",
    "prefix + '/unrelated.trace'", "prefix + '\\\\unrelated.trace'", "prefix + '\\ntrace'",
    '`web/${entry.id}.trace#x`', '`web/${entry.id}.trace?x`', '`web/${entry.id}.trace%20`',
    "new URL('../src/leaf.js#_unrelated.trace', import.meta.url)",
    "fileURLToPath(new URL('../src/leaf.js#_unrelated.trace', import.meta.url))",
    "new URL(`${entry.id}.trace`, import.meta.url)", "new URL(`${entry.id}.trace#x`, import.meta.url)",
    "fileURLToPath(new URL(`${entry.id}.trace`, import.meta.url))", "decodeURIComponent(prefix + '_unrelated.trace')",
    "resolve(root, prefix + '_unrelated.trace')", "join(root, prefix + '.js')", "prefix + 'unterminated"]) {
    assert.ok(suffixRead(expression).problems.length, 'branches, overlap, decoding and uncertain grammar stay unsupported: ' + expression);
  }
  assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; readFileSync(prefix + '_unrelated.trace');",
    { file: 'test/suffix-overlap.js', moves: [['src/leaf.js', 'packages/git/src/io/leaf.js'],
      ['src/other_unrelated.trace', 'packages/git/src/io/other_unrelated.trace']] }).problems.length,
  'every moved basename participates in the disjointness proof');
  for (const [from, suffix] of [['src/café.js', '\u0301.js'], ['src/s.js', 'ſ.js'], ['src/ſ.js', 's.js'],
    ['src/café.js', '_unrelated.trace']]) {
    assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; readFileSync(prefix + " + JSON.stringify(suffix) + ');',
      { file: 'test/suffix-unicode.js', moves: [[from, 'packages/git/src/io/leaf.js']] }).problems.length,
    'Unicode normalization across the unknown prefix and full casefold uncertainty stay unsupported');
  }
  assert.ok(suffixRead("join(root, prefix + '_unrelated.trace')", 'function nested(join) {}').problems.length,
    'native callee shadowing still refuses the path operation');
  assert.ok(fixtureSourceEdits("import { cpSync } from 'node:fs'; cpSync(prefix + '_unrelated.trace', target, {recursive:true});",
    { file: 'test/suffix-directory.js', moves: [['src/leaf.js', 'packages/git/src/io/leaf.js']] }).problems.length,
  'regular-file suffix proof never blesses a recursive directory copy');
});

/** Keep each real reader at its native source construction instead of trusting a returned object's mutable fields. */
function localPortSource(link, key) {
  return "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\n"
    + `async function fixture() { const linkFile = ${link}; const keyFile = ${key};
      return { readLink() { return readFileSync(linkFile, 'utf8'); },
        readKey() { return readFileSync(keyFile, 'utf8'); } }; }`;
}

test('local fixture reader ports retain direct immutable source proof without async object trust [C7]', () => {
  const options = { file: 'test/local-readers.js', moves: [['src/leaf.js', 'packages/git/src/io/leaf.js']] };
  assert.deepEqual(fixtureSourceEdits(localPortSource("join(root, '.git', 'pullboard', 'relay.json')",
    "join(home, 'keys', id + '.key')"), options), { edits: [], problems: [] });
  assert.ok(fixtureSourceEdits(localPortSource("join(root, '.git', 'pullboard', 'relay.json')",
    "join(home, 'keys', id + '.js')"), options).problems.length, 'a reader closure cannot hide a suffix overlapping moved source');
  for (const body of ["readFileSync(box.linkFile, 'utf8');",
    "async function read() { const box = await unknownConstructor(); return readFileSync(box.linkFile, 'utf8'); }"]) {
    assert.ok(fixtureSourceEdits("import { readFileSync } from 'node:fs'; " + body, options).problems.length,
      'unknown and asynchronous constructor fields never gain implicit source authority');
  }
});

test('copied source remains a move obligation while generated journals and recursive inventories stay explicit [C7]', () => {
  const options = { file: 'test/source-obligations.js', moves: [['src/leaf.js', 'packages/git/src/io/leaf.js'],
    ['src/baseline.json', 'packages/git/src/io/baseline.json']] };
  const source = "import { readFileSync, copyFileSync } from 'node:fs';\n"
    + "const original = readFileSync(new URL('../src/leaf.js', import.meta.url), 'utf8');\n"
    + "copyFileSync(new URL('../src/leaf.js', import.meta.url), new URL('../fixture/leaf.js', import.meta.url));";
  const result = fixtureSourceEdits(source, options);
  assert.deepEqual(result.problems, []);
  assert.equal(result.edits.length, 2, 'a copied source body remains an actual dependency, even in a private fixture');
  let rewritten = source;
  for (const edit of [...result.edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  assert.equal(rewritten.includes("new URL('../src/leaf.js', import.meta.url)"), false);
  assert.ok(rewritten.includes("new URL('../fixture/leaf.js', import.meta.url)"), 'the fixture destination is unchanged');
  const listed = fixtureSourceEdits("import { readFileSync } from 'node:fs';\n"
    + "for (const file of ['leaf.js']) readFileSync(new URL(`../src/${file}`, import.meta.url));", options);
  assert.deepEqual(listed.problems, []);
  assert.equal(listed.edits.length, 1, 'a finite declared source inventory carries its moved source operand');
  for (const body of ["readFileSync(join(directory, key + '.json'), 'utf8');",
    "readFileSync(join(root, failure.file));", "readFileSync(box.healthFile);",
    "const module = await import('../src/leaf.js'); readFileSync(module.input);",
    "for (const file of readdirSync(root, { recursive: true })) readFileSync(join(root, file));",
    "cpSync(box.keyFile, target);", "cpSync(join(box.root, '.git'), target, { recursive: true });"]) {
    const unresolved = fixtureSourceEdits("import { readFileSync, cpSync, readdirSync } from 'node:fs';\n"
      + "import { join } from 'node:path';\n" + body, options);
    assert.ok(unresolved.problems.length, 'an artifact name or private-root assumption cannot erase a possible source dependency: ' + body);
    assert.deepEqual(unresolved.edits, [], 'unknown source identity never creates a guessed rewrite');
  }
});

for (const [name, body] of [
  ['native JSON journal keys', "readFileSync(join(directory, key + '.json'), 'utf8');"],
  ['session and receipt path helpers', "readFileSync(checkoutSessionFile(repoInfo(root)), 'utf8'); readFileSync(join(receiptStore(root), receiptId + '.json'));"],
  ['scanned credentials and recursive copies', "for (const file of filesUnder(directory)) readFileSync(file); cpSync(join(box.root, '.git', 'pullboard'), target, { recursive: true });"],
  ['credential-store audit logs', "const keychainLog = setup.keychainLog; readFileSync(keychainLog, 'utf8');"],
]) test(`${name} remain named conservative obligations rather than successful artifact proofs [C7]`, () => {
  const source = "import { readFileSync, cpSync } from 'node:fs'; import { join } from 'node:path';\n" + body;
  const result = fixtureSourceEdits(source, { file: 'test/conservative-obligations.js',
    moves: [['src/leaf.js', 'packages/git/src/io/leaf.js'], ['src/baseline.json', 'packages/git/src/io/baseline.json']] });
  assert.ok(result.problems.length, 'unproved artifact provenance must remain visible');
  assert.ok(result.problems.every(problem => problem.startsWith('test/conservative-obligations.js:')
    && problem.includes('unsupported fixture source:')), 'every retained obligation names its actual source site');
  assert.deepEqual(result.edits, [], 'an unknown path never gains a guessed move or passing artifact classification');
});


test('local function call sets preserve literal-aware offsets and raw parameter grammar [C7]', () => {
  const source = `function read(path = { value: ')' }, { mode } = {}) {
    return path;
  }
  read(new URL('../a.yml', import.meta.url), { mode: ',' });
  const value = read(\`value, \${other({ nested: true })}\`, /[,)]/u);
  `;
  const rows = localFunctionCallSets(source, { file: 'test/callsets.js' });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.name, 'read');
  assert.equal(source.slice(row.nameAt, row.nameAt + 4), 'read');
  assert.equal(source.slice(row.parameterStart, row.parameterEnd), "path = { value: ')' }, { mode } = {}");
  assert.equal(source.slice(row.bodyStart, row.bodyEnd).trim(), 'return path;');
  assert.equal(row.calls.length, 2);
  assert.deepEqual(row.calls.map(call => call.args.map(arg => source.slice(arg.start, arg.end))), [
    ["new URL('../a.yml', import.meta.url)", "{ mode: ',' }"],
    ['`value, ${other({ nested: true })}`', '/[,)]/u'],
  ]);
  assert.ok(row.calls.every(call => source.slice(call.at, call.at + 4) === 'read'));
});

test('local function authority rejects escapes, shadowing, writes and nonordinary calls [C7]', () => {
  const declaration = 'function read(path) { return path; }\n';
  for (const tail of [
    'const alias = read; alias(input);',
    'consume(read);',
    'read.call(null, input);',
    'new read(input);',
    'read?.(input);',
    'read(...inputs);',
    'read = other; read(input);',
    'function inner(read) { return read(input); }',
    'export { read };',
    'eval(code); read(input);',
    "Function('return 1')(); read(input);",
  ]) assert.ok(!localFunctionCallSets(declaration + tail, { file: 'test/callsets.js' }).some(row => row.name === 'read'), tail);
  for (const source of [
    'export function read(path) { return path; } read(input);',
    'const outer = function read(path) { return path; };',
    'function read(path) {} { function read(path) {} read(input); }',
  ]) assert.ok(!localFunctionCallSets(source, { file: 'test/callsets.js' }).some(row => row.name === 'read'), source);
});

test('local call set complexity bounds never authorize partial call inventories [C7]', () => {
  const declaration = 'function read(path) { return path; }\n';
  const excessiveCalls = declaration + Array.from({ length: 129 }, () => 'read(input);').join('\n');
  const excessiveArgs = declaration + 'read(' + Array.from({ length: 65 }, () => 'input').join(',') + ');';
  for (const source of [excessiveCalls, excessiveArgs, declaration + ' '.repeat(1024 * 1024)]) {
    assert.ok(!localFunctionCallSets(source, { file: 'test/callsets.js' }).some(row => row.name === 'read'));
  }
});


test('whole member substitution proves rvalue grammar without evaluating candidate effects [C7]', () => {
  const source = "throw new Error('candidate must never execute'); const first = box.marker; consume(box.other);";
  const ranges = ['box.marker', 'box.other'].map(text => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length }));
  assert.deepEqual([...readOnlyMemberRanges(source, ranges)], ranges.map(range => range.start));
});

test('whole member writes and destructuring or loop targets cannot accept a constant expression [C7]', () => {
  for (const body of [
    'box.marker = input;',
    'box.marker += input;',
    'box.marker ??= input;',
    '++box.marker;',
    '--box.marker;',
    'box.marker++;',
    'box.marker--;',
    '({ value: box.marker } = input);',
    '[box.marker] = input;',
    'for (box.marker of input) {}',
    'for (box.marker in input) {}',
  ]) {
    const start = body.indexOf('box.marker');
    assert.deepEqual([...readOnlyMemberRanges(body, [{ start, end: start + 'box.marker'.length }])], [], body);
  }
});

test('member grammar proof fails closed on invalid modules and bounded or ambiguous ranges [C7]', () => {
  const source = 'consume(box.marker);', start = source.indexOf('box.marker'), range = { start, end: start + 'box.marker'.length };
  for (const [text, ranges] of [
    ['const = ; ' + source, [{ start: start + 10, end: range.end + 10 }]],
    [source, [{ start: -1, end: range.end }]],
    [source, [{ start, end: source.length + 1 }]],
    [source, [{ start, end: start }]],
    [source, [{ start: 0.5, end: range.end }]],
    [source, [range, { start, end: range.end - 1 }]],
    [source, Array.from({ length: 129 }, () => range)],
    [source + ' '.repeat(1024 * 1024), [range]],
    [source + '\n//' + 'é'.repeat(600_000), [range]],
  ]) assert.deepEqual([...readOnlyMemberRanges(text, ranges)], []);
});

test('member substitution alone is not delete or call authority [C7]', () => {
  for (const source of ['delete box.marker;', 'box.marker();']) {
    const start = source.indexOf('box.marker');
    assert.deepEqual([...readOnlyMemberRanges(source, [{ start, end: start + 'box.marker'.length }])], [start],
      'callers must retain their independent delete and method-call guards even though expression substitution compiles');
  }
});


test('named producer front doors retain exact committed intermediate evidence and legal final commas only [C7]', () => {
  const consumer = "import {readFileSync} from 'node:fs'; import {locate} from '../src/producer.js'; readFileSync(locate(info));";
  const options = { file: 'test/frontdoor-producer.js', moves: [['src/producer.js', 'packages/seats/src/io/producer.js']] };
  const body = "import {join} from 'node:path'; export function locate(info) { return join(info.gitDir, 'pullboard-checkout-session.json'); }";
  const sources = {
    'src/producer.js': "export {locate,} from '../packages/seats/index.js';",
    'packages/seats/index.js': "export {locate,} from './src/io/producer.js';",
    'packages/seats/src/io/producer.js': body,
  };
  const inspect = replacement => fixtureSourceEdits(consumer, { ...options,
    readSource: file => ({ ...sources, ...replacement }[file] ? blob({ ...sources, ...replacement }[file]) : null) });
  assert.deepEqual(inspect({}), { edits: [], problems: [] });
  for (const replacement of [
    { 'packages/seats/index.js': undefined },
    { 'packages/seats/index.js': "export {missing as locate,} from './src/io/producer.js';" },
    { 'packages/seats/index.js': "export {locate,,} from './src/io/producer.js';" },
    { 'packages/seats/index.js': "export {,locate} from './src/io/producer.js';" },
    { 'packages/seats/index.js': "export {locate} from '../../src/producer.js';" },
    { 'packages/seats/src/io/producer.js': body.replace('pullboard-checkout-session.json', 'producer.js') },
  ]) assert.ok(inspect(replacement).problems.length, JSON.stringify(replacement));
});
