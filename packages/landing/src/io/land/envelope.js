import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
/** Final exact-head native receipt for opt-in native landings; floors retain their separate evidence [B3,C7]. */
import { copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { headCommit } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { untracked } from '../../../../git/index.js';
import { runGate } from '../../../../gate/index.js';
import { createLandingEnvelope } from '../../logic/envelope.js';
import { readTrainLandingReceipt } from '../train/receipt.js';
import { Refused } from '../../../../kernel/index.js';

/**
 * Gate the final envelope using the unmodified accepted command, never an augmented floor or a tree-only cache.
 * The batch keeps its original UUID, review identities and fence; recording it uses the shared finishing writer.
 */
export async function finalizeLandingEnvelope(state, save, observer) {
  if (state.config.landing?.requireReceipts !== true) return;
  await state.checkLease();
  let batch = state.batch;
  if (batch.proof?.receipt) {
    const receipt = readTrainLandingReceipt(batch.root, state.board, batch.proof.receipt.id, batch.tip);
    if (receipt.tree !== batch.proof.tree || headCommit(batch.root) !== batch.tip
      || !isClean(batch.root) || untracked(batch.root).length) {
      throw new Refused('LAND_SOURCE_CHANGED', 'restore the exact recorded envelope before adopting its native receipt');
    }
    return;
  }
  if (batch.state === 'pushed') throw new Refused('LAND_RECEIPT_REQUIRED',
    'the already-pushed legacy batch has no exact envelope receipt; inspect its publication before enabling receipts');
  const side = headCommit(batch.root);
  const envelope = createLandingEnvelope(batch.root, { base: batch.base, side, items: batch.items,
    message: `chore: land verified batch ${batch.id}` });
  const terminalState = batch.state;
  await save(state, { state: 'gating', tip: envelope.tip, items: envelope.items,
    envelope: { version: 1, base: batch.base, side, tip: envelope.tip } });
  batch = state.batch;
  const run = await runGate(batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, trustStamp: false, landing: true,
    agent: 'coordinator', stages: true, quarantines: state.landingPorts.quarantineVerdictSnapshot(state.board), onWait: state.onWait, onFailure: observer() });
  const logPath = join(dirname(batch.root), 'logs', `envelope-${batch.revision}.log`);
  copyFileSync(run.log, logPath);
  if (run.profilePath) copyFileSync(run.profilePath, `${logPath}.profile.json`);
  await state.checkLease();
  if (headCommit(batch.root) !== envelope.tip || headTree(batch.root) !== envelope.tree
    || !isClean(batch.root) || untracked(batch.root).length) {
    throw new Refused('LAND_SOURCE_CHANGED', `the gated envelope changed; inspect ${logPath} before adopting`);
  }
  if (!run.isGreen || !run.receiptId) {
    await save(state, { state: 'blocked', envelopeLogPath: logPath });
    throw new Refused('GATE_RED', `the exact envelope lacks a native green receipt; inspect ${logPath}`);
  }
  const receipt = readTrainLandingReceipt(batch.root, state.board, run.receiptId, envelope.tip);
  await save(state, { state: terminalState, proof: { ...batch.proof, tree: envelope.tree,
    receipt, envelope: batch.envelope, logPath }, envelopeLogPath: logPath });
}
