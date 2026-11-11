/** @pullboard-test-input apps/cli/src/io/commands/submit.js */
/** Durable B0: driveOnce runs a whole submit gate with the hand-off worker's own sections and result [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import {
  openBoard,
  closeBoard,
} from '../../../lib/src/logic/native.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { runGateStages } from '../../../../packages/gate/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import {
  driveOnce,
  gateSections,
} from '../../../../packages/drive/index.js';
import {
  handoffGate,
  drivenHandoffGate,
  handoffRefusedResult,
} from '../../src/io/submit/handoff/worker.js';

const SUBMIT_SOURCE = new URL('../../src/io/commands/submit.js', import.meta.url);

/** The stage names canonical Submit hands its stage runner, in the order its source declares them. */
function submitStageOrder() {
  const source = readFileSync(SUBMIT_SOURCE, 'utf8');
  const call = source.indexOf('(ctx.runGateStages ?? runGateStages)([');
  assert.ok(call > 0, 'submitHere passes its stages through ctx.runGateStages when a driver sets it');
  const end = source.indexOf('\n  ]);', call);
  return [...source.slice(call, end).matchAll(/^ {4}(?:\.\.\.\(remoteMode \? \[)?\{ name: '([a-z]+)'/gmu)].map(match => match[1]);
}

/** A repo with one commit, so the gate job has a candidate tree to capture. */
function candidateRepo() {
  const files = privateFixtureFiles('pullboard-b0-repo-');
  runFixtureGit(['-C', files.root, 'init', '-q']);
  runFixtureGit(['-C', files.root, 'config', 'user.email', 'b0@example.test']);
  runFixtureGit(['-C', files.root, 'config', 'user.name', 'B0 Test']);
  files.write('a.txt', 'candidate\n');
  runFixtureGit(['-C', files.root, 'add', '-A']);
  runFixtureGit(['-C', files.root, 'commit', '-q', '-m', 'candidate']);
  return { repo: files.root, commit: runFixtureGit(['-C', files.root, 'rev-parse', 'HEAD']) };
}

/** Open a fresh in-memory board and hand its SQLite handle to the body. */
async function withBoard(body) {
  const board = openBoard(':memory:');
  try { return await body(board.db); } finally { closeBoard(board); }
}

/**
 * A stand-in for canonical Submit that calls its stage runner exactly as submitHere does, with Submit's stage names in
 * Submit's order, and logs each stage it runs. `red` names a stage that refuses as a gate red.
 */
function submitLike(names, log, { red = null, commit } = {}) {
  return async ctx => {
    await (ctx.runGateStages ?? runGateStages)(names.map(name => ({ name, run: async () => {
      log.push(name);
      if (name === red) throw new Refused('GATE_RED', `${name} is red`);
      return { name };
    } })));
    ctx.submissionResult.value = { commit };
  };
}

/** Drive a whole-gate job through every transition and return the final job view. */
async function driveGate(db, repo, commit, gate) {
  createJob(db, { id: 'gate-b0', kind: 'gate', item: 7, candidate: commit, base: commit, now: 1 });
  let clock = 10_000;
  const phases = [];
  for (let step = 0; step < 4; step += 1) {
    clock += 1000;
    const moved = await driveOnce(db, 'gate-b0', { owner: 'driver-b0', repo, gate, now: () => clock });
    phases.push(moved.transition);
  }
  return { phases, job: (await driveOnce(db, 'gate-b0', { owner: 'driver-b0', repo, gate, now: () => clock })).job };
}

test('clause 1: drive runs every gate section [C7]', async () => {
  const names = submitStageOrder();
  assert.deepEqual(names, ['preflight', 'selection', 'cells', 'doctrine', 'static', 'tests'], 'Submit\'s own stage list');
  const { repo, commit } = candidateRepo();
  const request = { item: 7 };

  // The hand-off worker's gate, run as the worker runs it.
  const workerLog = [];
  const workerResult = await handoffGate({}, request, { waitInventory: async () => null, submit: submitLike(names, workerLog, { commit }) });

  await withBoard(async db => {
    const driveLog = [];
    const ctx = {};
    const { phases, job } = await driveGate(db, repo, commit, drivenHandoffGate(ctx, request, { waitInventory: async () => null, submit: submitLike(names, driveLog, { commit }) }));
    assert.deepEqual(phases, ['captured', 'running', 'collected', 'verdict']);
    assert.deepEqual(driveLog, workerLog, 'the driven gate runs the worker\'s stage functions, the same ones in the same order');
    const collected = job.steps.find(step => step.name === 'collected').payload;
    assert.deepEqual(collected.order, names, 'the job records the worker\'s section order');
    assert.deepEqual(job.steps.filter(step => step.name === 'section.done').map(step => step.payload.section), names, 'one section step per section');
    assert.deepEqual(collected.result, workerResult, 'the job records the result the worker records');
    assert.deepEqual(collected.result, { code: 0, commit });
    const verdict = job.steps.find(step => step.name === 'verdict').payload;
    assert.equal(verdict.verdict, 'green');
    assert.deepEqual(Object.keys(verdict.sections), ['static', 'criterion', 'proof', 'cells', 'comparison']);
    assert.equal(ctx.runGateStages, undefined, 'the observer is removed once the gate ends');
  });

  // A red section: the same refusal the worker records, and a red verdict naming it.
  let workerRefusal;
  try { await handoffGate({}, request, { waitInventory: async () => null, submit: submitLike(names, [], { red: 'cells', commit }) }); }
  catch (error) { workerRefusal = handoffRefusedResult(error); }
  await withBoard(async db => {
    const { job } = await driveGate(db, repo, commit, drivenHandoffGate({}, request, { waitInventory: async () => null, submit: submitLike(names, [], { red: 'cells', commit }) }));
    const collected = job.steps.find(step => step.name === 'collected').payload;
    assert.deepEqual(collected.result, workerRefusal, 'a red gate records the worker\'s refusal');
    assert.equal(collected.sections.cells.outcome, 'fail');
    assert.equal(collected.sections.cells.code, 'GATE_RED');
    const verdict = job.steps.find(step => step.name === 'verdict').payload;
    assert.equal(verdict.verdict, 'red');
    assert.equal(verdict.sections.cells.outcome, 'fail');
  });
});

test('gateSections judges a refusal outside every stage as a failed proof [C7]', () => {
  const sections = gateSections({ sections: {}, result: { code: 1, error: { code: 'MOVED_DURING_GATE' } } });
  assert.deepEqual(sections.proof, { outcome: 'fail', code: 'MOVED_DURING_GATE' });
  assert.deepEqual(sections.static, { outcome: 'skip' });
});
