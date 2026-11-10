/** The CLI's explicit ports into project registration, so the seats cell never loads the board or relay setup [C7,H5]. */
import * as boardStore from '../../../../../packages/store/index.js';
import { nativeBoardOpeners } from '../context.js';

/** Complete opted-in automatic relay linking, loading relay setup only when a project registers, as before. */
async function autoLinkProject(root, io) {
  const { autoLinkProject: link } = await import('../../../../../packages/link/index.js');
  return link(root, io, nativeBoardOpeners(io));
}

/** The board readers and relay linker registerProjectAndLink registers a project with. */
export function projectLinkPorts(io) {
  return { store: { ...boardStore, ...nativeBoardOpeners(io) }, autoLinkProject };
}
