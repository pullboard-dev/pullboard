/** Refresh the source-discovered format table without changing any format/version declaration [A5,C7]. */
import { fileURLToPath } from 'node:url';
import { writeFormatTable } from '../../packages/state/index.js';

writeFormatTable(fileURLToPath(new URL('../../', import.meta.url)));
