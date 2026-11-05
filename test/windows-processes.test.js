/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/windows-child-process.js src/git.js src/browser-slot-guard.js src/test-file-pool.js src/code-map.js src/browser-admission.js */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { hideConsoleWindow, spawnSync, execFile, execFileSync } from '../src/windows-child-process.js';
import { scanSource } from '../src/code-map.js';
import { testsNeedBrowser } from '../src/browser-admission.js';

const windows = process.platform === 'win32';
const installed = process.env.PULLBOARD_PACKAGE_ROOT || fileURLToPath(new URL('..', import.meta.url));

test('source map retains aliased process effects through the Windows adapter [A8,C7]', () => {
  for (const [path, adapter] of [['src/example.js', './windows-child-process.js'], ['src/commands/example.js', '../windows-child-process.js']]) {
    const source = `import { spawn as launch } from '${adapter}';\nexport function execute(command) { return launch(command); }\n`;
    const scan = scanSource(path, source);
    assert.ok(scan.functions.find(fn => fn.name === 'execute').effects.includes('spawn'));
  }
});

test('browser admission retains native process provenance through the Windows adapter [A8,C7]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-windows-admission-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'src', 'windows-child-process.js'), readFileSync(new URL('../src/windows-child-process.js', import.meta.url)));
    writeFileSync(join(root, 'src', 'git.js'), "import { spawn } from './windows-child-process.js'; export function run() { return spawn('git'); }\n");
    writeFileSync(join(root, 'test', 'plain.test.js'), "import '../src/git.js';\n");
    assert.equal(await testsNeedBrowser(root, ['test/plain.test.js'], { byLaunch: false }), false);
    writeFileSync(join(root, 'src', 'generic.js'), "import { spawn } from './windows-child-process.js'; export function run(command) { return spawn(command); }\n");
    writeFileSync(join(root, 'test', 'generic.test.js'), "import '../src/generic.js';\n");
    assert.equal(await testsNeedBrowser(root, ['test/generic.test.js'], { byLaunch: false }), true);
    writeFileSync(join(root, 'src', 'generic.js'), "import { spawn } from './windows-child-process.js'; export function run() { return spawn('google-chrome'); }\n");
    assert.equal(await testsNeedBrowser(root, ['test/generic.test.js'], { byLaunch: true }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('adapter preserves child-process overloads, options and callbacks [A8]', () => {
  const received = [];
  const receiver = {};
  const native = function (...args) {
    received.push({ args, receiver: this });
    return 7;
  };
  const wrapped = hideConsoleWindow(native, 'win32');
  const callback = () => {};
  const environment = { SYNTHETIC: 'value' };
  const options = { cwd: 'a b', env: environment, timeout: 123, stdio: 'pipe', windowsHide: false };
  for (const args of [
    ['file'],
    ['file', ['a b']],
    ['file', options],
    ['file', ['a b'], options],
    ['file', callback],
    ['file', ['a b'], callback],
    ['file', undefined, options],
    ['file', null, options, callback],
    ['file', ['a b'], undefined, callback],
  ])
    assert.equal(wrapped.apply(receiver, args), 7);
  assert.ok(received.every((call) => call.receiver === receiver));
  assert.ok(received.every((call) => call.args.some((value) => value?.windowsHide === true)));
  assert.equal(received[2].args[1].env, environment);
  assert.equal(received[2].args[1].timeout, 123);
  assert.equal(received[2].args[1].cwd, 'a b');
  assert.equal(received[2].args[1].stdio, 'pipe');
  assert.equal(options.windowsHide, false, 'caller options must remain immutable');
  assert.equal(received[4].args[2], callback);
  assert.equal(received[5].args[3], callback);
  assert.equal(received[6].args[2].env, environment);
  assert.equal(received[7].args[3], callback);
  assert.equal(received[8].args[3], callback);
  assert.equal(hideConsoleWindow(native, 'linux'), native);
  wrapped('file', 'invalid-options');
  assert.equal(received.at(-1).args[1], 'invalid-options', 'preserve native validation');
  const invalidOptions = [];
  wrapped('file', [], invalidOptions);
  assert.equal(received.at(-1).args[2], invalidOptions, 'preserve invalid options arrays');
  const selfCustom = () => Promise.resolve(42);
  selfCustom[promisify.custom] = selfCustom;
  const hiddenCustom = hideConsoleWindow(selfCustom, 'win32');
  assert.equal(
    promisify(hiddenCustom),
    hiddenCustom,
    'self-referential custom promisifiers must not recurse',
  );
});

test('hidden native children preserve output, failures and async results [A8]', async () => {
  const result = spawnSync(
    process.execPath,
    ['-e', 'console.log("synthetic"); process.exitCode=7'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout.trim(), 'synthetic');
  assert.equal(execFileSync(process.execPath, ['-p', '"a b"'], { encoding: 'utf8' }).trim(), 'a b');
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-p', '42'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(error);
      assert.equal(stdout.trim(), '42');
      resolve();
    });
  });
  const asyncResult = await promisify(execFile)(process.execPath, ['-p', '43']);
  assert.equal(asyncResult.stdout.trim(), '43');
  await assert.rejects(promisify(execFile)(process.execPath, ['-e', 'process.exitCode=7']), {
    code: 7,
  });
  const timeout = spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 });
  assert.equal(timeout.error?.code, 'ETIMEDOUT');
});

test(
  'installed view Git reads hide console windows and preserve their result [A8]',
  { skip: !windows },
  async () => {
    const calls = [];
    const original = childProcess.execFileSync;
    childProcess.execFileSync = (file, args, options) => {
      calls.push({ file, options });
      return original(file, args, { ...options, windowsHide: true });
    };
    syncBuiltinESMExports();
    try {
      const { git } = await import(pathToFileURL(join(installed, 'src', 'git.js')).href);
      const result = git(process.cwd(), ['--version']);
      assert.match(result, /^git version /);
      assert.ok(calls.length > 0);
      assert.ok(
        calls.every(({ options }) => options?.windowsHide === true),
        'every installed Git child must request windowsHide before reaching Node',
      );
    } finally {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    }
  },
);

test(
  'installed adapters retain browser guards and default-import linkage [A8]',
  () => {
    const adapter = pathToFileURL(join(installed, 'src', 'windows-child-process.js')).href;
    const guard = pathToFileURL(join(installed, 'src', 'browser-slot-guard.js')).href;
    const pool = pathToFileURL(join(installed, 'src', 'test-file-pool.js')).href;
    const script = `
    import assert from 'node:assert/strict';
    import { promisify } from 'node:util';
    const adapter = await import(${JSON.stringify(adapter)});
    await import(${JSON.stringify(pool)});
    process.env.PULLBOARD_TEST_BROWSER_SLOT = 'none';
    await import(${JSON.stringify(guard)});
    const absentBrowser = 'C:/__pullboard_synthetic_absent__/google-chrome';
    assert.throws(() => adapter.spawn(absentBrowser), { code: 'BROWSER_SLOT_REQUIRED' });
    assert.throws(() => adapter.spawnSync(absentBrowser), { code: 'BROWSER_SLOT_REQUIRED' });
    await assert.rejects(promisify(adapter.execFile)(absentBrowser), { code: 'BROWSER_SLOT_REQUIRED' });
    console.log('guard preserved');
  `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PULLBOARD_TEST_BROWSER_SLOT: 'held' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'guard preserved');
  },
);
