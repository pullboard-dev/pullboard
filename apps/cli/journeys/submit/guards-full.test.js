/** Full fallback and candidate policy edits cannot omit an accepted registry guard, driven through the real CLI [C7,V4,V16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { commit } from '../../tests/fixtures/guards.js';
import { e2e } from '../../tests/fixtures/guards.js';
import { put } from '../../tests/fixtures/guards.js';
import { registryBox } from '../../tests/fixtures/guards.js';

after(e2e.cleanup);

test('cli.journeys-submit-guards-full.full-fallback-and-candidate-policy-edits: full fallback and candidate policy edits cannot omit an accepted registry guard [C7,V4,V16]', async () => {
  const box = (await registryBox({ deferred: false }));
  put(box.web, 'src/moves/newMove.js', 'export const operation = "newMove";\n');
  // Unknown data forces a full gate, which is deliberately true and does not include this guard.
  put(box.web, 'web/opaque.data', 'forces full fallback\n');
  const config = JSON.parse(readFileSync(join(box.web, 'pullboard.json'), 'utf8'));
  config.registryGuards = [];
  config.affectedTests = 'true';
  put(box.web, 'pullboard.json', JSON.stringify(config));
  commit(box, box.web, 'feat(core): add a move with candidate policy edits [G1]');
  // A pulled submit queues its gate; the fixture command returns once the local runner settled it, so show reads the red verdict [C7].
  const submitted = (await box.runLocal(box.web, 'submit', String(box.id)));
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const red = JSON.parse((await box.runLocal(box.web, 'show', String(box.id), '--json', '--no-next')).out).gateJob;
  assert.equal(red?.gate?.green, false, JSON.stringify(red));
  assert.match(JSON.stringify(red), /apps\/cli\/journeys\/relay\/credential\.test\.js/u);
  assert.match(JSON.stringify(red), /missing actor credential for newMove\.js/u);
});
