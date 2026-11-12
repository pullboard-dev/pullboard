/** The designated recovery checkout remains protected independently of opt-in settings [B3,C7]. */
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { relative } from 'node:path';
import { resolve } from 'node:path';
import { sep } from 'node:path';

/** Protect the retained recovery checkout and any ancestor whose removal could erase it. */
export function maintenanceProtectedPath(path) {
  const protectedPath = join(homedir(), 'Code', 'pullboard');
  const overlaps = (parent, child) => {
    const part = relative(resolve(parent), resolve(child));
    return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
  };
  return overlaps(path, protectedPath) || overlaps(protectedPath, path);
}
