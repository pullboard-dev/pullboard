/** The runner hosts a daemon on this machine can reach only over the local network: every host but this machine itself. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether a registered runner's host is off this machine. */
function nonLoopback(runner) {
  const host = String(runner?.host ?? '').trim().replace(/^[^@]*@/u, '').replace(/:\d+$/u, '').toLowerCase();
  return host !== '' && !LOOPBACK.has(host);
}

/**
 * The doctor problems for long-lived Pullboard processes that macOS Local Network privacy blocks: a running daemon whose
 * environment carries __CFBundleIdentifier (an app started it, so that app's permission applies) and that is not a launchd
 * job, while a runner off this machine is registered. Why: on 11 Nov a daemon started from an app inherited the app's denied
 * Local Network permission and every connection to a runner failed "No route to host" [C7,#5760].
 *
 * @param {{ daemons: { name: string, pid: number, appBundle: string | null, launchd: boolean }[], runners: { host?: string }[] }} facts
 *   daemons: each running daemon, the bundle id its environment names (null when none) and whether launchd runs it.
 * @returns {{ code: string, message: string, next: string }[]}
 */
export function appDaemonProblems({ daemons, runners }) {
  if (!(runners ?? []).some(nonLoopback)) return [];
  return daemons.filter(daemon => daemon.appBundle && !daemon.launchd).map(daemon => ({ code: 'DAEMON_LOCAL_NETWORK',
    message: `${daemon.name} (pid ${daemon.pid}) was started by ${daemon.appBundle}, not as a launchd job, so that app's Local Network permission applies to its connections to the registered runners`,
    next: `kill ${daemon.pid}; the next pullboard command starts it again as a launchd job` }));
}
