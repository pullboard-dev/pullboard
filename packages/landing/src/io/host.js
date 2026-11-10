/** A constrained landing runs only on an opted-in host whose actual environment matches [E27,E28]. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { repoInfo } from '../../../git/index.js';
import { mainPolicy } from '../../../sandbox/light.js';
import { loadMachineSettings } from '../../../config/index.js';
import {
  environmentLabel,
  executionEnvironment,
} from '../../../sandbox/light.js';
import { sameEnvironment } from '../../../verify/light.js';
import { Refused } from '../../../kernel/index.js';

/** Check one machine's own choice; a board policy never opts another machine in. */
export function requireLandingHost(board, config) {
  const required = config.landing?.environment;
  if (!required) return null;
  const actual = executionEnvironment();
  if (!sameEnvironment(required, actual)) throw new Refused('LAND_ENVIRONMENT', `this host is ${environmentLabel(actual)}; this board lands on ${environmentLabel(required)}; run land on a matching machine`);
  if (!(loadMachineSettings().landing?.pools ?? []).includes(board)) throw new Refused('LAND_HOST_NOT_JOINED', 'this machine has not joined this board’s landing pool; run pullboard settings landing.pool on here');
  return actual;
}

/** Read the immutable policy before admission; never open the board inside a queue transaction. */
export function constrainedLandingHost(root) {
  const config = mainPolicy(root).config;
  if (!config.landing?.environment) return null;
  const database = new DatabaseSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return requireLandingHost(database.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get()?.meta_value, config); }
  finally { database.close(); }
}
