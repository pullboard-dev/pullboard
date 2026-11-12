/** Model-declared route defaults, board overrides, and scale admission for joined agents [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadConfig,
  defaults,
  configProblems,
} from '../../../../packages/config/index.js';
import { modelTierRoute } from '../../src/io/route.js';
import { scaleWorkers } from '../../src/io/scale.js';
import { HELP_SOURCE_SECTIONS } from '../../src/logic/help/declarations.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

test('clause 3: a no-flag Haiku join receives light work and a private board can override its tier [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const seat = join(box.dir, 'haiku-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
  box.env.PULLBOARD_MODEL = 'Claude 3 Haiku';
  const joined = await fixtureJoin(box.runLocal, seat, 'api', '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  assert.equal(JSON.parse(joined.out).route, 'light');

  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.modelTiers = [{ contains: 'haiku', route: 'strong' }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const overrideSeat = join(box.dir, 'override-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', overrideSeat, 'main');
  writeFileSync(join(overrideSeat, 'pullboard.json'), `${JSON.stringify(config, null, 2)}\n`);
  box.env.PULLBOARD_MODEL = 'Fixture Haiku';
  const overridden = await fixtureJoin(box.runLocal, overrideSeat, 'api', '--json');
  assert.equal(overridden.code, 0, overridden.err + overridden.out);
  assert.equal(JSON.parse(overridden.out).route, 'strong', 'the board-held table changes join routing in this fixture only');

  const unknownSeat = join(box.dir, 'unknown-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', unknownSeat, 'main');
  box.env.PULLBOARD_MODEL = 'Unlisted Vendor Model';
  box.env.PULLBOARD_FIXTURE_ROUTES = 'board';
  const unknown = await fixtureJoin(box.runLocal, unknownSeat, 'api', '--json');
  delete box.env.PULLBOARD_FIXTURE_ROUTES;
  assert.equal(unknown.code, 0, unknown.err + unknown.out);
  assert.equal(JSON.parse(unknown.out).route, 'mid', 'an unlisted model label falls back to mid');

  const light = await fixtureAdd(box.runLocal, box.repo, 'api', 'Light fixture item', '--specs', 'G2', '--route', 'mid',
    '--criterion', 'The fixture light item is available.', '--check', 'true', '--brief', 'Files: api/light.js\nChange: fixture\nTest: check passes', '--json');
  assert.equal(light.code, 0, light.err + light.out);
  const lightId = String(JSON.parse(light.out).item.item_id);
  const diagnosed = await box.runLocal(box.repo, 'fact', lightId, 'diagnosis',
    'Files: api/light.js\nChange: keep the fixture item eligible for a light seat\nTest case: a light seat selects this item', '--json');
  assert.equal(diagnosed.code, 0, diagnosed.err + diagnosed.out);
  const lowered = await box.runLocal(box.repo, 'edit', lightId, '--route', 'light', '--json');
  assert.equal(lowered.code, 0, lowered.err + lowered.out);
  const strong = await fixtureAdd(box.runLocal, box.repo, 'api', 'Strong fixture item', '--specs', 'G2', '--json');
  assert.equal(strong.code, 0, strong.err + strong.out);
  const offered = await box.runLocal(seat, 'next', '--build', '--json');
  assert.equal(offered.code, 0, offered.err + offered.out);
  assert.equal(JSON.parse(offered.out).item.item_id, JSON.parse(light.out).item.item_id,
    'the Haiku seat is offered its light item and cannot take the strong item');
});

test('clause 2: scale takes the declared model and tier from the current environment without a model argument [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox(), { withWorktree: false });
  const config = loadConfig(box.repo);
  const previous = process.env.PULLBOARD_MODEL;
  delete process.env.PULLBOARD_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = previous; });
  let launched;
  const deps = {
    context: () => ({ info: { isMain: true, root: box.repo }, config }),
    workerBudget: () => ({ spend: 1000, window: 'day' }),
    withBoard: (_ctx, read) => read({}),
    observe: () => ({ worth: 1, workers: [], reviews: 0, builds: 1 }),
    ledger: { record: () => ({ spend: 0, spent: null }) },
    worktreeFor: (io, lane, route, family, model) => {
      launched = { lane, route, family, model };
      io.result({ agent: 'fixture-worker', path: box.repo, prompt: 'fixture prompt' });
    },
  };
  const io = { say() {}, err() {} };
  await assert.rejects(scaleWorkers(io, { lane: 'api', agent: '/bin/true', cycles: '1', every: '5' }, deps),
    error => error.code === 'MODEL_REQUIRED', 'scale still requires the caller to declare its model');
  process.env.PULLBOARD_MODEL = 'Claude 3 Haiku';
  await scaleWorkers(io, { lane: 'api', agent: '/bin/true', cycles: '1', every: '5' }, deps);
  assert.deepEqual(launched, { lane: 'api', route: 'light', family: null, model: 'Claude 3 Haiku' });
});

test('clause 1: unknown models fall back to mid and model-tier configuration is validated [C7]', () => {
  assert.equal(modelTierRoute('Claude 3.5 Haiku', defaults().modelTiers), 'light');
  assert.equal(modelTierRoute('Claude 3.7 Sonnet', defaults().modelTiers), 'mid');
  assert.equal(modelTierRoute('unlisted test model', defaults().modelTiers), 'mid');
  assert.equal(configProblems({ ...defaults(), modelTiers: [{ contains: '', route: 'strong' }] })
    .filter(problem => problem.includes('modelTiers')).length, 1);
  const setupHelp = HELP_SOURCE_SECTIONS.find(section => section.name === 'setup').text;
  assert.match(setupHelp, /pullboard join <lane> --model <name> \[--family/u);
  assert.doesNotMatch(setupHelp, /pullboard join <lane>[^\n]*--route/u);
});
