/** Synthetic provider counters distinguish missing claim checkpoints from discovery failures [N2]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { checkpointAfterMove } from '../../../../../packages/stats/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Keep native fixture identity and provider bytes entirely inside the sandbox. */
function fixture({ missing = false, locked = false } = {}) {
  const box = helpers.project('true');
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CODEX_CI', 'CODEX_SHELL']) delete env[key];
  env.CODEX_THREAD_ID = 'synthetic-claim-anchor';
  const directory = join(env.CODEX_HOME, 'sessions');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'rollout-synthetic-claim-anchor.jsonl');
  /** Append numeric native-shaped usage, never provider prompt or conversation content. */
  const usage = (input, output) => appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } } }) + '\n');
  if (!missing) usage(10, 1);
  // @pullboard-board-file journey: seed the real repository board shared by the native CLI claim and submit.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try {
    item = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Synthetic usage anchor control', criterion: 'the fixture change exists', specIds: ['G1'], check: 'test -f web/ready', checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
  } finally { store.closeBoard(board); }
  /** Run the actual native CLI while retaining diagnostics for the discriminating control. */
  const run = (...args) => {
    const result = runFixtureChild(process.execPath, [helpers.BIN, ...args], { cwd: box.web, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args[0]}: ${result.stdout}${result.stderr}`);
    return result;
  };
  const lock = join(box.repo, '.git/pullboard/cost-ledger.json.lock');
  if (locked) writeFileSync(lock, 'synthetic competing ledger writer');
  const claim = run('claim', String(item), '--json');
  if (locked) unlinkSync(lock);
  return { box, file, item, claim, usage, run };
}

test('a normal native claim, work and submit preserves its real counter anchor [N2]', () => {
  const control = fixture();
  const { box, item, usage, run } = control;
  assert.doesNotMatch(JSON.stringify(JSON.parse(control.claim.stdout).diagnostics ?? []), /USAGE_PENDING/);
  const ledger = JSON.parse(readFileSync(join(box.repo, '.git/pullboard/cost-ledger.json'), 'utf8'));
  assert.ok(ledger.active.some(entry => entry.item === item && entry.snapshot && !entry.recovered));
  usage(37, 6);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/ready'), 'ready\n');
  box.git(box.web, 'add', 'web/ready');
  box.git(box.web, 'commit', '-qm', 'feat(web): synthetic usage work [G1]');
  run('submit', String(item), '--no-next', '--json');
  const shown = JSON.parse(run('show', String(item), '--json').stdout);
  assert.equal(shown.usage.inputTokens, 27);
  assert.equal(shown.usage.outputTokens, 5);
  assert.ok(!shown.usage.unknownReasons.includes('missed-claim-anchor'));
});

test('a synthetic claim-time ledger lock alone produces recovered missed-claim-anchor [N2]', () => {
  const { item, claim, usage, run } = fixture({ locked: true });
  assert.match(JSON.stringify(JSON.parse(claim.stdout).diagnostics), /USAGE_PENDING/);
  assert.match(JSON.stringify(JSON.parse(claim.stdout).diagnostics), /stage=private-ledger/);
  usage(37, 6);
  run('release', String(item), '--reason', 'OTHER', '--note', 'Close the usage-anchor fixture claim.', '--no-next');
  const shown = JSON.parse(run('show', String(item), '--json').stdout);
  assert.equal(shown.usage.inputTokens, null);
  assert.equal(shown.usage.outputTokens, null);
  assert.ok(shown.usage.unknownReasons.includes('missed-claim-anchor'));
});

test('provider discovery failure with a persisted claim is distinct from a missed claim checkpoint [N2]', () => {
  const { item, claim, run } = fixture({ missing: true });
  assert.doesNotMatch(JSON.stringify(JSON.parse(claim.stdout).diagnostics ?? []), /USAGE_PENDING/);
  run('release', String(item), '--reason', 'OTHER', '--note', 'Close the usage-anchor fixture claim.', '--no-next');
  const shown = JSON.parse(run('show', String(item), '--json').stdout);
  assert.equal(shown.usage.inputTokens, null);
  assert.ok(shown.usage.unknownReasons.includes('native-session-unavailable'));
  assert.ok(!shown.usage.unknownReasons.includes('missed-claim-anchor'));
});

test('unexpected checkpoint failures expose only a fixed stage and preserve lifecycle success [N2]', async () => {
  const diagnostics = [];
  const ctx = {
    clock: {
      /** Fail before any source read using explicitly synthetic private-looking input. */
      now() { throw Object.assign(new Error('synthetic private provider path and session'), { code: 'SYNTHETIC_PRIVATE_ID' }); },
    },
    io: {
      /** Collect the actual public checkpoint diagnostic without exposing the thrown error. */
      err(message) { diagnostics.push(message); },
    },
  };
  await checkpointAfterMove(ctx, {}, {});
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /USAGE_PENDING: \[stage=checkpoint\]/);
  assert.match(diagnostics[0], /lifecycle move was recorded/);
  assert.doesNotMatch(diagnostics[0], /synthetic|provider path|SYNTHETIC_PRIVATE_ID/);
});
