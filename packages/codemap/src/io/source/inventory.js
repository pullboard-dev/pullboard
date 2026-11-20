/** Inventory legacy source and cell modules for the same source-only style policy [C7]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { join } from 'node:path';

/** Read JavaScript sources, including cell tests, without following directory symlinks. */
export function styleSources(root) {
  const fs = fileSystemAdapter();
  const sources = [];
  /** Traverse a repository source directory without inspecting generated dependencies. */
  function visit(directory) {
    for (const entry of fs.list(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(entry.name)) sources.push({ file, source: fs.readFile(join(root, file), 'utf8') });
    }
  }
  for (const directory of ['src', 'packages', 'apps']) if (fs.exists(join(root, directory))) visit(directory);
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}
