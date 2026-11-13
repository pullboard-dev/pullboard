/** Post-landing observations share the exact adopted tip [N2,B3]. */
import { spawnReachable } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { warnMainMoved } from '../../../../merge/index.js';

/**
 * The node arguments that refresh the code map for the checkout, run by the detached process.
 *
 * @param {string} root - The primary checkout.
 * @returns {string[]}
 */
export function codeMapRefreshArgs(root) {
  const index = new URL('../../../../codemap/index.js', import.meta.url).href;
  return ['--input-type=module', '-e', `const { refreshLandedCodeMap } = await import(${JSON.stringify(index)}); refreshLandedCodeMap(${JSON.stringify(root)});`];
}

/**
 * Start the code map refresh as a detached process and return at once.
 *
 * Why: the refresh takes about 11 s and the next batch must not wait for it; the process still finishes on its own [C7].
 *
 * @param {string} root - The primary checkout.
 * @returns {Promise<{ pid: number | null }>}
 */
export function startCodeMapRefresh(root) {
  return spawnReachable(process.execPath, codeMapRefreshArgs(root), { cwd: root, launchd: false });
}

/**
 * Refresh the derived source map after the landing receipt and main fast-forward have completed.
 * A main-moved notice that fails is returned as an entry for the shell to keep and retry on the next wake [C7].
 *
 * @param {object} state - The landing state.
 * @returns {Promise<{ deferred: { kind: string, main: string }[] }>} Notices still to deliver.
 */
export async function refreshLandedCodeMap(state) {
  const deferred = [];
  try {
    await warnMainMoved({ root: state.root, board: state.board, trunk: state.batch.tip, write: state.write, say: state.say }, { listAgents: store.listAgents, listItems: store.listItems });
  } catch (error) {
    state.say('main-move warnings deferred: ' + error.message);
    deferred.push({ kind: 'main-moved', main: state.batch.tip });
  }
  try {
    await (state.startCodeMapRefresh ?? startCodeMapRefresh)(state.root);
    state.say('code map refresh started in the background');
  } catch (error) {
    state.say('code map refresh deferred: ' + error.message);
  }
  return { deferred };
}
