/**
 * Which launchd form runner serve installs as, from the board's address [P7].
 * Why: macOS Local Network privacy blocks a per-user LaunchAgent (and a process left behind by ssh) from reaching a
 * local network address without a GUI prompt nobody sees, while a system LaunchDaemon run as the runner user may.
 */

/**
 * Whether a host names the local network that macOS Local Network privacy guards: a private, link-local or unique-local
 * address, a .local name, or a bare single-label name a LAN resolves. Loopback, Tailscale's 100.64.0.0/10 and public
 * names are outside it.
 *
 * @param {string} host - A URL hostname; IPv6 may keep its brackets.
 * @returns {boolean}
 */
export function localNetworkHost(host) {
  const name = String(host).toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
  }
  if (name.includes(':')) return /^fe[89ab]/u.test(name) || /^f[cd]/u.test(name);
  if (name === 'localhost' || name.endsWith('.localhost')) return false;
  return name.endsWith('.local') || !name.includes('.');
}

/**
 * The launchd form for a board URL: a system LaunchDaemon run as the runner user when the board is on the local
 * network, else the per-user LaunchAgent, which needs no sudo and reaches loopback, Tailscale and the internet.
 *
 * @param {string} board - The board's job URL.
 * @returns {'daemon' | 'agent'}
 */
export function serviceForm(board) {
  return localNetworkHost(new URL(board).hostname) ? 'daemon' : 'agent';
}
