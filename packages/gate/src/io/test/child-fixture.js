/** A package test may not import the CLI app's child fixture, which only re-exports the gate's; only named exceptions do [C7]. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compositionBase } from './fixtures.js';
import { readText } from '../scan.js';
import { walk } from '../scan.js';

const EXCEPTIONS_URL = new URL('../../../data/baselines/cli-child-importers.json', import.meta.url);
const PACKAGE_TEST = /^packages\/(.+\.test\.m?js)$/u;
const MESSAGE = 'package tests import packages/gate/tests/fixtures/child.js directly';
export const CLI_CHILD_IMPORT = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*['"][^'"]*apps\/cli\/tests\/fixtures\/child\.js['"]/u;

/** The named exceptions: package-relative test paths that may import the CLI child fixture. */
export function cliChildExceptions() {
  return JSON.parse(readFileSync(EXCEPTIONS_URL, 'utf8'));
}

/** A file's text at a commit, or null when that commit lacks it. */
function textAt(root, commit, path) {
  const run = spawnSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

/**
 * Package tests that import the CLI child fixture outside the exception list and did not already do so where the branch
 * met main, as `path:line: text` rows. Why: the doctrine test runs only when affected, so three new importers landed first [#8435].
 *
 * @param {string} root
 * @param {{ only?: string[] | null, base?: string | null, exceptions?: string[] }} [options]
 */
export function cliChildImportProblems(root, { only = null, base = compositionBase(root), exceptions = cliChildExceptions() } = {}) {
  const paths = only ? only.filter(path => PACKAGE_TEST.test(path)).sort() : walk(root, /^packages\/.+\.test\.m?js$/u);
  const rows = [];
  for (const path of paths) {
    const inner = PACKAGE_TEST.exec(path)?.[1];
    if (!inner || exceptions.includes(inner)) continue;
    let text;
    try { text = readText(root, path); } catch { continue; }
    const found = CLI_CHILD_IMPORT.exec(text);
    if (!found) continue;
    if (base && CLI_CHILD_IMPORT.test(textAt(root, base, path) ?? '')) continue;
    rows.push({ path, line: text.slice(0, found.index).split('\n').length, text: MESSAGE });
  }
  return rows;
}
