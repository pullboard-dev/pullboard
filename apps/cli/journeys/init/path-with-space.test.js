/** A checkout whose path contains a space still runs a subprocess import: preload paths are URL-encoded, never raw [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureChild,
} from '../../tests/fixtures/child.js';

/** Put a tiny module tree in a folder with spaces in its path, then import it from a child that also loads a preload there. */
test('a subprocess import from a folder whose path contains a space succeeds through URL-encoded preloads [C7]', (t) => {
  const files = privateFixtureFiles('pb-space-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const checkout = join(files.root, 'Open Source', 'repo copy');
  const marker = join(checkout, 'marker.txt');
  files.write('Open Source/repo copy/dep copy.mjs', 'export const answer = 42;\n');
  files.write('Open Source/repo copy/preload.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'preloaded');\n`);
  const script = `import(${JSON.stringify(pathToFileURL(join(checkout, 'dep copy.mjs')).href)}).then((m) => process.stdout.write(String(m.answer)));`;
  const result = runFixtureChild(process.execPath, ['-e', script], {
    cwd: checkout,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(join(checkout, 'preload.mjs')).href}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '42');
  assert.equal(readFileSync(marker, 'utf8'), 'preloaded');
  assert.match(checkout, / /u);
});
