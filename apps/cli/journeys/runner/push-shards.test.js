/** The pre-push gate offers its full suite as pull shard jobs over every available runner, heaviest file first, through the existing pull shards [C7,#1799]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claimJob } from '../../../../packages/api/index.js';
import { jobViews } from '../../../../packages/api/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { fixtureCommittedGraph } from '../../../../packages/store/tests/fixtures/cell.js';
import { openKitBoard } from '../../tests/fixtures/child.js';
import { offerPushShards } from '../../src/io/hook/push.js';
import { GATE_NEEDS } from '../../src/io/submit/pull.js';
import { pushShardPlan } from '../../src/io/hook/push.js';

const RUNNERS = 3;
const HEAVY = './test/heavy.test.js';
const NAMES = ['heavy', ...Array.from({ length: 11 }, (_, at) => `t${String(at + 1).padStart(2, '0')}`)];

/** A real committed repository of twelve test files with recorded times (one 300 s file, eleven of 60 s), and a command context over a real board file. */
function pushGateProject() {
  const project = fixtureCommittedGraph('pullboard-push-shards-');
  for (const name of NAMES) project.put(`test/${name}.test.js`, `import { test } from 'node:test';\ntest('${name}', () => {});\n`);
  project.commit();
  mkdirSync(join(project.root, '.git', 'pullboard'), { recursive: true });
  const files = Object.fromEntries(NAMES.map(name => [`test/${name}.test.js`, name === 'heavy' ? 300_000 : 60_000]));
  writeFileSync(join(project.root, '.git', 'pullboard', 'landing-file-times.json'), JSON.stringify({ files }));
  const file = join(project.root, '.git', 'pullboard', 'board.sqlite');
  // The seat is no primary checkout of a registered folder, so the offer starts no local runner of its own.
  const ctx = { file, config: { gate: 'node --test', pushGate: { sizeFromBoard: true, shardMinutes: 20 } }, clock: undefined, allowSchemaUpgrade: true,
    info: { root: project.root, isMain: false, commonDir: join(project.root, 'missing') }, io: { err() {} }, nativeBoard: { openBoard: (path, clock, options) => openKitBoard(path, clock, options) } };
  return { ...project, ctx, file };
}

test('clause 1: the full gate suite is offered as one pull shard job per runner, every file once, the heaviest file in the first shard [C7,#1799]', async () => {
  const box = pushGateProject();
  const plan = await pushShardPlan(box.root, box.ctx.config, { runners: RUNNERS });
  assert.equal(plan.shards.length, RUNNERS, 'one shard for each available runner');
  assert.deepEqual(plan.shards.flatMap(shard => shard.files).sort(), NAMES.map(name => `./test/${name}.test.js`).sort(), 'every tracked test file runs in exactly one shard');
  assert.ok(plan.shards[0].files.includes(HEAVY), 'the heaviest file leads the first shard');
  assert.ok(plan.shards.every(shard => shard.command.includes("'--test'") && shard.files.every(file => shard.command.includes(file.slice(2)))), 'each shard is the whole gate command over its own files');

  const { jobs, ref } = await offerPushShards(box.ctx, plan);
  assert.equal(jobs.length, RUNNERS);
  assert.equal(tryGit(box.root, ['rev-parse', ref]).stdout.trim(), plan.source, 'the pushed commit is pinned for the runners to fetch');

  const board = openKitBoard(box.file);
  try {
    const views = jobViews(board.db, jobs);
    assert.ok(views.every(view => view.kind === 'gate-shard' && view.step === 'offered'), JSON.stringify(views.map(view => [view.kind, view.step])));
    assert.ok(views.every(view => view.candidate === plan.source), 'each shard names the pushed commit');
    // Every registered runner pulls one shard, the heaviest-first shard goes to the first to ask, and a fourth finds none.
    const claims = Array.from({ length: RUNNERS }, (_, at) => claimJob(board.db, { runner: `runner-${at + 1}`, capabilities: GATE_NEEDS }));
    assert.deepEqual(claims.map(claim => claim?.job), jobs, 'the runners take the shards in order, heaviest first');
    assert.equal(new Set(claims.map(claim => claim.job)).size, RUNNERS, 'no shard is claimed twice');
    assert.equal(claimJob(board.db, { runner: 'runner-4', capabilities: GATE_NEEDS }), null, 'nothing is left over for a fourth runner');
    const heavy = views.map(view => JSON.stringify(view)).map(text => text.includes('test/heavy.test.js'));
    assert.deepEqual(heavy, [true, false, false], 'only the first shard carries the heaviest file');
  } finally { board.db.close(); }
});
