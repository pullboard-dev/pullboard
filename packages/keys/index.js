/** @pullboard-module-loads packages/keys/src/io/adapter/signing.js */
/** Canonical entry points for the keys cell; every moved body is exported here once [C7]. */
import { createRequire } from 'node:module';
export { authenticateDeviceEnrollment, createDeviceKeys, devicePublicKey, signDeviceEnrollment, unwrapDeviceBoardKey, rotateBoardKeyForRoster, wrapBoardKeyToRoster, wrapDeviceBoardKey } from './src/logic/device.js';
export { forgetBoardKey, readBoardKey, scrubLegacyPersonSessions, storeBoardKey } from './src/io/relay.js';
export { relayJoin, relayPair } from './src/io/relay/client.js';
export { deliverPersonEnrollments } from './src/io/relay/enrollment.js';

const requireModule = createRequire(import.meta.url);
/** The real signing adapter; its module loads on first call, so status and next do not pay for it [C7,#1428]. */
export function createSigningAdapter(options) { return requireModule('./src/io/adapter/signing.js').createSigningAdapter(options); }
/** The fake signing adapter; loaded on first call like the real one [C7,#1428]. */
export function createFakeSigningAdapter(options) { return requireModule('./src/io/adapter/signing.js').createFakeSigningAdapter(options); }
