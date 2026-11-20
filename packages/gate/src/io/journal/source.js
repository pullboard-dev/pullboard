/** Pure source for the runner child journal preload [C7]. */
import { join } from 'node:path';


const PERL_START = `my $mib = pack('l4', 1, 14, 1, $ARGV[0]); my $buf = "\\0" x 1024; my $len = pack('Q', length $buf);
exit 1 if syscall(202, $mib, 4, $buf, $len, 0, 0) != 0 || unpack('Q', $len) < 16;
my ($sec, $usec) = unpack('q l', substr($buf, 0, 16)); printf("%d.%06d\\n", $sec, $usec);`;

/** The exact start stamp of a process (proc: from /proc, mac: from perl), or an empty string when the pid is unreadable; the generated journal preload carries this function's source [C7]. */
export function exactStartWith(pid, readFileSync, spawnSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) return '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const field = stat.slice(close + 2).trim().split(/\s+/u)[19];
    return close > 0 && /^\d+$/u.test(field ?? '') ? `proc:${field}` : '';
  } catch (error) {
    if (process.platform !== 'darwin' || error.code !== 'ENOENT') return '';
  }
  const result = spawnSync('/usr/bin/perl', ['-e', PERL_START, String(pid)], { encoding: 'utf8', timeout: 2_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return !result.error && result.status === 0 && /^\d+\.\d{6}$/u.test(text) ? `mac:${text}` : '';
}

/**
 * Source of the preload an SSH runner puts in NODE_OPTIONS for a job: it records only child identity and a one-way
 * command digest. It depends on nothing but its directory, so a classifier can rebuild it and compare byte for byte.
 * Each spawn receipt also carries the child's exactStart, read in the spawn tick or at this process's exit: the
 * child is not yet reaped then, so its pid is still its own (#1063).
 *
 * @param {string} directory the job directory that holds child-spawn-preload.mjs and child-journal/
 * @returns {string}
 */
export function childJournalPreloadSource(directory) {
  const journalDirectory = join(directory, 'child-journal');
  const overflowPath = join(journalDirectory, 'overflow');
  return `
import diagnostics from 'node:diagnostics_channel';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const PERL_START = ${JSON.stringify(PERL_START)};
${exactStartWith.toString().replace('exactStartWith(pid, readFileSync, spawnSync)', 'exactStart(pid)')}
const directory = ${JSON.stringify(journalDirectory)};
const overflowPath = ${JSON.stringify(overflowPath)};
const instance = randomUUID();
process.env.PULLBOARD_RUNNER_INSTANCE = instance;
const limit = 131072;
// A journal file is the reader's unit: at most 128 KiB, owned by exactly one thread (created exclusively), so a full
// file rotates to the next sequence instead of ending custody. Worker threads share this pid and run this preload
// too, so a thread writes nothing, and creates no file, until it records its first spawn.
const MAX_FILES = 48;
let fd = -1;
let bytes = 0;
let sequence = 0;
let overflow = false;
function failed(message) {
  overflow = true;
  try { writeFileSync(overflowPath, message + '\\n', { flag: 'wx', mode: 0o600 }); } catch {}
}
function openNext() {
  for (;;) {
    if (sequence >= MAX_FILES) return false;
    const name = 'children-' + process.pid + (sequence ? '-' + sequence : '') + '.jsonl';
    sequence += 1;
    try { fd = openSync(join(directory, name), 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    bytes = 0;
    return true;
  }
}
function append(line) {
  const size = Buffer.byteLength(line);
  if (fd < 0 || bytes + size > limit) {
    if (fd >= 0) { try { closeSync(fd); } catch {} fd = -1; }
    if (!openNext()) return failed('journal limit reached');
    const boot = JSON.stringify({ type: 'boot', pid: process.pid, ppid: process.ppid, instance }) + '\\n';
    writeSync(fd, boot);
    bytes += Buffer.byteLength(boot);
  }
  writeSync(fd, line);
  bytes += size;
}
function record(value) {
  if (overflow) return;
  try { append(JSON.stringify(value) + '\\n'); }
  catch { failed('journal write failed'); }
}
const channel = diagnostics.channel('child_process');
const seen = new WeakSet();
// The spawn event comes a tick later; a parent that exits in the same tick still owes those children a receipt.
const unrecorded = new Map();
channel.subscribe(message => {
  try {
    const child = message?.process;
    if (!child || typeof child.once !== 'function' || seen.has(child)) return;
    seen.add(child);
    const writeReceipt = () => {
      if (!unrecorded.delete(child) || !Number.isSafeInteger(child.pid) || child.pid < 1) return;
      const commandSha256 = createHash('sha256').update(JSON.stringify({ command: child.spawnfile ?? '', args: child.spawnargs ?? [] })).digest('hex');
      const start = exactStart(child.pid);
      record({ type: 'spawn', pid: child.pid, ppid: process.pid, instance, commandSha256, ...(start ? { start } : {}) });
    };
    unrecorded.set(child, writeReceipt);
    child.once('error', () => unrecorded.delete(child));
    if (Number.isSafeInteger(child.pid)) writeReceipt();
    else child.once('spawn', writeReceipt);
  } catch {
    try { writeFileSync(overflowPath, 'child receipt could not be recorded\\n', { flag: 'wx', mode: 0o600 }); } catch {}
  }
});
process.once('exit', () => {
  // Still unreaped while this process exits, so each pid is still its child's own.
  for (const writeReceipt of [...unrecorded.values()]) writeReceipt();
  try { if (fd >= 0) closeSync(fd); } catch {}
});
`;
}
