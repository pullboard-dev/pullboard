/** The pullboard digest command, in its own module so an item adding another command never edits these lines. */
import {
  digestCommand,
} from '../digest.js';
import {
  context,
} from '../cli.js';
import { healthReport } from '../health.js';
import { dispatchHealth } from '../dispatch-health.js';

/** Bind the upper dispatch operation while preserving the digest reader's exact SQLite snapshot. */
function digestHealth(options) {
  return healthReport({ ...options, dispatchHealth });
}

/** Run `pullboard digest` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  return digestCommand(io, { first, second, rest, values }, context(io), { healthReport: digestHealth });
}
