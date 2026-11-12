/** The network hosts each role needs, so a sandbox allowlist is one line per role [P7]. */

/** The default port a remote's scheme uses when its address names none. */
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'ssh:': 22, 'git:': 9418, 'git+ssh:': 22 };

/**
 * The `host:port` a board URL or git remote reaches, or null for a local path (no network).
 * Why: scp-style `user@host:path` remotes carry no scheme, so they are read as ssh on port 22.
 * @param {string | null | undefined} address - A board URL or a git remote.
 * @returns {string | null}
 */
export function hostOf(address) {
  if (!address) return null;
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(?!\d+\/)[^\s]+$/u.exec(address);
  if (scp && !/^[A-Za-z]:[\\/]/u.test(address)) return `${scp[1]}:22`;
  let url;
  try { url = new URL(address); } catch { return null; }
  const port = DEFAULT_PORTS[url.protocol];
  if (!url.hostname || port === undefined) return null;
  return `${url.hostname}:${url.port || port}`;
}

/**
 * The exact hosts the agent, runner and lander roles each need: the board URL and the git remote of record, nothing else.
 * Why: every role is a client of one board API and only pulls, so one pair of hosts covers all three.
 * @param {{ boardUrl?: string | null, trunk?: string | null }} sources - board.url and trunk.remote.
 * @returns {{ agent: string[], runner: string[], lander: string[] }}
 */
export function roleHosts({ boardUrl, trunk }) {
  const hosts = [...new Set([hostOf(boardUrl), hostOf(trunk)].filter(Boolean))];
  return { agent: [...hosts], runner: [...hosts], lander: [...hosts] };
}
