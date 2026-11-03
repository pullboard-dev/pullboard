#!/usr/bin/env node
/** An authenticated landing wake holds no foreground lease while it waits [B35,B3,R3]. */
import * as nativeBoard from '../apps/lib/index.js';
import * as outbox from '../packages/outbox/index.js';
import { context } from '../src/cli.js';
import { landAfterAcceptance } from '../src/commands/land.js';
import { resumeAutomaticLanding } from '../packages/landing/index.js';
import { AGENT_SESSION_IDS } from '../packages/kernel/index.js';
import { AGENT_SHELL_MARKERS } from '../packages/kernel/index.js';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(import.meta.url);

/**
 * The scheduled wake's own io: the outbox, the native board and the board openers the relay path asks for.
 * Why: exported so a test drives landing through exactly the io the wake builds, not a hand-made copy (#2479).
 */
export function wakeIo(root) {
  return { ...outbox, cwd: root, nativeBoard, stdout: process.stdout, stderr: process.stderr,
    replayConflictRecord: outbox.replay,
    openBoard: (...args) => nativeBoard.openBoard(...args), nativeBoardPorts: (...args) => nativeBoard.nativeBoardPorts(...args),
    outboxPolicy: () => ({ acknowledgedOperations: outbox.ACKNOWLEDGED_OPERATIONS, outboxQueueable: outbox.outboxQueueable }),
    say: console.log, err: console.error };
}

if (process.argv[1] === FILE) {
const [root, token, scheduled, wakeFlag, dueAt] = process.argv.slice(2);
if (!isAbsolute(root ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token ?? '')
  || scheduled !== '--scheduled' || wakeFlag !== '--wake-at' || !Number.isFinite(Date.parse(dueAt)) || process.argv.length !== 7) {
  throw new Error('automatic landing requires its registered root, token and wake time');
}
for (const key of [...AGENT_SESSION_IDS, ...AGENT_SHELL_MARKERS, 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID', 'PULLBOARD_PARENT_SESSION']) delete process.env[key];
await resumeAutomaticLanding(root, token, dueAt, async () => landAfterAcceptance(context(wakeIo(root))));

}
