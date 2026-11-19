/** @pullboard-test-input source-cell packages/fs */
/** The file-system adapter returns the injected source, or the real one by default, and no other cell reaches it yet [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kernel from '../../../kernel/index.js';
import * as kernelLight from '../../../kernel/light.js';
import { fileSystemAdapter } from '../../index.js';

test('fs.adapter.returns-the-source: clause 1: the adapter returns what the injected source returns [C7]', () => {
  const files = { '/a': 'one' };
  const fs = fileSystemAdapter({
    readFileSync: (p) => files[p],
    writeFileSync: (p, d) => { files[p] = d; },
    existsSync: (p) => p in files,
    readdirSync: () => Object.keys(files),
  });
  assert.equal(fs.readFile('/a'), 'one');
  fs.writeFile('/b', 'two');
  assert.equal(fs.exists('/b'), true);
  assert.equal(fs.exists('/c'), false);
  assert.deepEqual(fs.list('/'), ['/a', '/b']);
});

test('fs.adapter.real-by-default: clause 1: the adapter reads the real source by default [C7]', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const fs = fileSystemAdapter();
  assert.match(fs.readFile(join(dir, 'fs.test.js')), /file-system adapter returns/);
  assert.equal(fs.exists(join(dir, 'fs.test.js')), true);
  assert.ok(readdirSync(dir).every((name) => fs.list(dir).includes(name)));
});

test('fs.adapter.fake-is-deterministic: clause 1: a fake source makes the answer deterministic [C7]', () => {
  const fs = fileSystemAdapter({ readFileSync: () => 'fixed', existsSync: () => true });
  assert.equal(fs.readFile('/anything'), 'fixed');
  assert.equal(fs.readFile('/else'), 'fixed');
});

test('fs.adapter.kernel-gains-no-export: clause 2: the kernel exports no file-system adapter, so no existing behaviour changes [C7]', () => {
  assert.equal('fileSystemAdapter' in kernel, false);
  assert.equal('fileSystemAdapter' in kernelLight, false);
  assert.equal(typeof fileSystemAdapter, 'function');
});

test('fs.adapter.descriptors-streams-watch-pass-through: clause 1: open, close, read, write, fstat, fsync, createReadStream, createWriteStream and watch reach the injected source with their arguments and return its answer [C7]', () => {
  const calls = [];
  const names = { open: 'openSync', close: 'closeSync', read: 'readSync', write: 'writeSync', fstat: 'fstatSync', fsync: 'fsyncSync',
    createReadStream: 'createReadStream', createWriteStream: 'createWriteStream', watch: 'watch' };
  const source = Object.fromEntries(Object.values(names).map(name => [name, (...args) => { calls.push([name, args]); return `${name}-result`; }]));
  const fs = fileSystemAdapter(source);
  for (const [method, name] of Object.entries(names)) {
    assert.equal(fs[method]('a', 2), `${name}-result`, `${method} returns the source's answer`);
    assert.deepEqual(calls.pop(), [name, ['a', 2]], `${method} calls ${name} with its arguments`);
  }
});

test('fs.adapter.promises-pass-through: clause 2: promises passes readFile, readdir, stat, rm, mkdtemp, open, readlink and glob to the source promises, and with no source reaches node:fs/promises [C7]', async () => {
  const calls = [];
  const names = ['readFile', 'readdir', 'stat', 'rm', 'mkdtemp', 'open', 'readlink', 'glob'];
  const promises = Object.fromEntries(names.map(name => [name, async (...args) => { calls.push([name, args]); return `${name}-result`; }]));
  const fs = fileSystemAdapter({ promises });
  for (const name of names) {
    assert.equal(await fs.promises[name]('a', 2), `${name}-result`, `${name} returns the source's answer`);
    assert.deepEqual(calls.pop(), [name, ['a', 2]], `${name} is called with its arguments`);
  }
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const real = fileSystemAdapter();
  assert.match(await real.promises.readFile(join(dir, 'fs.test.js'), 'utf8'), /file-system adapter returns/);
  assert.ok((await real.promises.readdir(dir)).includes('fs.test.js'));
  assert.equal((await real.promises.stat(join(dir, 'fs.test.js'))).isFile(), true);
});

const METADATA = [
  ['stat', 'statSync', ['/a', { bigint: true }]],
  ['lstat', 'lstatSync', ['/a', { throwIfNoEntry: false }]],
  ['realpath', 'realpathSync', ['/a', { encoding: 'utf8' }]],
  ['readlink', 'readlinkSync', ['/a', 'utf8']],
  ['access', 'accessSync', ['/a', 4]],
  ['statfs', 'statfsSync', ['/a', { bigint: true }]],
  ['list', 'readdirSync', ['/a', { withFileTypes: true, recursive: true }]],
];

test('fs.adapter.metadata-passes-through: clause 1: stat, lstat, realpath, readlink, access, statfs and list pass their arguments and options to the injected source [C7]', () => {
  for (const [name, syncName, args] of METADATA) {
    const calls = [];
    const fs = fileSystemAdapter({ [syncName]: (...given) => { calls.push(given); return `${name}-result`; } });
    assert.equal(fs[name](...args), `${name}-result`, name);
    assert.deepEqual(calls, [args], name);
  }
});

test('fs.adapter.constants-from-source: clause 1: the adapter exposes the constants of the injected source [C7]', () => {
  const constants = { R_OK: 4, COPYFILE_EXCL: 1 };
  assert.equal(fileSystemAdapter({ constants }).constants, constants);
});

test('fs.adapter.metadata-real-by-default: clause 2: with no source the metadata functions reach node:fs and its constants [C7]', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const file = join(dir, 'fs.test.js');
  const fs = fileSystemAdapter();
  assert.equal(fs.stat(file).isFile(), true);
  assert.equal(fs.lstat(dir).isDirectory(), true);
  assert.equal(fs.realpath(file), realpathSync(file));
  assert.equal(fs.access(file, fs.constants.R_OK), undefined);
  assert.equal(typeof fs.statfs(dir).bsize, 'number');
  assert.equal(fs.list(dir, { withFileTypes: true }).some((entry) => entry.name === 'fs.test.js'), true);
  assert.equal(fs.constants.R_OK, 4);
  assert.throws(() => fs.readlink(file), { code: 'EINVAL' });
});
