/** Answer the controller's health request from the worker's own runner root [C7]. */
import { runnerHealthReply } from './runner-transport.js';
import { runnerIdleReply } from './runner-transport.js';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';

/** Print one health or idle reply for a base64 request, exiting non-zero when the request is not exact. */
export function serveHealth(encodedRequest) {
  try {
    const request = JSON.parse(Buffer.from(encodedRequest ?? '', 'base64').toString('utf8'));
    if (!/^[a-f0-9-]{36}$/u.test(request.nonce ?? '') || request.root !== undefined && !isAbsolute(request.root)) throw new Error('invalid health request');
    const root = request.root ?? join(isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir, '.pullboard-runner');
    process.stdout.write(JSON.stringify(request.idle === true ? runnerIdleReply(root, request) : runnerHealthReply(root, request)) + '\n');
  } catch { process.exitCode = 1; }
}
