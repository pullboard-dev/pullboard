/** Prepare a fresh private attempt from captured tools; a crashed job's dirty source and artifacts stay intact [C7,V4]. */
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { tmpdir } from 'node:os';
import { Refused } from '../../../kernel/index.js';

/** Validate source custody before copying any tools or offering a new native queue identity. */
export function prepareDeadHandoffRetry(commonDir, item, job, directory) {
  if ((job.recoveryRetries ?? 0) >= 3) return null;
  const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
  if (request.job !== job.id || request.item !== item || request.commit !== job.commit || request.commonDir !== commonDir
    || (request.companion?.commit ?? job.commit) !== job.executionCommit || (request.companion?.tree ?? job.tree) !== job.executionTree
    || !basename(request.tools ?? '').startsWith(`pullboard-handoff-tools-${job.id}-`)
    || dirname(realpathSync(request.tools)) !== realpathSync(tmpdir())) {
    throw new Refused('SUBMIT_HANDOFF_RECOVERY', 'retain the stopped job: its captured tools or source identity cannot be proved');
  }
  const id = randomUUID();
  const tools = mkdtempSync(join(tmpdir(), `pullboard-handoff-tools-${id}-`));
  const target = join(dirname(directory), id);
  try {
    cpSync(request.tools, tools, { recursive: true, mode: constants.COPYFILE_FICLONE });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, 'request.json'), JSON.stringify({ ...request, job: id, tools }) + '\n', { flag: 'wx', mode: 0o600 });
    /** Remove only this unqueued preparation if the captured native claim changed concurrently. */
    const discard = () => { rmSync(tools, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); };
    return { id, tools, directory: target, discard };
  } catch (error) { rmSync(tools, { recursive: true, force: true }); throw error; }
}
