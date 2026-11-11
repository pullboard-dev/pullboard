/** Machine memory reading and the admission verdict behind the resource front door [C7,CD60,CD64]. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readlink } from 'node:fs/promises';
import { basename } from 'node:path';

const MEMORY_CACHE_MS = 2_000;
const MEMORY_COMMAND_TIMEOUT_MS = 2_000;
const LINUX_CRITICAL_FULL_AVG10 = 10;
const LINUX_WARN_SOME_AVG10 = 10;
const memoryCache = new Map();

/** Run a small OS utility asynchronously; a slow or missing tool rejects instead of blocking a run. */
function readCommand(file, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(file, args, { encoding: 'utf8', timeout: MEMORY_COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => (error ? rejectOutput(error) : resolveOutput(stdout)));
  });
}

/** Read macOS pressure level, free percentage and size from one sysctl call. */
async function readDarwinMemory(run) {
  const [level, freePercent, total] = (await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level', 'hw.memsize'])).trim().split(/\s+/u).map(Number);
  if (![level, freePercent, total].every(Number.isFinite) || total <= 0) throw new Error('sysctl did not report memory pressure');
  // The kernel's levels are 1 normal, 2 warn and 4 critical; the free percentage is the one Activity Monitor uses.
  const pressure = level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal';
  return { pressure, availableBytes: Math.round(total * freePercent / 100), totalBytes: total };
}

/** Read Linux MemAvailable and, where the kernel has it, pressure stall information. */
async function readLinuxMemory(readText) {
  const meminfo = await readText('/proc/meminfo');
  const field = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'mu').exec(meminfo)?.[1]) * 1024;
  const availableBytes = field('MemAvailable');
  const totalBytes = field('MemTotal');
  if (!Number.isFinite(availableBytes) || !Number.isFinite(totalBytes)) throw new Error('/proc/meminfo has no MemAvailable');
  let pressure = 'unknown';
  try {
    const psi = await readText('/proc/pressure/memory');
    const avg10 = (kind) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, 'mu').exec(psi)?.[1]);
    const full = avg10('full');
    const some = avg10('some');
    if (Number.isFinite(full) || Number.isFinite(some)) {
      pressure = full >= LINUX_CRITICAL_FULL_AVG10 ? 'critical' : some >= LINUX_WARN_SOME_AVG10 ? 'warn' : 'normal';
    }
  } catch { /* Kernels without PSI still report MemAvailable, which the floor checks. */ }
  return { pressure, availableBytes, totalBytes };
}

/** Name the biggest processes by resident memory, with their working directories where the OS allows. */
async function readBiggestProcesses(platform, run, readLink, count = 3) {
  const listed = (await run('/bin/ps', ['-e', '-o', 'pid=', '-o', 'rss=', '-o', 'comm='])).split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    // Only the executable's own name is kept: arguments can carry secrets.
    return match ? { pid: Number(match[1]), bytes: Number(match[2]) * 1024, name: basename(match[3].trim()) } : null;
  }).filter(Boolean).sort((left, right) => right.bytes - left.bytes).slice(0, count);
  return Promise.all(listed.map(async (entry) => {
    let cwd = '', cwdFailure = '';
    try {
      if (platform === 'linux') cwd = await readLink(`/proc/${entry.pid}/cwd`);
      else cwd = /^n(.*)$/mu.exec(await run('/usr/sbin/lsof', ['-b', '-a', '-d', 'cwd', '-p', String(entry.pid), '-Fn']))?.[1] ?? '';
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'unavailable';
      cwdFailure = `an unreadable directory for pid ${entry.pid} (${platform === 'linux' ? 'readlink' : 'lsof'} ${code})`;
    }
    if (!cwd && !cwdFailure) cwdFailure = `an unreadable directory for pid ${entry.pid} (no directory reported)`;
    return { ...entry, cwd, ...(cwdFailure ? { cwdFailure } : {}) };
  }));
}

/**
 * Take one reading of the machine's memory: pressure, free bytes and, when asked, the biggest
 * processes. A platform or tool that cannot answer returns checked: false rather than throwing,
 * so the pool falls back to counting slots.
 *
 * @param {{ platform?: string, processes?: boolean, run?: (file: string, args: string[]) => Promise<string>, readText?: (file: string) => Promise<string>, readLink?: (file: string) => Promise<string> }} [options]
 * @returns {Promise<{ checked: true, pressure: string, availableBytes: number, totalBytes: number, processes?: object[] } | { checked: false, platform: string, reason: string }>}
 */
export async function readMachineMemory({ platform = process.platform, processes = false, run = readCommand, readText = (file) => readFile(file, 'utf8'), readLink = readlink } = {}) {
  try {
    let reading;
    if (platform === 'darwin') reading = await readDarwinMemory(run);
    else if (platform === 'linux') reading = await readLinuxMemory(readText);
    else return { checked: false, platform, reason: 'no memory reader for this platform' };
    if (!processes) return { checked: true, ...reading };
    let biggest = [];
    try { biggest = await readBiggestProcesses(platform, run, readLink); } catch { /* The hold still stands without names. */ }
    return { checked: true, ...reading, processes: biggest };
  } catch (error) {
    return { checked: false, platform, reason: String(error?.message ?? error).split('\n')[0] };
  }
}

/** Format a byte count the way a person reads memory: MB under a gigabyte, GB above. */
function memorySize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Decide whether a reading holds the queue and say so in one line. The same line serves a held
 * run and pullboard resources, so a person sees one description of the machine.
 *
 * @param {object} reading - A readMachineMemory result.
 * @param {number|null} floorBytes - Free memory under which the queue is held; null when the hold is off.
 * @returns {{ checked: boolean, held: boolean, line: string, warning?: string }}
 */
export function memoryVerdict(reading, floorBytes) {
  if (!reading?.checked) {
    const warning = `memory: not checked on ${reading?.platform ?? process.platform} (${reading?.reason ?? 'no reading'}); the gate pool admits by slots alone`;
    return { checked: false, held: false, line: warning, warning };
  }
  const off = floorBytes === null;
  const critical = !off && reading.pressure === 'critical';
  const low = !off && reading.availableBytes < floorBytes;
  const held = critical || low;
  const why = [critical ? 'pressure is critical' : '', low ? 'free memory is under the floor' : ''].filter(Boolean).join(' and ');
  const pressure = reading.pressure === 'unknown' ? 'pressure not reported' : `pressure ${reading.pressure}`;
  const state = `${pressure}, ${memorySize(reading.availableBytes)} free of ${memorySize(reading.totalBytes)}${off ? '' : ` (floor ${memorySize(floorBytes)})`}`;
  const biggest = (reading.processes ?? []).map(({ pid, name, bytes, cwd, cwdFailure }) => `pid ${pid} ${name} ${memorySize(bytes)} in ${cwd || cwdFailure || 'an unreadable directory'}`).join('; ');
  const verdict = off ? 'hold off (set gate.memoryFloorMB to turn it on)' : held ? `holding local gate runs because ${why}` : 'admitting';
  return { checked: true, held, line: `memory: ${verdict}: ${state}${biggest ? `; biggest: ${biggest}` : ''}` };
}

/**
 * Build the gate pool's memory check: a cached reading, then the biggest processes only while the
 * queue is held, so polling stays at one cheap call every couple of seconds.
 *
 * @param {{ floorBytes: () => number, read?: typeof readMachineMemory, cacheMs?: number }} options
 * @returns {() => Promise<{ checked: boolean, held: boolean, line: string, warning?: string }>}
 */
export function memoryAdmission({ floorBytes, read = readMachineMemory, cacheMs = MEMORY_CACHE_MS }) {
  return async () => {
    const cached = memoryCache.get(read);
    if (cached && Date.now() - cached.at < cacheMs) return cached.verdict;
    const floor = floorBytes();
    let verdict = memoryVerdict(await read({ processes: false }), floor);
    if (verdict.held) verdict = memoryVerdict(await read({ processes: true }), floor);
    memoryCache.set(read, { at: Date.now(), verdict });
    return verdict;
  };
}
