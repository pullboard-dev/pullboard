#!/usr/bin/env node
/**
 * Write a seat's spare checkout, detached from the claim that asked for it, so the next claim moves a ready folder [C7,#5776].
 * Usage: spare.js <repository root> <spare path> <trunk> [git config arguments...]. Git locks the worktree until its files are written.
 */
import { isAbsolute } from 'node:path';
import { tryGit } from '../../../../../../../packages/git/index.js';

const [root, spare, trunk, ...workers] = process.argv.slice(2);
if (!isAbsolute(root ?? '') || !isAbsolute(spare ?? '') || !trunk) throw new Error('spare requires an absolute root, an absolute spare path and the trunk branch');
tryGit(root, [...workers, 'worktree', 'add', '-q', '--detach', spare, trunk]);
