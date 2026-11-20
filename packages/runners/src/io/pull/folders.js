import { join } from 'node:path';
import { Refused } from '../../../../kernel/light.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/**
 * Replace each folder argument with the test files under it, sorted, since node cannot import a directory
 * (ERR_UNSUPPORTED_DIR_IMPORT). A folder holding none refuses, naming the folder and how to pick files.
 */
export function expandTestFolders(root, files) {
  const found = (dir) => fs.list(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap(entry => (entry.isDirectory() ? found(`${dir}/${entry.name}`) : entry.name.endsWith('.test.js') ? [`${dir}/${entry.name}`] : []));
  return files.flatMap((file) => {
    if (!fs.exists(join(root, file)) || !fs.stat(join(root, file)).isDirectory()) return [file];
    const inside = found(file.replace(/\/+$/u, ''));
    if (!inside.length) throw new Refused('NO_TEST_FILE', `no test file under ${file}; name the test files to run: pullboard test <file> [more files]`);
    return inside;
  });
}
