/** Load a move table as a release tag had it, into a private folder, so the last released rules can judge today's moves [C7,R4,U150]. */
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scratchFolder } from '../../../../config/index.js';
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/light.js';
import { loadDiscovered } from '../registry.js';

/** A static relative import, export-from or bare import in module source: the only edges a table's load follows. */
const IMPORT_EDGE = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?(['"])(\.{1,2}\/[^'"]+)\1/gu;

/** The tags this repository has, newest name last, as plain text for a refusal. */
function tagNames(root) {
  const read = tryGit(root, ['tag', '--list', '--sort=creatordate']);
  return read.status === 0 && read.stdout ? read.stdout.split('\n').filter(Boolean) : [];
}

/** The paths a tag holds under packages/, or null when the tag does not name a commit. */
function filesAt(root, tag) {
  const read = tryGit(root, ['ls-tree', '-r', '--name-only', `refs/tags/${tag}`, '--', 'packages']);
  return read.status === 0 ? new Set(read.stdout.split('\n').filter(Boolean)) : null;
}

/** The relative files a module's source imports, resolved against its own folder as repository paths. */
function edgesOf(path, source) {
  return [...source.matchAll(IMPORT_EDGE)].map(match => posix.normalize(posix.join(posix.dirname(path), match[2])));
}

/**
 * Load a move table as a release tag had it: the table file and every file its imports reach, written into a private scratch folder.
 * Why: the closure is read from the table's own imports at the tag, never hard-coded, so a table that moved or grew still loads;
 * the working tree is only read for the tag name, so a release can be judged while the tree holds a different table.
 *
 * @param {string} root - The repository root.
 * @param {string | undefined} name - The table's name, its file's name without `.table.js`.
 * @param {string | undefined} tag - A release tag the repository has.
 * @returns {Promise<{ name: string, tag: string, table: object, rules: object, dispose: () => void }>}
 */
export async function loadMoveTableAtTag(root, name, tag) {
  const files = tag ? filesAt(root, tag) : null;
  if (!files) {
    const known = tagNames(root);
    throw new Refused('JUDGE_TAG', `${tag ? `no tag is called ${tag}` : 'judging by a release needs the name of a tag'}; the repository has the tags ${known.join(', ') || 'none'}`,
      known.length ? `run it again with one of the tags: ${known.join(', ')}` : 'tag the release first, then run it again');
  }
  const file = [...files].find(path => /^packages\/[^/]+\/src\/logic\/(?:.*\/)?[^/]+\.table\.js$/u.test(path) && basename(path) === `${name}.table.js`);
  if (!file) {
    const known = [...files].filter(path => path.endsWith('.table.js')).map(path => basename(path).replace(/\.table\.js$/u, ''));
    throw new Refused('JUDGE_TABLE', `the tag ${tag} holds no move table called ${name}; the tables it holds are ${known.join(', ') || 'none'}`, 'judge a table the release already had, or run pullboard replay <table> without the release');
  }
  const folder = scratchFolder('pullboard-at-tag-');
  const dispose = () => rmSync(folder, { recursive: true, force: true });
  try {
    const wanted = [file];
    const seen = new Set();
    for (let at = 0; at < wanted.length; at += 1) {
      const path = wanted[at];
      if (seen.has(path)) continue;
      seen.add(path);
      const read = tryGit(root, ['show', `refs/tags/${tag}:${path}`]);
      if (read.status !== 0) throw new Refused('JUDGE_TAG', `the tag ${tag} could not give ${path}: ${read.stderr.slice(0, 200)}`, 'check the repository holds the tag completely');
      mkdirSync(join(folder, dirname(path)), { recursive: true });
      writeFileSync(join(folder, path), `${read.stdout}\n`);
      wanted.push(...edgesOf(path, read.stdout).filter(edge => files.has(edge)));
    }
    writeFileSync(join(folder, 'package.json'), '{ "type": "module" }\n');
    const module = loadDiscovered(file, pathToFileURL(`${folder}/`));
    const pick = (suffix) => Object.entries(module).find(([key]) => key.endsWith(suffix))?.[1];
    const table = pick('_TABLE');
    const rules = pick('_RULES');
    if (!table || !rules) throw new Refused('JUDGE_TABLE', `table ${name} at ${tag} is not a table that can be judged, since ${file} exports no *_TABLE and *_RULES pair`, 'judge a table that exports both');
    return { name, tag, table, rules, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
