/**
 * The pool handlers for the board API's remaining routes: the board lookup, the event read, a person's request, an item's
 * detail and a move, each run in a pool worker so a handler blocked on SQLite or Git leaves the request thread answering
 * health [A2,C7]. Why a module of its own: main.js is over its size cap and takes no added lines, and these handlers
 * only compose the main module's own functions, given as ports.
 */

/**
 * @param {{ findBoard: Function, afterEvents: Function, createRequest: Function, executeMove: Function, itemDetail: Function }} functions The main module's own route functions.
 * @param {{ isMain?: boolean, boardOpeners: any, runCommand?: Function, refusalDocument?: Function }} ports
 * runCommand and refusalDocument are the CLI's, given by the worker's ports module; without them a move is refused by name.
 */
export function readPoolHandlers({ findBoard, afterEvents, createRequest, executeMove, itemDetail }, { isMain, boardOpeners, runCommand, refusalDocument }) {
  return {
    board: ({ id, projects }) => findBoard(id, () => projects, isMain, boardOpeners),
    events: ({ root, after, limit }) => afterEvents(root, after, isMain, boardOpeners, limit),
    item: ({ root, id, itemId }) => itemDetail({ root, id }, itemId),
    request: ({ root, body, personChannel }) => createRequest(root, body, isMain, personChannel, boardOpeners),
    move: ({ root, body, personChannel }) => {
      if (typeof runCommand !== 'function') throw Object.assign(new Error('this pool worker was started without the CLI entry point, so it cannot run a move; start the API through pullboard serve'), { name: 'Refused', code: 'API_NO_MOVES' });
      return executeMove(root, body, runCommand, isMain, personChannel, refusalDocument, boardOpeners);
    },
  };
}
