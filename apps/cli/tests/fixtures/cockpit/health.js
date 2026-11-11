/**
 * Chrome's own health beside a failing journey (#902): whether its network service restarted, which empties the
 * cookie jar, and what Chrome said about it. Only process ids and Chrome's own log lines are kept.
 */
import { execFileSync } from 'node:child_process';

/** The pids of this profile's Chrome network service, from the process table; null when the table cannot be read. */
export function networkServicePids(profile) {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter((line) => line.includes(profile) && line.includes('NetworkService'))
      .map((line) => Number(line.trim().split(/\s+/u)[0]));
  } catch { return null; }
}

/**
 * A failure report for one Chrome: its network-service pids when the watched visit began and now (a changed pid is a
 * restart), and its recent stderr lines about the network service, crashes or restarts.
 *
 * @param {{stderr?: () => string}} chrome - The Chrome the journey drove.
 * @param {string} profile - That Chrome's profile directory, which its child processes name.
 * @param {number[]|null} atStart - networkServicePids(profile) when the watched visit began.
 */
export function chromeHealth(chrome, profile, atStart) {
  const said = String(chrome?.stderr?.() ?? '').split('\n')
    // Chrome's updater logs its crash handler on every launch; only the network service and real crashes are kept.
    .filter((line) => !/updater|crash_reporter|crash-handler/iu.test(line) && /network ?service|crashed|restarting/iu.test(line))
    .slice(-12).map((line) => line.slice(0, 300));
  return { networkService: { atStart, now: networkServicePids(profile) }, stderr: said };
}
