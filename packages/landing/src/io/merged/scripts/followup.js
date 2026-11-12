#!/usr/bin/env node
/**
 * A recorded hand landing's follow-up, detached from `pullboard merged`: place uncovered files, then, unless forced,
 * the plan check, the smoke and the module-resolution scan. Each outcome goes to merged-checks.log in the machine's
 * pullboard home
 * [C7]. Why detached: run before the record, these held each `merged` for 15+ minutes on 9 Nov.
 */
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { mergedChecksLog } from '../../../../index.js';
import { runMergedFollowup } from '../../../../index.js';

const [root, commit, flag] = process.argv.slice(2);
if (!isAbsolute(root ?? '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) {
  throw new Error('merged-followup requires an absolute root and the recorded commit');
}
const log = mergedChecksLog();
mkdirSync(dirname(log), { recursive: true });
const say = line => appendFileSync(log, `${new Date().toISOString()} ${commit.slice(0, 12)} ${line}\n`);
say(`follow-up started${flag === '--forced' ? ' (forced)' : ''}`);
const { red } = await runMergedFollowup(root, commit, { forced: flag === '--forced', say });
say(red.length ? `follow-up red: ${red.join(', ')}` : 'follow-up done');
