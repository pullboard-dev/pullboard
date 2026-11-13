import { test } from 'node:test';
import { roadmapStagesBoard } from '../../../tests/fixtures/cockpit/roadmap-stages.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';
test('probe queue order [N26]', { timeout: 120_000 }, async () => {
  const { box, alpha } = await roadmapStagesBoard(() => {});
  const view = await startView(box);
  try {
    const state = await boardOf(view, alpha.repo);
    console.log('PROBE-MS ' + JSON.stringify(state.milestones.map(m => [m.name, m.items.map(i => [i.id, i.position, i.state, i.status])])));
  } finally { await view.stop(); }
});
