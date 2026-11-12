/** Native CPU observations for registered agent worktrees; no process is signalled [A6,H16]. */
import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { relative } from 'node:path';
import { sep } from 'node:path';
import { hostname } from 'node:os';

/** Read bounded native utility output without arguments or environment supplied by a process. */
function native(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
}
/** ps CPU time is [days-][hours:]minutes:seconds, not elapsed wall time or percent CPU. */
function minutes(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(text);
  return match ? Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3]) + Number(match[4]) / 60 : NaN;
}
/** Parse birth identity separately from executable name, retaining only processes over the fixed CPU threshold. */
function rows(text) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/u.exec(line);
    if (!match) return [];
    const cpu = minutes(match[2]), started = Date.parse(match[3]);
    return cpu > 20 && Number.isFinite(started) ? [{ pid: Number(match[1]), cpu, since: new Date(started).toISOString(), name: basename(match[4].trim()) }] : [];
  });
}
/** Canonical paths avoid symlink spelling differences; unreadable or vanished cwd never establishes ownership. */
function canonical(path) {
  try { return realpathSync(path); } catch { return null; /* A disappearing process/worktree has no attributable cwd. */ }
}
/** Report only native cwd ownership revalidated against the same PID birth after the cwd observation. */
export function agentCpuFindings(db, { platform = process.platform, run = native, readLink = readlinkSync, host = hostname() } = {}) {
  if (!['darwin', 'linux'].includes(platform)) return null;
  const prefix = `AGENT_CPU:${encodeURIComponent(host)}:`;
  const last = db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id DESC LIMIT 1").get();
  const previous = last ? JSON.parse(last.event_detail).active : [];
  const foreign = previous.filter(finding => finding.cause === 'AGENT_CPU' && !finding.key.startsWith(prefix))
    .map(finding => ({ ...finding, owner: { who: finding.owner } }));
  const agents = db.prepare('SELECT agent_id, agent_path FROM agent WHERE agent_id != ?').all('coordinator')
    .map(agent => ({ ...agent, path: canonical(agent.agent_path) })).filter(agent => agent.path)
    .sort((left, right) => right.path.length - left.path.length);
  if (!agents.length) return foreign;
  const format = ['pid=', 'time=', 'lstart=', 'comm='].flatMap(field => ['-o', field]);
  let candidates, confirmed, directories = new Map();
  try {
    candidates = rows(run('/bin/ps', ['-e', ...format]));
    if (!candidates.length) return foreign;
    if (platform === 'darwin') {
      const output = run('/usr/sbin/lsof', ['-b', '-a', '-d', 'cwd', '-p', candidates.map(row => row.pid).join(','), '-Fpn']);
      let pid;
      for (const line of output.split('\n')) {
        if (/^p\d+$/u.test(line)) pid = Number(line.slice(1));
        else if (pid && line.startsWith('n')) directories.set(pid, canonical(line.slice(1)));
      }
    } else {
      for (const row of candidates) {
        try { directories.set(row.pid, canonical(readLink(`/proc/${row.pid}/cwd`))); }
        catch { /* A process may exit or deny cwd access between the ps and readlink observations. */ }
      }
    }
    confirmed = new Set(rows(run('/bin/ps', ['-p', candidates.map(row => row.pid).join(','), ...format])).map(row => `${row.pid}:${row.since}`));
  } catch { return null; /* Unavailable observations cannot establish that a previously seen process resolved. */ }
  return [...foreign, ...candidates.flatMap(row => {
    const cwd = directories.get(row.pid);
    if (!cwd || !confirmed.has(`${row.pid}:${row.since}`)) return [];
    const agent = agents.find(agent => { const child = relative(agent.path, cwd); return !child || child !== '..' && !child.startsWith('..' + sep) && !child.startsWith(sep); });
    if (!agent) return [];
    const key = `${prefix}${row.pid}:${row.since}`;
    // Durable prior alerts survive temporary observation gaps and observer restarts; PID birth prevents reuse collisions.
    const recorded = previous.find(finding => finding.key === key);
    const active = Boolean(recorded);
    if (!active && db.prepare("SELECT 1 FROM event WHERE event_kind='health-failure' AND json_extract(event_detail,'$.key')=? LIMIT 1").get(key)) return [];
    if (recorded) return [{ ...recorded, owner: { who: recorded.owner } }];
    return [{ key, cause: 'AGENT_CPU', item: null, subject: `pid ${row.pid}`, title: row.name, since: row.since,
      why: `${row.cpu.toFixed(2)} CPU minutes used on ${host} in agent worktree ${agent.path}`, next: 'inspect the owning agent process before deciding whether to stop it', owner: { who: agent.agent_id } }];
  })];
}
