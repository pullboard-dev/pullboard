/** Pure companion path validation is shared by classification and composition [V4,H16]. */
import { Refused } from './refused.js';

/** Refuse unsupported path inputs without reading Git or launching a process. */
function refuse(message) { throw new Refused('ITEM_PATCH', message); }

/** Accept only portable repository paths, excluding Git control directories. */
export function safeItemPatchPath(path) {
  return typeof path === 'string' && path.length <= 4096 && !/[\\\s\x00-\x1f\x7f]/.test(path)
    && !path.startsWith('/') && !path.includes(':')
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** Validate a deliberately bounded ordinary Git patch; all declared paths must be safe. */
export function itemPatchPaths(patch) {
  const paths = new Set();
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || match[1] !== match[2] || !safeItemPatchPath(match[1])) refuse('unsupported or unsafe patch path');
      paths.add(match[1]);
    }
    if (/^(?:rename |copy |similarity index |dissimilarity index )/.test(line)) refuse('rename and copy patches are unsupported');
    const mode = /^(?:old mode|new mode|new file mode|deleted file mode) (\d+)$/.exec(line);
    if (mode && !['100644', '100755'].includes(mode[1])) refuse('only regular-file patch modes are supported');
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = line.slice(4);
      if (path !== '/dev/null' && (!/^[ab]\//.test(path) || !safeItemPatchPath(path.slice(2)))) refuse('unsafe patch file header');
    }
  }
  if (!paths.size) refuse('patch has no supported file changes');
  return paths;
}

