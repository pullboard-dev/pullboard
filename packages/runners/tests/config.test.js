/** @pullboard-test-input package.json apps/runner/src/io/scripts/worker.js package.json packages/config/index.js packages/config/src/io/declaration.js packages/config/src/io/main.js packages/config/src/logic/json.js */
/** Validate the explicit opt-in to speculative landing without changing serial defaults [B3,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../config/index.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerPackage } from '../index.js';
import { commandDocs } from '../../config/index.js';

test('runners.config.parallel-candidate-landing-is-opt-in: parallel candidate landing is opt-in and accepts only boolean settings [B3,V4]', () => {
  assert.notEqual(configFromSource('{}').landing?.parallel, true);
  for (const parallel of [true, false]) {
    assert.equal(configFromSource(JSON.stringify({ landing: { parallel } })).landing.parallel, parallel);
  }
  for (const parallel of [null, 1, 'true', [], {}]) {
    assert.throws(() => configFromSource(JSON.stringify({ landing: { parallel } })), { code: 'BAD_CONFIG', message: /landing\.parallel/u });
  }
});

/** Exercise the real worker's source closure rather than a stand-in manifest [C7,O5]. */
test('runners.config.the-moved-config-command-declarations-retain: the moved config command declarations retain their root and stay out of the real runner capsule [C7,O5]', () => {
  const root = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
  const capsule = runnerPackage(root);
  assert.equal(capsule.entry, 'apps/runner/src/io/scripts/worker.js');
  // The declaration reader reads apps/cli/src/io/command-docs at import, and that directory is not a shipped runner file.
  for (const reader of ['packages/config/src/io/declaration.js', 'packages/config/src/logic/json.js', 'packages/config/index.js']) {
    assert.ok(!Object.hasOwn(capsule.files, reader), `the worker closure must not import ${reader}; it would die reading apps/cli/src/io/command-docs`);
  }
  assert.ok(Object.hasOwn(capsule.files, 'packages/config/src/io/main.js'), 'the worker still reaches config through its shell module');
  assert.ok(Object.hasOwn(capsule.files, 'package.json'), 'the root anchor is a real shipped file');
  const explicit = commandDocs(root);
  assert.ok(explicit.length > 0, 'the actual independent command declarations are read');
  assert.deepEqual(commandDocs(), explicit, 'the default root preserves the explicit-root public API');
});
