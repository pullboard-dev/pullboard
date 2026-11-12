/** Runtime child process identity for the runner journal [C7]. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exactStartWith } from './source.js';
export { childJournalPreloadSource } from './source.js';

/** Read a process's exact start using the real local process APIs. */
export function exactStart(pid) {
  return exactStartWith(pid, readFileSync, spawnSync);
}
