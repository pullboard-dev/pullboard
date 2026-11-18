/** The processes using this machine's CPU, grouped by command kind, so a busy load names who is using it [Q1,C7,#2466]. */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Interpreters whose command kind is the script they run, not the interpreter. */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'zsh', 'sh']);

/** The one ps sample this module takes; a test swaps it so no assertion depends on the real machine. */
const HOST_SAMPLE = Object.freeze({
  ps: async () => (await execFileAsync('/bin/ps', ['-axo', 'pcpu=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout,
});
let sample = HOST_SAMPLE;

/**
 * Replace the ps sample, returning a function that restores the previous one.
 * Why: a fixture injects its own process list so the result never depends on what the test machine runs.
 *
 * @param {{ ps: () => string | Promise<string> }} next
 * @returns {() => void}
 */
export function setProcessSamplePort(next) {
  const previous = sample;
  sample = Object.freeze({ ...sample, ...next });
  return () => { sample = previous; };
}

/**
 * The command kind of one process line: its executable's name, or the script it runs when that is an interpreter.
 *
 * @param {string} args the process's full command line
 * @returns {string}
 */
export function commandKind(args) {
  const words = args.trim().split(/\s+/u);
  const first = basename(words[0] ?? '');
  if (!INTERPRETERS.has(first)) return first || 'unknown';
  const script = words.slice(1).find(word => !word.startsWith('-'));
  return script ? `${first} ${basename(script)}` : first;
}

/**
 * Group a `ps -axo pcpu=,args=` listing by command kind, busiest first.
 *
 * @param {string} text
 * @param {{ limit?: number }} [options]
 * @returns {{ kind: string, cpu: number, processes: number }[]}
 */
export function topConsumers(text, { limit = 5 } = {}) {
  const kinds = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+(?:\.\d+)?)\s+(\S.*)$/u.exec(line);
    if (!match) continue;
    const kind = commandKind(match[2]);
    const entry = kinds.get(kind) ?? { kind, cpu: 0, processes: 0 };
    entry.cpu = Math.round((entry.cpu + Number(match[1])) * 10) / 10;
    entry.processes += 1;
    kinds.set(kind, entry);
  }
  return [...kinds.values()].sort((a, b) => b.cpu - a.cpu || a.kind.localeCompare(b.kind)).slice(0, limit);
}

/**
 * Sample this machine's processes now and name the top consumers; an unreadable ps names none.
 *
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ kind: string, cpu: number, processes: number }[]>}
 */
export async function localConsumers(options) {
  try { return topConsumers(await sample.ps(), options); } catch { return []; }
}
