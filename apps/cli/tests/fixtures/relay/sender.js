/** Scope test cleanup to background relay senders created inside one fixture checkout [H21,H16]. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { SENDER_WORKER } from '../../../index.js';
import { waitForCondition } from '../runner/holders.js';

// Absolute, so cleanup never depends on the test process's swapped PATH.
const PS = '/bin/ps';
/** Resolve lsof from its system folders (macOS keeps it in /usr/sbin, some Linux in /usr/bin). */
const lsofPath = () => ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof'].find(existsSync) ?? 'lsof';

/** Read exact worker identities and scope this simulated machine to its private fixture checkout. */
export function senderProcesses(root) {
  const expected = realpathSync(root);
  const rows = execFileSync(PS, ['-Ao', 'pid=,lstart=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter(match => match && match[2].endsWith(SENDER_WORKER))
    .map(match => ({ pid: Number(match[1]), identity: match[2] }));
  const owned = rows.filter(record => {
    try {
      const cwd = process.platform === 'linux' ? readlinkSync(`/proc/${record.pid}/cwd`)
        : execFileSync(lsofPath(), ['-a', '-p', String(record.pid), '-d', 'cwd', '-Fn'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').find(line => line.startsWith('n'))?.slice(1);
      return cwd === expected;
    } catch (error) {
      if ((error.code === 'ENOENT' && process.platform === 'linux') || error.status === 1) return false;
      throw error;
    }
  });
  return { owned, others: rows.length - owned.length };
}

/** Stop only verified PID/start/command/cwd identities from this fixture; other test homes stay untouched. */
export async function stopSender(root) {
  for (const record of senderProcesses(root).owned) {
    const current = senderProcesses(root).owned.find(candidate => candidate.pid === record.pid);
    if (!current || current.identity !== record.identity) continue;
    try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    const started = record.identity.match(/^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})/u)?.[1].replace(/\s+/gu, ' ');
    if (!started) throw new Error('the verified sender has no stable start identity');
    await waitForCondition(() => {
      let row;
      try { row = execFileSync(PS, ['-p', String(record.pid), '-o', 'lstart=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch (error) { if (error.status === 1) return true; throw error; }
      const state = /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
      if (!state) throw new Error('post-signal sender start/state is unreadable');
      return state[1].replace(/\s+/gu, ' ') !== started || state[2].startsWith('Z');
    }, `fixture sender ${record.pid} to exit after its verified signal`, {
      signal: AbortSignal.timeout(5000), state: () => senderProcesses(root).owned.find(candidate => candidate.pid === record.pid) ?? null,
    });
  }
}
