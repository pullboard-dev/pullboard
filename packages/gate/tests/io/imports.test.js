/**
 * @pullboard-test-boundary contract
 */
/** Census reuse keeps actual V8 parsing, opaque imports and fresh loader/error behavior [C7,O5]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commonJsIn } from '../../index.js';
import { importsIn } from '../../index.js';
import { withImportParseCache } from '../../index.js';

/** Count real parser subprocesses without substituting any successful compiler outcome. */
function compilerCalls(t) {
  const original = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (...args) => { calls++; return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => calls;
}

/** Give this test a private machine cache so other checkouts cannot lend it prior compiler results. */
function isolateMachineHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-parse-cache-'));
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  });
}

const SOURCE = "import value from './leaf.js'; export default value;";

test('one census reuses exact real compilation bytes but exposes independent results [C7]', t => {
  isolateMachineHome(t);
  const calls = compilerCalls(t);
  withImportParseCache(() => {
    assert.deepEqual(commonJsIn([SOURCE]), [false]);
    const first = importsIn([SOURCE]);
    first[0].push('not a real import');
    assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
    assert.equal(calls(), 1);
    assert.deepEqual(importsIn([SOURCE.replace('leaf.js', 'changed.js')]), [['./changed.js']]);
    assert.equal(calls(), 2, 'changed bytes require an actual fresh compiler result');
  });
  assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
  assert.equal(calls(), 2, 'machine-wide cache reuse survives the census boundary');
});

test('cached and uncached real parser results agree for computed, quoted, invalid and CommonJS source [C7]', () => {
  const cases = [SOURCE, "import(process.env.TARGET);", "const text = 'import(untrusted)';",
    "const require = value => value; require('node:fs');", 'export const broken = ;'];
  for (const source of cases) {
    const expected = commonJsIn([source]);
    assert.deepEqual(withImportParseCache(() => commonJsIn([source])), expected);
    if (source.includes('broken')) {
      assert.throws(() => withImportParseCache(() => importsIn([source])), /does not compile/u);
    } else assert.deepEqual(withImportParseCache(() => importsIn([source])), importsIn([source]));
  }
  assert.deepEqual(withImportParseCache(() => importsIn(["import(process.env.TARGET);"])), [['(computed)']]);
});

test('foreign NODE_OPTIONS disable compile reuse even when the option is accepted by Node [C7]', t => {
  const calls = compilerCalls(t);
  const before = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--no-warnings';
    withImportParseCache(() => {
      assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
      assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
    });
    assert.equal(calls(), 2);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
});

test('a subprocess error is not a cached compiler observation [C7]', t => {
  isolateMachineHome(t);
  const original = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (...args) => ++calls === 1
    ? { status: 1, stderr: 'private compiler transport failed' } : original(...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  withImportParseCache(() => {
    assert.throws(() => importsIn([SOURCE]), /private compiler transport failed/u);
    assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
    assert.equal(calls, 2);
  });
});


test('the real browser-slot preload retains census reuse while opaque options still invalidate it [C7,O5]', t => {
  isolateMachineHome(t);
  const calls = compilerCalls(t);
  const before = process.env.NODE_OPTIONS;
  t.after(() => { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; });
  process.env.NODE_OPTIONS = `--import=${new URL('../../src/io/browser/guard.js', import.meta.url).href}`;
  withImportParseCache(() => {
    assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
    assert.deepEqual(importsIn([SOURCE]), [['./leaf.js']]);
    assert.equal(calls(), 1, 'the actual owned browser-slot preload keeps real compilation reuse');
    process.env.NODE_OPTIONS = '--no-warnings';
    importsIn([SOURCE]);
    importsIn([SOURCE]);
    assert.equal(calls(), 3, 'changed opaque options force fresh real compiler executions inside the same census');
  });
});
