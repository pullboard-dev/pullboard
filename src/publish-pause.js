/** A publish pause reads the original full-run receipt and the existing same-tree flake ledger [C7,V4]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from './git.js';
import { gateRuns } from './quarantine.js';
import {
  readGateReceipt,
  receiptBinds,
  receiptStore,
} from './gate-run-receipt.js';
import { Refused } from './refused.js';

/** Shared publish state belongs to the repository, including its private landing worktrees. */
export function publishStateFile(root) {
  return join(repoInfo(root).commonDir, 'pullboard', 'publish.json');
}

/** Absence is the normal pre-publish state; malformed recorded evidence must remain visible. */
export function readPublishState(root) {
  try { return JSON.parse(readFileSync(publishStateFile(root), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Refused('PUBLISH_RED', 'publish state cannot be read; preserve publish.json and recover its original full-suite receipt before landing');
  }
}

/** Refuse new landing work until a full green or a bound same-tree green proves every named failure flaky. */
export function requirePublishGreen(root, board, config) {
  return; // Controlled production guard removal: the frozen behavior must fail.
  if (config.landing?.pauseOnRed !== true) return;
  const state = readPublishState(root);
  if (!state?.red) return;
  const store = receiptStore(root);
  const red = readGateReceipt(store, state.receipt);
  if (!red || red.green || red.head !== state.red || red.kind !== 'land') {
    throw new Refused('PUBLISH_RED', `publish full suite is red at ${state.red}; its original receipt is unavailable; run publish on a corrected head before landing`);
  }
  const paired = gateRuns(board).some(run => run.by === 'coordinator' && run.green
    && run.tree === red.tree && run.command === red.command && receiptBinds(store, run));
  if (paired && red.failures.length > 0) return;
  const details = red.failures.map(failure => {
    const attribution = state.failures?.find(entry => entry.file === failure.file && entry.name === failure.name);
    return `${failure.file}: ${failure.name}; last changed by ${attribution?.items?.length ? '#' + attribution.items[0] : 'no recorded landed item'}`;
  });
  throw new Refused('PUBLISH_RED', `publish full suite is red at ${red.head}; landing pauses until a later full suite passes or the same tree proves flaky: ${details.join('; ') || '(unnamed failure)'}`);
}
