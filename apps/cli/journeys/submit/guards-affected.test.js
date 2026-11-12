/** Affected tests include dirty registry changes without changing HEAD or the real index, driven through the real CLI [C7,V4]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { e2e } from '../../tests/fixtures/guards.js';
import { put } from '../../tests/fixtures/guards.js';
import { registryBox } from '../../tests/fixtures/guards.js';

after(e2e.cleanup);

test('affected tests include dirty registry changes without changing HEAD or the real index [C7,V4]', async () => {
  const box = (await registryBox());
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  const index = box.git(box.web, 'write-tree').trim();
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.registryGuards = [];
  config.affectedTests = 'true';
  put(box.web, 'pullboard.json', JSON.stringify(config));
  const result = (await box.runLocal(box.web, 'test', '--affected', '--json'));
  assert.equal(result.code, 1, result.err + result.out);
  const output = JSON.parse(result.out);
  assert.ok(output.files.includes('apps/cli/journeys/relay/credential.test.js'));
  assert.match(output.output, /missing actor credential for newMove\.js/u);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(box.git(box.web, 'write-tree').trim(), index);
});
