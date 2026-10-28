/** Post-landing observations share the exact adopted tip [N2,B3]. */
import * as store from './board-query.js';
import { warnMainMoved } from './main-moved-warning.js';

/** Refresh the derived source map after the landing receipt and main fast-forward have completed. */
export async function refreshLandedCodeMap(state) {
  try {
    await warnMainMoved({ root: state.root, board: state.board, trunk: state.batch.tip, write: state.write, say: state.say }, { listAgents: store.listAgents, listItems: store.listItems });
  } catch (error) { state.say('main-move warnings deferred: ' + error.message); }
  try {
    const { refreshLandedCodeMap: refresh } = await import('./code-map.js');
    const map = refresh(state.root);
    if (map) state.say('code map refreshed for main ' + map.mainCommit.slice(0, 12));
  } catch (error) {
    state.say('code map refresh deferred: ' + error.message);
  }
}
