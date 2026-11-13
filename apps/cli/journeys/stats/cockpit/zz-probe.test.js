import { test } from 'node:test';
import { SPEC } from '../../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../../tests/fixtures/cockpit/harness.js';
test('[N26] probe', { timeout: 150_000 }, async () => {
  const box = machine();
  const alpha = project(box, 'stats-phone', SPEC, { project: 'Proof project' });
  project(box, 'stats-other', SPEC, { project: 'Proof project' });
  await box.inProcess(alpha.repo, 'add', 'web', 'Reworked item', '--specs', 'G1', '--criterion', 'survives rework');
  build(box, alpha, 1, 'reworked.txt');
  console.log('SHOW', box.run(alpha.repo, 'show', '1').slice(0, 300));
  console.log('SHOWWEB', box.run(alpha.web, 'show', '1').slice(0, 300));
  try { sendBack(box, alpha, 1, 'x'); } catch (e) { console.log('ERR', e.message); }
  console.log('AFTER', box.run(alpha.repo, 'show', '1').slice(0, 2500));
});
