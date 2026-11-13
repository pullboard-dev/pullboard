import '../../../../index.js';
import { test } from 'node:test';
import { cli } from '../../../../tests/fixtures/init/known-frozen.js';
import { fixture } from '../../../../tests/fixtures/init/known-frozen.js';
import { settledSubmit } from '../../../../tests/fixtures/init/known-frozen.js';
import { fileMainRed } from '../../../../tests/fixtures/init/known-frozen.js';
test('probe [C7]', { timeout: 200000 }, async t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box, { submitted: true });
  const shown = cli(box, box.root, 'show', String(box.item), '--review');
  throw new Error('PROBE ' + JSON.stringify({ repair, gg: report.submission?.gateGreen, s: shown.status, o: shown.stdout.slice(0, 3500), e: shown.stderr }));
});
