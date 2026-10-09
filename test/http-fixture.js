/** Fixture HTTP requests never reuse an idle connection, so a stalled test cannot meet a closed socket [C7]. */

/**
 * Send one request to a live fixture server on a connection of its own, and name the cause if it fails.
 *
 * The view and API servers close a keep-alive socket after Node's default 5 s of idle. A test that
 * blocks its own event loop for longer, with spawnSync of a CLI for one, sends its next request on a
 * pooled socket the server has already closed, and fetch reports the reset only as "fetch failed".
 * Asking for connection: close leaves no idle socket behind, so no later request can land on one.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchFresh(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('connection', 'close');
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    // The path names the request; the query is left out because fixtures carry their key there.
    const message = `${init.method ?? 'GET'} ${new URL(url).pathname} failed: ${causeChain(error)}`;
    // A network failure keeps fetch's shape, a TypeError whose cause holds the socket error, so a caller
    // that reads error.cause.code still can. An abort or a timeout is rethrown as it is.
    if (error instanceof TypeError) throw new TypeError(message, { cause: error.cause ?? error });
    throw error;
  }
}

/**
 * Describe an error and every cause beneath it, so "fetch failed" says which socket error it hides.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function causeChain(error) {
  const links = [];
  for (let current = error; current !== undefined && current !== null && links.length < 8; current = current.cause) {
    const label = typeof current.code === 'string' ? current.code : current.name;
    links.push([label, current.message ?? String(current)].filter(Boolean).join(': '));
  }
  return links.join(' <- ');
}
