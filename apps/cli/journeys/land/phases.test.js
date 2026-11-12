/** A one-item landing batch times its merge, static checks and CLI smoke as landing phases [C7,B3]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { PHASE_LINE } from '../../../../packages/landing/index.js';
import { readLandingSpans } from '../../../../packages/resources/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktreeLocal, commitItemLocal, submitItemLocal, acceptItemLocal } = makeLandProjectFixtures(e2e);

test('clause 1, clause 2: a one-item batch lands with merge, static checks and CLI smoke each said and recorded as a landing phase [C7,B3]', { timeout: 300_000 }, // budget: one real submit, accept and landing; hang ceiling only, no speed threshold.
async () => {
  const box = landProject();
  const started = Date.now() - 1000;
  const entry = await itemWorktreeLocal(box, 1, 'web/land-1.test.js');
  await commitItemLocal(box, entry, 'PASS\n');
  await submitItemLocal(box, entry);
  await acceptItemLocal(box, entry);
  // The acceptance proof is for the old main; a real later change makes the batch run its landing guards.
  writeFileSync(join(box.repo, 'main-advance.txt'), 'main changed after acceptance\n');
  box.git(box.repo, 'add', 'main-advance.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main before landing');
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, `${landed.err}\n${landed.out}`);
  const result = JSON.parse(landed.out);
  const said = new Set();
  for (const line of `${landed.err}\n${(result.diagnostics ?? []).join('\n')}`.split('\n')) {
    const found = PHASE_LINE.exec(line.trim());
    if (found) said.add(found[1]);
  }
  for (const name of ['merge', 'static checks', 'cli smoke']) assert.ok(said.has(name), `the landing said no "landing phase ${name}" line; said: ${[...said].join(', ')}`);
  const spans = new Set(readLandingSpans(join(box.repo, '.git'), { since: started }).map(span => span.phase));
  for (const phase of ['compose', 'static', 'smoke']) assert.ok(spans.has(phase), `no "${phase}" landing span recorded; recorded: ${[...spans].join(', ')}`);
});
