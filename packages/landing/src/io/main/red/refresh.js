#!/usr/bin/env node
/**
 * Refresh the previous main's named red files at the published main, detached from the landing that published it.
 * Why: run inside the landing worker, this refresh kept the worker alive (a heavy file took 9 minutes on 6 Nov) and
 * the scheduler held the next batch until it ended. A detached child lets the lander exit the moment it has landed [C7].
 */
import {
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
} from 'node:path';
import {
  holdRefreshFlight,
  refreshMainRedComparisons,
} from '../../../../index.js';

const [root, previousMain, publishedMain] = process.argv.slice(2);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
if (!isAbsolute(root ?? '') || !SHA.test(previousMain ?? '') || !SHA.test(publishedMain ?? '')) {
  throw new Error('main-red-refresh requires an absolute root, the previous main and the published main');
}
const directory = join(root, '.git', 'pullboard', 'automatic-landing');
mkdirSync(directory, { recursive: true });
/** One line per outcome in the lander's directory, since the landing that started this has already exited. */
const log = line => appendFileSync(join(directory, 'main-red-refresh.log'), `${new Date().toISOString()} ${line}\n`);
// One refresh per machine: a second start exits at once, and the next landing starts a fresh one [C7].
const letGo = holdRefreshFlight();
if (!letGo) {
  log(`refresh ${previousMain.slice(0, 12)} -> ${publishedMain.slice(0, 12)} skipped: another refresh is running`);
  process.exit(0);
}
log(`refresh ${previousMain.slice(0, 12)} -> ${publishedMain.slice(0, 12)} started`);
try {
  const results = await refreshMainRedComparisons(root, previousMain, publishedMain, () => {});
  const unavailable = results.filter(result => result.unavailable);
  log(`refresh at ${publishedMain.slice(0, 12)}: ${results.length} file(s), ${unavailable.length} unavailable${unavailable.length ? `: ${unavailable.map(r => r.unavailable).join('; ').slice(0, 300)}` : ''}`);
} catch (error) {
  log(`refresh at ${publishedMain.slice(0, 12)} failed: ${String(error?.message ?? error).slice(0, 300)}`);
}
finally { letGo(); }
