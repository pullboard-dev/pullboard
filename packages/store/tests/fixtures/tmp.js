/** The one place fixtures make a temporary directory, so the package and app kits share it [C7]. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Make an empty temporary directory; the caller removes it. The single place fixtures create one [C7]. */
export function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
