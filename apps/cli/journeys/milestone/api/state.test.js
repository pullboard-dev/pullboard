import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiFetch } from '../../../tests/fixtures/api.js';
import { addLightViaCli } from '../../../tests/fixtures/api.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { runLocal } from '../../../tests/fixtures/api/milestone.js';
import { jsonError } from '../../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../../tests/fixtures/api/milestone.js';

test('[N26,A2] roadmap text, JSON and API state follow live local and registered repo items', async (t) => {
  const box = project();
  const foreign = project();
  const foreignConfigFile = join(foreign.repo, 'pullboard.json');
  const foreignConfig = JSON.parse(readFileSync(foreignConfigFile, 'utf8'));
  foreignConfig.name = 'foreign';
  writeFileSync(foreignConfigFile, `${JSON.stringify(foreignConfig, null, 2)}\n`);
  const registryFile = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  registry.projects.push({ root: foreign.repo, name: 'foreign', project: '', added: '2026-10-08T00:00:00.000Z' });
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const addArgs = (title) => [
    'app', title, '--route', 'mid', '--criterion', 'roadmap item', '--check', 'true',
    '--brief', 'Files:\n- app/roadmap.js\nChange: track this work\nTest: inspect its status',
  ];
  const localItem = addLightViaCli(json, box, box.repo, addArgs('Local release')).item;
  const externalItem = addLightViaCli(json, foreign, foreign.repo, addArgs('External follow-up')).item;
  const worktree = json(box, box.repo, 'worktree', ['app', '--route', 'light'], 'worktree');

  json(box, box.repo, 'milestone', ['add', 'Delivery', '--note', 'Ship the release', '--reason', 'Arrange fixture release', '--items', `${localItem.item_id},foreign#${externalItem.item_id}`], 'add');
  json(box, box.repo, 'milestone', ['add', 'Aftercare'], 'add');
  json(box, box.repo, 'milestone', ['move', 'Aftercare', '--before', 'Delivery'], 'move');
  await jsonError(box, worktree.path, 'milestone', ['add', 'Forbidden'], {
    status: 1,
    code: 'COORDINATOR_ONLY',
    message: 'only the coordinator changes milestones; ask your coordinator to update the roadmap',
    next: 'ask your coordinator to update the roadmap',
  }, 'add');
  const claim = await runLocal(box, worktree.path, 'claim', String(localItem.item_id), '--json');
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);

  const textRoadmap = await runLocal(box, box.repo, 'roadmap');
  assert.equal(textRoadmap.status, 0, textRoadmap.stderr);
  assert.ok(textRoadmap.stdout.includes('Aftercare: 0/0 landed') && textRoadmap.stdout.indexOf('Aftercare: 0/0 landed') < textRoadmap.stdout.indexOf('Delivery: 0/2 landed'),
    'the roadmap counts landed items, in milestone order');
  assert.match(textRoadmap.stdout, /Ship the release/);
  assert.match(textRoadmap.stdout, new RegExp(`#${localItem.item_id} Local release — claimed`));
  assert.match(textRoadmap.stdout, new RegExp(`foreign#${externalItem.item_id} External follow-up — open`));

  const document = json(box, box.repo, 'roadmap');
  assert.deepEqual(document.milestones.map(({ name }) => name), ['Aftercare', 'Delivery']);
  assert.deepEqual(document.milestones[1].items.map(({ status }) => status), ['claimed', 'open']);
  // The handler reads the project registry from this process's home, as the served board's own process does with the box's [N26].
  const previousHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  t.after(() => { if (previousHome === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = previousHome; });
  const api = await startLocalHandler(t, box);
  const listing = await (await apiFetch(api, '/api/v1/boards')).json();
  const current = listing.boards.find((candidate) => candidate.root === box.repo);
  const response = await apiFetch(api, `/api/v1/boards/${current.id}/state`);
  const state = await response.json();
  assert.equal(response.status, 200);
  const shape = (milestones) => milestones.map(({ name, count, landed, total, withdrawn, items }) => ({ name, count, landed, total, withdrawn, items: items.map(({ id, state }) => [id, state]) })); assert.deepEqual(shape(state.state.milestones), shape(document.milestones)); // state keeps no per-item progress or idle clock (#6665)
});
