/** A worker thread that judges static checks needing VM modules, for the resident process's preflight call [C7,#5330]. */
import { parentPort } from 'node:worker_threads';
import { workerData } from 'node:worker_threads';
import { checkResults } from './calls.js';

parentPort.postMessage(await checkResults(workerData.root, workerData.files, workerData.names));
