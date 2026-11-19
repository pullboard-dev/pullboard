/** Native process-size and swap readings for the scratch-memory warning; nothing is signalled [C7]. */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';

/** The one file-system adapter this file reads through [C7]. */
const fs = fileSystemAdapter();

/** Read bounded native utility output. */
function native(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
}

/** `ps` rows of "pid rss-in-KB command" as processes with their size in bytes. */
export function parseProcesses(text) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    return match ? [{ pid: Number(match[1]), bytes: Number(match[2]) * 1024, name: basename(match[3]) }] : [];
  });
}

/** `sysctl vm.swapusage` ("total = 39936.00M  used = 37000.00M") as bytes; a Linux /proc/meminfo body as bytes. */
export function parseSwap(text) {
  const mac = /total = ([\d.]+)M\s+used = ([\d.]+)M/u.exec(text);
  if (mac) return { totalBytes: Number(mac[1]) * 1024 ** 2, usedBytes: Number(mac[2]) * 1024 ** 2 };
  const total = /^SwapTotal:\s+(\d+) kB/mu.exec(text), free = /^SwapFree:\s+(\d+) kB/mu.exec(text);
  return total && free ? { totalBytes: Number(total[1]) * 1024, usedBytes: (Number(total[1]) - Number(free[1])) * 1024 } : null;
}

/** The machine's process sizes and swap use, or null where they cannot be read. */
export function readScratchMemory({ run = native, readFile = path => fs.readFile(path) } = {}) {
  try {
    const processes = parseProcesses(run('/bin/ps', ['-axo', 'pid=,rss=,comm=']));
    let swap;
    try { swap = parseSwap(run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])); } catch { swap = parseSwap(readFile('/proc/meminfo')); }
    return { processes, swap };
  } catch { return null; /* An unreadable machine state raises no finding. */ }
}
