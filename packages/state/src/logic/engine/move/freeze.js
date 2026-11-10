import { recordedRefusal } from '../../recorded/refusal.js';
import { Refused } from '../../../../../kernel/light.js';

/**
 * Turn a caller's freeze callback into the frozen criterion or its recorded refusal before sealing,
 * for claim, refreeze and a correcting edit [H3,H16]. An edit freezes the item as the edit leaves it.
 *
 * @param {any} board
 * @param {string} operation
 * @param {any[]} values
 * @param {{ store: any }} context
 */
export function prepareFreeze(board, operation, values, { store }) {
  const options = values[1];
  const item = store.getItem(board, values[0]);
  if (typeof options?.freeze === 'function') {
    let frozen;
    let error;
    try { frozen = options.freeze(operation === 'editItem' ? { ...item, ...store.validateItemEdit(board, values[0], options).next } : item); }
    catch (cause) {
      if (!(cause instanceof Refused)) throw cause;
      error = recordedRefusal(cause);
    }
    delete options.freeze;
    options.frozen = frozen ?? null;
    options.freezeError = error ?? null;
  }
}

/**
 * Restore only the frozen criterion callback; no receiver runs another machine's Git or shell.
 *
 * @param {any[]} args
 */
export function restoreFreeze(args) {
  const options = args[1];
  if (!options || !Object.hasOwn(options, 'frozen')) throw new Refused('RELAY_MOVE', 'the claim has no frozen criterion; send it with the current pullboard engine');
  options.freeze = () => {
    if (options.freezeError) throw new Refused(options.freezeError.code, options.freezeError.message);
    if (!options.frozen || typeof options.frozen.text !== 'string' || typeof options.frozen.digest !== 'string') throw new Refused('RELAY_MOVE', 'the frozen criterion is invalid; send it with the current pullboard engine');
    return options.frozen;
  };
}
