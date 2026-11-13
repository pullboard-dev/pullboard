import { test } from 'node:test';
import { roadmapStagesBoard } from '../../../tests/fixtures/cockpit/roadmap-stages.js';
test('probe queue order [N26]', { timeout: 120_000 }, async () => {
  const { box, alpha } = await roadmapStagesBoard(() => {});
  console.log('PROBE-QUEUE\n' + await box.inProcess(alpha.repo, 'queue'));
  const show = JSON.parse(await box.inProcess(alpha.repo, 'show', '3', '--json'));
  console.log('PROBE-SHOW ' + JSON.stringify({ status: show.item_status, owner: show.item_owner, lease: show.item_lease_until, stage: show.item_stage }));
});
