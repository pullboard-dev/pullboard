import { Refused } from '../../../kernel/light.js';

/** Terminal sink that discards output; a caller that wants the text passes its own say and err. */
const silent = () => {};

/**
 * Compose the io a link operation such as relayOn runs against: the board opener and native board ports
 * the caller supplies, a person channel, and silent terminal sinks unless given.
 *
 * Why: link sits below the cell that owns the native ports, so it is handed them rather than importing them;
 * this one place says which of them an operation cannot run without, for the view sign-in and for a caller with no CLI.
 *
 * @param {{ openBoard: Function, nativeBoardPorts: Function, personChannel?: string, say?: Function, err?: Function, stderr?: { write: Function } }} ports - Everything else passed is kept as given.
 * @returns {object} A fresh io for one link operation; relayOn may set flags on it, so it is not frozen.
 */
export function relayIo({ openBoard, nativeBoardPorts, personChannel = 'terminal', say = silent, err = silent, stderr = { write: silent }, ...rest } = {}) {
  for (const [name, port] of Object.entries({ openBoard, nativeBoardPorts })) {
    if (typeof port !== 'function') throw new Refused('RELAY_IO_PORT', `relay io needs ${name} as a function; pass the board opener and native ports of the cell that owns them`);
  }
  return { ...rest, openBoard, nativeBoardPorts, personChannel, say, err, stderr };
}
