/** @pullboard-test-input source-cell packages/kernel */
/** @pullboard-world-pin reads packages/kernel/src to prove every file is on the kernel allowlist [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const KERNEL = fileURLToPath(new URL('..', import.meta.url));

/** Every file under a folder, as paths relative to it with forward slashes. */
function filesUnder(folder, base = folder) {
  return readdirSync(folder, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? filesUnder(join(folder, entry.name), base) : [join(folder, entry.name).slice(base.length + 1).split('\\').join('/')])
    .sort();
}

/** The kernel files that are not on the allowlist, so a lint can name each one. */
function unlisted(files, allowed) {
  const known = new Set(allowed);
  return files.filter(file => !known.has(file));
}

const allowlist = JSON.parse(readFileSync(join(KERNEL, 'data/ceilings/allowlist.json'), 'utf8')).files;

test('kernel.allowlist.kernel-files-stay-within-the-declared: kernel files stay within the declared allowlist [C7]', () => {
  const extra = unlisted(filesUnder(join(KERNEL, 'src')), allowlist);
  assert.deepEqual(extra, [], `kernel file(s) not on the allowlist in packages/kernel/data/ceilings/allowlist.json: ${extra.join(', ')}; move the file to the package that owns it`);
});

test('kernel.allowlist.adding-a-file-to-packages-kernel: adding a file to packages/kernel/src that is not on the allowlist is named by the lint [C7]', () => {
  assert.deepEqual(unlisted([...allowlist, 'logic/newcomer.js'], allowlist), ['logic/newcomer.js']);
});

test('kernel.allowlist.every-allowlist-entry-is-a-kernel: every allowlist entry is a kernel file that exists, so the list only shrinks [C7]', () => {
  const present = new Set(filesUnder(join(KERNEL, 'src')));
  assert.deepEqual(allowlist.filter(file => !present.has(file)), []);
});
