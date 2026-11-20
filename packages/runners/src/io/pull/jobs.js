/** The coordinator's durable record of one pulled runner job: what `finish` needs, without re-scanning source [C7,#5465]. */
import { machineHome } from '../../../../resources/index.js';
import { Refused } from '../../../../kernel/index.js';
import { join } from 'node:path';
import { storeName } from '../store-names.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/** A job id is a UUID; anything else never becomes a path. */
const JOB_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/** The directory of job records: a file per job, never a row in the lease database (its lock stalled 21 gates on 6 Nov). */
export function jobsDirectory() { return join(machineHome(), 'runner-jobs'); }

/** The record file of one job id; refuses a name that is not a job id. */
export function jobFile(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) throw new Refused('RUNNER_PULL_JOB', 'the runner job id is not valid; resubmit the run');
  return join(jobsDirectory(), storeName(id));
}

/** Write the record whole or not at all, so a reader never sees half of it. */
export function writeJob(job) {
  const file = jobFile(job.id);
  fs.mkdir(jobsDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
  fs.rename(temporary, file);
}

/** Read one record; a missing or damaged one is a typed refusal naming the next step. */
export function readJob(id) {
  try {
    const job = JSON.parse(fs.readFile(jobFile(id), 'utf8'));
    if (job?.version !== 1 || job.id !== id) throw new Error('foreign record');
    return job;
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused('RUNNER_PULL_JOB', `the record of runner job ${id} is missing or damaged; resubmit the run`);
  }
}

/** Merge new fields into a record, for the phase marks a later short process adds. */
export function updateJob(id, change) {
  const job = readJob(id);
  writeJob({ ...job, ...change, phaseAt: { ...job.phaseAt, ...change.phaseAt } });
}

/** Remove a finished job's record; a record already gone is fine. */
export function removeJob(id) { fs.rm(jobFile(id), { force: true }); }

/** A private scratch folder for one pack build, kept beside the records so no temporary-folder path is named here. */
export function packDirectory() {
  fs.mkdir(jobsDirectory(), { recursive: true, mode: 0o700 });
  return fs.mkdtemp(join(jobsDirectory(), 'pack-'));
}
