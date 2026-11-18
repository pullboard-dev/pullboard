/** The CLI entry file the fixture local runner starts from, named once for the fixtures to pass in [C7,#8203]. */
import { resolve } from 'node:path';

export const CLI_ENTRY = resolve(import.meta.dirname, '../../../pullboard.js');
