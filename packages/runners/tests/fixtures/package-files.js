/** Private package fixtures shared by the package file tests [C7,P3]. */
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { copyRunnerPackage } from './package.js';

/** Create isolated package bytes and remove only this test's owned temporary directory. */
export function fixture(t, files = ['src', 'apps', 'packages/*/src']) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-package-copies-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  mkdirSync(root);
  /** Write ordinary private fixture files without touching production source or settings. */
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('package.json', JSON.stringify({ type: 'module', files }));
  write('src/entry.js', "export { value } from '../packages/leaf/src/value.js';\n");
  write('packages/leaf/src/value.js', 'export const value = 42;\n');
  write('packages/leaf/tests/private.test.js', 'not shipped');
  write('outside-secret.txt', 'not shipped');
  write('.git/private-state', 'not shipped');
  return { root, directory, write };
}

/** Independently enumerate actual destination files rather than trusting the copy helper's returned manifest. */
export function copiedFiles(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? copiedFiles(join(root, entry.name), file) : [file];
  }).sort();
}

/** Install actual published tooling into one private fixture without borrowing native execution receipts. */
export function controllerFixture(t) {
  const f = fixture(t);
  const installed = join(f.directory, 'installed');
  copyRunnerPackage(resolve(import.meta.dirname, '../../../..'), installed);
  return { ...f, installed };
}
