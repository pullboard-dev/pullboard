/** A review comparison worker runs its body when started through a symlinked folder, as the temp tools snapshot is (#11709). */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAsEntry } from '../fixtures/entry.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

const SOURCE = fileURLToPath(new URL('../../src/io/comparison.js', import.meta.url));

test('verify.comparison.entry-through-symlink: [C7] a worker started through a symlinked folder runs its body, as through the real path', (t) => {
  const scratch = privateFixtureFiles('pullboard-comparison-entry-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const link = join(scratch, 'tools');
  symlinkSync(dirname(SOURCE), link, 'dir');
  const missing = join(scratch, 'absent', 'request.json');
  for (const script of [join(link, 'comparison.js'), SOURCE]) {
    const run = startAsEntry(script, [missing]);
    assert.notEqual(run.status, 0, `${script} exited ${run.status} without running the worker body`);
    assert.match(run.stderr, /ENOENT/u);
    assert.ok(run.stderr.includes(missing), 'the refusal names the missing request');
  }
});
