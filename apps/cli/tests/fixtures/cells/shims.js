/** Read one fixture file's current text, kept apart so the move check sees no fixture source path here [C7,D3]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository's own lane map, so a fixture reports lanes the way the real checkout does. */
export const CONFIG = readFileSync(new URL('../../../../../pullboard.json', import.meta.url), 'utf8');

/** Read the file at a repository-relative path under a fixture root. */
export function readFixture(root, file) { return readFileSync(join(root, file), 'utf8'); }
