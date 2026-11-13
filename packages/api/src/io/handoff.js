/** The listening socket the board API hands to its replacement, so a restart onto new code never closes the port [C7]. */

/**
 * The arguments `server.listen` takes: the inherited socket when a restart passed one, else the address and port.
 *
 * @param {{ port: number, address: string, fd?: number | null }} where
 * @returns {object}
 */
export function listenOn({ port, address, fd = null }) {
  return Number.isInteger(fd) ? { fd } : { port, host: address };
}

/**
 * The file descriptor of a listening server, for a child to inherit; null where the platform has none (Windows).
 * Why: a child that listens on the same descriptor keeps the kernel's accept queue whole, so no request is refused
 * while the old process drains.
 *
 * @param {import('node:net').Server} server
 * @returns {number | null}
 */
export function handoffFd(server) {
  const fd = /** @type {any} */ (server)._handle?.fd;
  return Number.isInteger(fd) && fd > 2 ? fd : null;
}
