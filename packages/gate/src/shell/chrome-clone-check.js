/** Observe macOS Chrome clone growth without deleting or attributing directories [C7]. */
import { nativeUserDirectory } from './native-user-directory.js';
import {
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';

/** Locate only the current account's native Chrome clone namespaces. */
export function chromeCloneDirectories() {
  if (process.platform !== 'darwin') return [];
  const user = nativeUserDirectory();
  const root = join(dirname(user.replace(/\/$/u, '')), 'X');
  return ['com.google.Chrome', 'org.chromium.Chromium'].map(bundle => join(root, `${bundle}.code_sign_clone`));
}

/** Snapshot directory identities so concurrent old-clone removal cannot conceal a newly created clone. */
export function chromeCloneSnapshot() {
  const result = [];
  for (const directory of chromeCloneDirectories()) {
    let names;
    let canonical;
    try { names = readdirSync(directory); canonical = realpathSync(directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names.filter(name => /^code_sign_clone\.[A-Za-z0-9._-]{6}$/u.test(name))) {
      try {
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) result.push(`${join(canonical, name)}:${stat.dev}:${stat.ino}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return result.sort();
}

/** Report new identities only; this is a growth check, never evidence authorizing cleanup. */
export function newChromeClones(before, after = chromeCloneSnapshot()) {
  const known = new Set(before);
  return after.filter(identity => !known.has(identity));
}
