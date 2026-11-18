/** The seat scaler opens a reviewer of the other family when reviews wait on a family no free seat belongs to [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReviewFamilySeats } from '../../../src/io/scale.js';
import { scaleCycle } from '../../../src/io/scale.js';
import { scaleWorkers } from '../../../src/io/scale.js';

const MINUTE = 60_000;
const SCALER_MODEL = 'Scaler fixture';
const FAMILIES = ['anthropic', 'openai'];
const waiting = (family, waitedMs, route = 'strong') => ({ family, waitedMs, route });

/** Run one real supervisor cycle over an observed queue; return the seats it asked the worktree maker for. */
async function supervise(t, observed) {
  const previous = process.env.PULLBOARD_MODEL;
  process.env.PULLBOARD_MODEL = SCALER_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = previous; });
  const made = [], lines = [], children = [];
  const io = { say: line => lines.push(line), err: line => lines.push(line), result() {} };
  const deps = {
    context: () => ({ info: { isMain: true }, config: {} }),
    withBoard: (ctx, read) => read({}),
    workerBudget: () => ({ spend: 96, window: 'day' }),
    observe: () => observed,
    ledger: { record: () => ({ spend: 0, spent: null }) },
    worktreeFor: async (sink, lane, route, family) => {
      made.push({ lane, route, family });
      sink.result({ agent: `seat-${made.length}`, path: `/fixture/seat-${made.length}`, prompt: 'work' });
    },
    spawn: () => { const child = { pid: 0, exitCode: null, signalCode: null, once() {} }; children.push(child); return child; },
  };
  const code = await scaleWorkers(io, { lane: 'web', agent: 'true', route: 'strong', cycles: 1, every: '5' }, deps);
  assert.equal(code, 0);
  return { made, lines, children };
}

const queue = (extra = {}) => ({ worth: 4, reviews: 2, builds: 0, workers: [{ id: 'o1', busy: false, managed: false }],
  seats: [{ id: 'o1', family: 'openai', busy: false }], families: FAMILIES,
  waiting: [waiting('openai', 11 * MINUTE, 'light'), waiting('openai', 12 * MINUTE, 'mid')], ...extra });

test('cli.io-commands-queue.family-a-reviews-waiting-over-10-minutes: clause 1: family A reviews waiting over 10 minutes with no free other-family reviewer open one other-family seat [C7]', async t => {
  const { made, lines, children } = await supervise(t, queue());
  const opened = made.filter(seat => seat.family === 'anthropic');
  assert.equal(opened.length, 1, 'one reviewer seat of the family other than the builders is created');
  assert.ok(children.length >= 1, 'the created seat is launched');
  assert.match(lines.join('\n'), /opened a anthropic reviewer on mid for openai reviews/u);
  assert.deepEqual(planReviewFamilySeats({ waiting: [waiting('openai', 11 * MINUTE)], seats: [{ family: 'openai', busy: false }], families: FAMILIES }),
    [{ family: 'anthropic', route: 'strong', for: 'openai' }]);
  assert.deepEqual(planReviewFamilySeats({ waiting: [waiting('openai', 9 * MINUTE)], seats: [], families: FAMILIES }), [], 'ten minutes have not passed');
  assert.deepEqual(planReviewFamilySeats({ waiting: [waiting('openai', 11 * MINUTE)], seats: [{ family: 'anthropic', busy: false }], families: FAMILIES }), [],
    'a free reviewer of the other family already exists');
  assert.deepEqual(planReviewFamilySeats({ waiting: [waiting('openai', 11 * MINUTE)], seats: [{ family: 'anthropic', busy: true }], families: FAMILIES }),
    [{ family: 'anthropic', route: 'strong', for: 'openai' }], 'a busy other-family seat cannot take the review');
  assert.deepEqual(planReviewFamilySeats({ waiting: [waiting('openai', 11 * MINUTE)], seats: [], families: ['openai'] }), [], 'no other family is known');
});

test('cli.io-commands-queue.the-new-seat-takes-the-lowest-route: clause 2: the new seat takes the lowest route that can review every waiting item [C7]', async t => {
  const { made } = await supervise(t, queue());
  assert.equal(made.find(seat => seat.family === 'anthropic').route, 'mid', 'a light and a mid item need a mid seat, not strong');
  const light = await supervise(t, queue({ waiting: [waiting('openai', 11 * MINUTE, 'light'), waiting('openai', 20 * MINUTE, 'light')] }));
  assert.equal(light.made.find(seat => seat.family === 'anthropic').route, 'light');
  const launched = [];
  const plan = await scaleCycle({ observe: () => ({ ...queue(), budget: { spend: 0, window: 'day' }, usedSpend: 0, cycleHours: 1, hoursLeft: 1 }), isIdle: () => true, stop() {}, launch: async open => launched.push(open) });
  assert.deepEqual(plan.opened, [], 'a budget with nothing left opens no extra seat');
  assert.equal(launched.length, 0);
});
