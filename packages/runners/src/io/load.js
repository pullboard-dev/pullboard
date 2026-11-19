/** Actual executor samples shared by local gate and registered worker receipts [C7]. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { freemem } from 'node:os';
import { hostname } from 'node:os';
import { loadavg } from 'node:os';
import { platform } from 'node:os';

/**
 * Cumulative disk counters since boot, summed over every whole disk, or null when this host exposes none.
 * macOS has no iowait counter, so it reports only the time requests took; Linux also reads the CPU jiffies.
 */
export function readDiskCounters(os = platform(), run = spawnSync, read = file => readFileSync(file, 'utf8')) {
  try {
    if (os === 'darwin') return parseIoreg(String(run('ioreg', ['-rc', 'IOBlockStorageDriver', '-w0'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''));
    if (os === 'linux') return parseProc(read('/proc/diskstats'), read('/proc/stat'));
  } catch { /* A host that cannot report disk counters reports none. */ }
  return null;
}

/** Sum the IOBlockStorageDriver statistics: request time in ns over reads and writes, as busy ms. */
export function parseIoreg(text) {
  let busyMs = 0, seen = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"Statistics"')) continue;
    const field = name => Number(new RegExp(`"${name.replace(/[()]/gu, '\\$&')}"=(\\d+)`, 'u').exec(line)?.[1] ?? 0);
    busyMs += (field('Total Time (Read)') + field('Total Time (Write)')) / 1e6;
    seen = true;
  }
  return seen ? { busyMs, cpuTotal: null, cpuWait: null } : null;
}

/** Linux: io_ticks (ms a disk had work) summed over whole disks, plus the iowait and total jiffies of /proc/stat. */
export function parseProc(diskstats, stat) {
  let busyMs = 0, seen = false;
  for (const line of diskstats.split('\n')) {
    const f = line.trim().split(/\s+/u);
    if (f.length < 13 || !/^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/u.test(f[2])) continue;
    busyMs += Number(f[12]); seen = true;
  }
  const cpu = (/^cpu\s+(.*)$/mu.exec(stat)?.[1] ?? '').split(/\s+/u).map(Number);
  if (!seen || cpu.length < 5) return null;
  return { busyMs, cpuTotal: cpu.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0), cpuWait: cpu[4] };
}

let lastDisk = null;

/**
 * Disk busy % and I/O wait % since this process's previous disk sample, so a job's start and end samples bracket the job.
 * The first sample has no earlier one and reads null for both. Busy is request time over wall time, capped at 100;
 * I/O wait is the iowait share of CPU time, null where the host has no such counter (macOS).
 */
export function diskSample(read = readDiskCounters, now = Date.now) {
  const at = now(), counters = read(), before = lastDisk;
  lastDisk = counters ? { at, counters } : null;
  if (!counters || !before || at <= before.at) return { busyPct: null, ioWaitPct: null };
  const a = before.counters, b = counters;
  const busyPct = Math.min(100, Math.max(0, Math.round((b.busyMs - a.busyMs) / (at - before.at) * 1000) / 10));
  const jiffies = b.cpuTotal === null || a.cpuTotal === null ? 0 : b.cpuTotal - a.cpuTotal;
  return { busyPct, ioWaitPct: jiffies > 0 ? Math.round((b.cpuWait - a.cpuWait) / jiffies * 1000) / 10 : null };
}

/** macOS `sysctl -n vm.swapusage` text ('total = 5120.00M  used = 3600.44M ...') as swap MB, or null when it does not parse. */
export function parseSwapusage(text) {
  const field = name => new RegExp(`${name}\\s*=\\s*([\\d.]+)M`, 'u').exec(text)?.[1];
  const total = Number(field('total')), used = Number(field('used'));
  return field('total') === undefined || field('used') === undefined ? null : { swapUsedMB: Math.round(used), swapTotalMB: Math.round(total) };
}

/** Linux /proc/meminfo SwapTotal and SwapFree (kB) as swap MB, used = total - free, or null when either is missing. */
export function parseMeminfoSwap(text) {
  const kb = name => new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'mu').exec(text)?.[1];
  const total = kb('SwapTotal'), free = kb('SwapFree');
  return total === undefined || free === undefined ? null : { swapUsedMB: Math.round((Number(total) - Number(free)) / 1024), swapTotalMB: Math.round(Number(total) / 1024) };
}

/** Swap used and total in MB on this host, or null when it exposes none. */
export function readSwapUsage(os = platform(), run = spawnSync, read = file => readFileSync(file, 'utf8')) {
  try {
    if (os === 'darwin') return parseSwapusage(String(run('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''));
    if (os === 'linux') return parseMeminfoSwap(read('/proc/meminfo'));
  } catch { /* A host that cannot report swap reports none. */ }
  return null;
}

/**
 * Sample this executing machine now, never the controller on behalf of a remote run. With `diskIo` (the
 * gate.sampleDiskIo setting, read by the caller; off by default) the sample also carries `diskBusyPct` and `ioWaitPct`;
 * with `swap` (read by the caller, off by default) it carries `swapUsedMB` and `swapTotalMB` from `readSwap`;
 * without either the sample is exactly the four load fields and no child is launched.
 */
export function sampleRunnerLoad({ diskIo = false, read, now, swap = false, readSwap = readSwapUsage } = {}) {
  let sample = { at: new Date().toISOString(), average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
  if (diskIo === true) {
    const { busyPct, ioWaitPct } = diskSample(read, now);
    sample = { ...sample, diskBusyPct: busyPct, ioWaitPct };
  }
  if (swap === true) {
    const used = readSwap();
    sample = { ...sample, swapUsedMB: used?.swapUsedMB ?? null, swapTotalMB: used?.swapTotalMB ?? null };
  }
  return sample;
}

/** Describe actual local admission capacity; unreported capabilities stay unknown. */
export function localRunnerDescriptor(slots, browser, gui) {
  return { id: `local:${hostname()}`, kind: 'local', slots: { current: slots, limit: slots, elastic: false },
    capabilities: { os: platform(), browser, ...(gui === undefined ? {} : { gui }) } };
}
