/** Post-landing observations share the exact adopted tip [N2,B3]. */
import * as store from '../../../../store/index.js';
import { warnMainMoved } from '../../../../merge/index.js';

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
    const { refreshLandedCodeMap: refresh } = await import('../../../../codemap/index.js');
    const map = refresh(state.root);
    if (map) state.say('code map refreshed for main ' + map.mainCommit.slice(0, 12));
  } catch (error) {
    state.say('code map refresh deferred: ' + error.message);
  }
  return { deferred };
}
