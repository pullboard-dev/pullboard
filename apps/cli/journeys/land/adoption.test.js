import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { events } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { startInterruptedLanding } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise landing adoption against real private Git worktrees [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { FILES, landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Four independent submitted items accepted in order, each step answered in this process so the file stays inside its budget [B3,R3]. */
async function verifiedFourLocal(box) {
  box.env.LAND_SUPPRESS_RED = '1';
  try {
    const entries = [];
    for (const [index, file] of FILES.entries()) entries.push(await itemWorktreeLocal(box, index + 1, file));
    await Promise.all(entries.map(entry => commitItemLocal(box, entry)));
    for (const entry of entries) await submitItemLocal(box, entry);
    for (const entry of entries) await acceptItemLocal(box, entry);
    return entries;
  } finally { delete box.env.LAND_SUPPRESS_RED; }
}

test('land adoption recovers an interrupted gate and keeps one receipt under a new coordinator [B3,R3]', async (t) => {
  const box = landProject();
  const entries = await verifiedFourLocal(box);
  writeFileSync(box.hold, 'armed');
  const { child, closed, waitForGate } = startInterruptedLanding(box, BIN, t);
  await waitForGate();
  const card = json(box, box.repo, 'resume');
  const batch = card.landingBatches.at(-1);
  assert.equal(batch.state, 'gating');
  assert.match(batch.logPath, /batch-\d+\.log$/u);
  assert.equal(batch.items.length, 4);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await closed).signal, 'SIGKILL');
  writeFileSync(box.release, 'release');
  const refused = box.run(box.repo, 'land', '--json');
  assert.equal(JSON.parse(refused.out).error?.code, 'LAND_ADOPT');
  box.env.CODEX_THREAD_ID = 'private-adopting-coordinator';
  const adopted = json(box, box.repo, 'land', '--adopt');
  delete box.env.CODEX_THREAD_ID;
  assert.equal(adopted.batch.id, batch.id);
  assert.notEqual(adopted.batch.owner, batch.owner);
  assert.deepEqual(adopted.landed, entries.map((entry) => entry.item));
  assert.equal(events(box).filter((event) => event.event_kind === 'main-moved').length, 1);
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});
