/** Content-addressed receipts bind board-tool recipes to exact Git input and output trees [C7,V4]. */
import { gitSpawnSync } from './adapter.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment } from './main.js';
import { invalidateGitFacts } from './main.js';

const OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** Run scoped Git plumbing without consulting another checkout's inherited repository selectors. */
function run(root, args, { input, env = {} } = {}) {
  const result = gitSpawnSync(['--no-replace-objects', ...args], { cwd: root,
    env: { ...cleanGitEnvironment(), ...env }, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr ?? result.error ?? ''}`);
  return result.stdout.trim();
}

/** Admit data for the two fixed board tools, never a caller-provided shell command or executable. */
export function canonicalToolCommand(value) {
  if (!value || typeof value !== 'object') return null;
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
  const path = value => text(value) && !/[\\:]/u.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
  if (value.tool === 'remove-shims' && /^[a-z][\w:-]*$/u.test(value.cell ?? '') && /^[a-z][\w:-]*$/u.test(value.lane ?? '')) {
    return { tool: value.tool, cell: value.cell, lane: value.lane };
  }
  if (value.tool === 'cells-move' && [value.from, value.to, value.frontDoor].every(path) && text(value.purpose)
    && (value.keepExports === null || Array.isArray(value.keepExports) && value.keepExports.length <= 128
      && value.keepExports.every(name => /^[A-Za-z_$][\w$]*$/u.test(name)))) {
    return { tool: value.tool, from: value.from, to: value.to, frontDoor: value.frontDoor, purpose: value.purpose, keepExports: value.keepExports };
  }
  return null;
}

/** Receipt refs are ordinary Git objects, independent of commit prose and the live index. */
function reference(base, tree) { return `refs/pullboard/tool-commands/${base}/${tree}`; }

/** Read only a complete bounded recipe whose identity is its requested input commit and output tree. */
function receipt(root, base, tree) {
  if (!OBJECT.test(base) || !OBJECT.test(tree)) return null;
  try {
    const value = JSON.parse(run(root, ['show', reference(base, tree)]));
    if (value.version !== 1 || value.base !== base || value.tree !== tree || !Array.isArray(value.commands)
      || !value.commands.length || value.commands.length > 128) return null;
    const commands = value.commands.map(canonicalToolCommand);
    return commands.every(Boolean) ? { ...value, commands } : null;
  } catch { return null; }
}

/** Capture exactly what a subsequent ordinary commit would stage, without changing the caller's index. */
function workingTree(root) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-tool-index-'));
  const env = { GIT_INDEX_FILE: join(directory, 'index') };
  try {
    run(root, ['read-tree', 'HEAD'], { env });
    run(root, ['add', '-A', '--', '.'], { env });
    return run(root, ['write-tree'], { env });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Record successful tool execution only when every prior uncommitted edit is already tool-recorded. */
export function recordToolCommand(root, command, apply) {
  const canonical = canonicalToolCommand(command);
  if (!canonical) throw new TypeError('unsupported board tool command');
  root = run(root, ['rev-parse', '--show-toplevel']);
  const base = run(root, ['rev-parse', 'HEAD']);
  const original = run(root, ['rev-parse', 'HEAD^{tree}']);
  const before = workingTree(root);
  const previous = before === original ? { commands: [] } : receipt(root, base, before);
  const result = apply();
  invalidateGitFacts();
  if (!previous || run(root, ['rev-parse', 'HEAD']) !== base) return result;
  const tree = workingTree(root);
  const commands = [...previous.commands, canonical];
  if (commands.length > 128) return result;
  const object = run(root, ['hash-object', '-w', '--stdin'], { input: JSON.stringify({ version: 1, base, tree, commands }) + '\n' });
  run(root, ['update-ref', reference(base, tree), object]);
  return result;
}

/** Every source-only commit must exactly match a recorded tool result; mixed handwritten changes opt out. */
export function recordedToolCommits(root, main, head) {
  try {
    const commits = run(root, ['rev-list', '--reverse', `${main}..${head}`]).split('\n').filter(Boolean);
    if (!commits.length || commits.length > 128) return null;
    const recipes = [];
    for (const commit of commits) {
      const parents = run(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ');
      if (parents.length === 3) {
        run(root, ['merge-base', '--is-ancestor', parents[2], main]);
        const merged = run(root, ['merge-tree', '--write-tree', parents[1], parents[2]]).split('\n')[0];
        if (merged !== run(root, ['rev-parse', `${commit}^{tree}`])) return null;
        continue; // A clean trunk-only integration adds no handwritten intent.
      }
      if (parents.length !== 2) return null;
      const tree = run(root, ['rev-parse', `${commit}^{tree}`]);
      const recorded = receipt(root, parents[1], tree);
      if (!recorded) return null;
      recipes.push({ commit, ...recorded, subject: run(root, ['show', '-s', '--format=%s', commit]),
        author: run(root, ['show', '-s', '--format=%an%x00%ae', commit]).split('\0') });
    }
    return recipes.length ? recipes : null;
  } catch { return null; }
}


/** A regenerated head retains its full-proof requirement across retries and source handoffs. */
export function toolRegenerationSource(root, head) {
  if (!OBJECT.test(head ?? '')) return null;
  try {
    const source = run(root, ['rev-parse', `refs/pullboard/tool-regenerated/${head}^{commit}`]);
    return OBJECT.test(source) ? source : null;
  } catch { return null; }
}
