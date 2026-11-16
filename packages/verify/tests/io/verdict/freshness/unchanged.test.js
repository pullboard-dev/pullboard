/** An accept stays fresh when main's change to a shared file leaves the reviewed change intact, context included [E8,V8,#2896]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composesUnchanged } from '../../../../src/io/verdict/freshness.js';

/** A real Git repository whose shared registry lists twenty entries, one per line. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'pb-composes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test Agent');
  git('config', 'user.email', 'agent@example.com');
  const lines = Array.from({ length: 20 }, (_, index) => `  "entry-${String(index).padStart(2, '0')}": "cell",`);
  const write = (edit = list => list) => writeFileSync(join(root, 'registry.json'), `{\n${edit([...lines]).join('\n')}\n}\n`);
  write();
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  /** Commit one registry edit on a new branch from main and return its head. */
  const branch = (name, edit) => {
    git('switch', '-q', '-c', name, 'main');
    write(edit);
    git('commit', '-q', '-am', name);
    const head = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    return head;
  };
  return { root, git, branch, base: git('rev-parse', 'main') };
}

test('verify.freshness.far-registry-entry: main adding a far-away registry entry leaves the reviewed change fresh [E8,V8,#2896]', t => {
  const { root, git, branch, base } = repo(t);
  const checked = branch('item', list => { list.splice(2, 0, '  "item-added": "cell",'); return list; });
  git('merge', '-q', '--ff-only', branch('landed', list => { list.splice(17, 0, '  "main-added": "cell",'); return list; }));
  assert.equal(composesUnchanged(root, { base, checked, tip: git('rev-parse', 'main'), paths: ['registry.json'] }), true);
});

test('verify.freshness.conflicting-edit: a conflicting or hunk-changing main edit keeps the verdict stale [E8,V8,#2896]', t => {
  const { root, git, branch, base } = repo(t);
  const checked = branch('item', list => { list[5] = '  "entry-05": "item",'; return list; });
  git('merge', '-q', '--ff-only', branch('conflict', list => { list[5] = '  "entry-05": "main",'; return list; }));
  assert.equal(composesUnchanged(root, { base, checked, tip: git('rev-parse', 'main'), paths: ['registry.json'] }), false, 'conflict');

  const near = repo(t);
  const nearChecked = near.branch('item', list => { list[5] = '  "entry-05": "item",'; return list; });
  near.git('merge', '-q', '--ff-only', near.branch('context', list => { list[6] = '  "entry-06": "main",'; return list; }));
  assert.equal(composesUnchanged(near.root, { base: near.base, checked: nearChecked, tip: near.git('rev-parse', 'main'), paths: ['registry.json'] }), false, 'changed context');

  const spaced = repo(t);
  const spacedChecked = spaced.branch('item', list => { list[5] = '  "entry-05": "item",'; return list; });
  spaced.git('merge', '-q', '--ff-only', spaced.branch('whitespace', list => { list[6] = `${list[6]}   `; return list; }));
  assert.equal(composesUnchanged(spaced.root, { base: spaced.base, checked: spacedChecked, tip: spaced.git('rev-parse', 'main'), paths: ['registry.json'] }), false,
    'a whitespace-only main edit beside the change is not byte-identical');
});

test('verify.freshness.sequential-entries: two items adding registry entries in sequence both stay fresh [E8,V8,#2896]', t => {
  const { root, git, branch, base } = repo(t);
  const first = branch('first', list => { list.splice(3, 0, '  "first-added": "cell",'); return list; });
  const second = branch('second', list => { list.splice(16, 0, '  "second-added": "cell",'); return list; });
  git('merge', '-q', '--no-ff', '-m', 'land first', first);
  assert.equal(composesUnchanged(root, { base, checked: second, tip: git('rev-parse', 'main'), paths: ['registry.json'] }), true);
  git('merge', '-q', '--no-ff', '-m', 'land second', second);
  assert.match(git('show', 'main:registry.json'), /first-added[\s\S]*second-added/u);
});

test('verify.freshness.nearby-context: main editing a nearby line that only changes the hunk context leaves the reviewed change fresh [E8,V8]', t => {
  // Two lines away merges cleanly, yet it sat inside the reviewed hunk's three-line context; on 6 Nov such edits sent
  // accepted items back for an identical re-review. The patch id now carries no context lines.
  const { root, git, branch, base } = repo(t);
  const checked = branch('item', list => { list[5] = '  "entry-05": "item",'; return list; });
  git('merge', '-q', '--ff-only', branch('nearby', list => { list[8] = '  "entry-08": "main",'; return list; }));
  assert.equal(composesUnchanged(root, { base, checked, tip: git('rev-parse', 'main'), paths: ['registry.json'] }), true);
});
