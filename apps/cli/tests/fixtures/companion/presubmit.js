/** Shared fixture for the claimed-companion presubmit journeys: real Git, a persistent board and a lane author's attached patch [C7,V4,H16]. */
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../e2e.js';
import { fixtureJoin } from '../testkit.js';

/** Require the real CLI document, retaining exact diagnostics for every fixture setup refusal. */
export function document(result) {
  assert.equal(result.code, 0, result.err + '\n' + result.out);
  return JSON.parse(result.out);
}

/** Make independent private lane seats without changing the source under test. */
export function seat(box, name, lane) {
  const root = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '--detach', root, 'main');
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = name;
  let id;
  try { id = document(fixtureJoin(box.run, root, lane, '--json')).agent; }
  finally { if (previous === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previous; }
  return { root, id, session: name };
}

/** Run through the normal session binding, restoring the fixture environment after each command. */
export async function run(box, actor, ...args) {
  const before = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = actor.session;
  try { return await box.runLocal(actor.root, ...args, ...(['submit', 'verify', 'release', 'next'].includes(args[0]) ? ['--no-next'] : []), '--json'); }
  finally { if (before === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = before; }
}

/** Preserve the same authenticated fixture identity while installed Git hooks call the native CLI. */
export function actorGit(box, actor, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = actor.session;
  try { return box.git(actor.root, ...args); }
  finally { if (previous === undefined) delete box.env.CODEX_THREAD_ID; else box.env.CODEX_THREAD_ID = previous; }
}

/** Build real Git and persistent SQLite state with a core command requiring its view companion. */
export async function fixture(t, { hold = false, deferred = false, check = 'node core/cli.cjs' } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (deferred) config.submitGate = 'landing';
  config.lanes.core = { owns: ['core/'], specs: ['G1'] };
  config.lanes.view = { owns: ['view/'], specs: ['G2'] };
  // Seat routes come from the board's model table since b95e1aa538.
  config.modelTiers = [{ contains: box.env.PULLBOARD_MODEL, route: 'strong' }];
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-m', 'chore: private companion lane policy');
  const coordinator = { root: box.repo, session: box.env.CODEX_THREAD_ID };
  const builder = seat(box, 'presubmit-builder', 'core');
  const author = seat(box, 'presubmit-author', 'view');
  const id = document(await run(box, coordinator, 'add', 'core', 'Core command needs its view import',
    '--specs', 'G1', '--criterion', 'The real core command imports the approved view module.',
    '--check', check)).item.item_id;
  document(await run(box, builder, 'claim', String(id)));
  mkdirSync(join(builder.root, 'core'));
  const entered = join(box.dir, 'entered'), release = join(box.dir, 'release');
  const pause = hold ? `const fs = require('node:fs');fs.writeFileSync(${JSON.stringify(entered)}, 'entered');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\n` : '';
  writeFileSync(join(builder.root, 'core/cli.cjs'), pause + "const assert = require('node:assert/strict');\nassert.equal(require('../view/header.cjs'), 'approved view');\nconsole.log('TAP version 13\\nok 1 - actual approved view import\\n1..1');\n");
  box.git(builder.root, 'add', 'core/cli.cjs');
  actorGit(box, builder, 'commit', '-m', 'feat(core): use the companion view [G1]');
  const source = box.git(builder.root, 'rev-parse', 'HEAD');
  const patch = [
    'diff --git a/view/header.cjs b/view/header.cjs', 'new file mode 100644',
    '--- /dev/null', '+++ b/view/header.cjs', '@@ -0,0 +1 @@', "+module.exports = 'approved view';", '',
  ].join('\n');
  const patchFile = join(box.dir, 'view.patch');
  writeFileSync(patchFile, patch);
  // @pullboard-board-file journey: inspect actual CLI attachment, proof and submit events on the persistent fixture board
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return { box, board, coordinator, builder, author, id, source, patch, patchFile, helpers, entered, release };
}

/** Attach the lane author's exact immutable bytes through the real coordinator CLI. */
export async function attach(f, key = 'approved-view', source = f.source, file = f.patchFile, author = f.author.id) {
  return document(await run(f.box, f.coordinator, 'patch', 'attach', String(f.id), file,
    '--key', key, '--author', author, '--source', source));
}

/** Produce a second genuine phase pair on the same private item, retaining native admission and receipt writing. */
export async function repeatNativePhases(f, binding) {
  const gate = new URL('../../../../../packages/gate/index.js', import.meta.url).href;
  const script = join(f.box.dir, 'repeat-phases.mjs');
  // The store front door replaced src/board.js in #1776.
  writeFileSync(script, `import * as store from ${JSON.stringify(new URL('../../../../../packages/store/index.js', import.meta.url).href)};
import { openBoard } from ${JSON.stringify(new URL("../../../../lib/src/logic/native.js", import.meta.url).href)};
import { runSubmitGate, submitGateConfig } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import { withItemPatchSubmit } from ${JSON.stringify(new URL('../../../../../packages/items/index.js', import.meta.url).href)};
import { policyAt, frozenCheck, mainPolicy } from ${JSON.stringify(new URL('../../../../../packages/sandbox/index.js', import.meta.url).href)};
const root = process.cwd();
// @pullboard-board-file journey: record actual native proof receipts on the same persistent CLI fixture board
const board = openBoard(${JSON.stringify(join(f.box.repo, '.git/pullboard/board.sqlite'))});
try {
  const item = store.getItem(board, ${f.id});
  const main = mainPolicy(root);
  const config = submitGateConfig(policyAt(root, ${JSON.stringify(binding.commit)}).config, main.config);
  const gate = await withItemPatchSubmit(root, ${JSON.stringify(binding)}, checkout => runSubmitGate(checkout, config,
    { executionServices, base: item.item_claim_head, trunk: main.commit, check: frozenCheck(item), agent: ${JSON.stringify(f.builder.id)}, item: item.item_id,
      proofContext: { companion: true, item: item.item_id, frozenDigest: item.item_frozen_digest, seat: ${JSON.stringify(f.builder.id)} } }));
  if (!gate.isGreen) throw new Error(gate.output);
  for (const id of gate.proofReceiptIds) store.recordProofRun(board, { agentId: ${JSON.stringify(f.builder.id)}, itemId: item.item_id, receiptId: id });
  console.log(JSON.stringify(gate.proofReceiptIds));
} finally { store.closeBoard(board); }
`);
  const before = f.box.env.CODEX_THREAD_ID;
  f.box.env.CODEX_THREAD_ID = f.builder.session;
  let child;
  try { child = f.helpers.launch(f.box, f.builder.root, process.execPath, [script]); }
  finally { if (before === undefined) delete f.box.env.CODEX_THREAD_ID; else f.box.env.CODEX_THREAD_ID = before; }
  const result = await child.closed;
  assert.equal(result.code, 0, child.stdoutText + child.stderrText);
  return JSON.parse(child.stdoutText.trim().split('\n').at(-1));
}
