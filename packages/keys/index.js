/** Canonical entry points for the keys cell; every moved body is exported here once [C7]. */
export { authenticateDeviceEnrollment, createDeviceKeys, devicePublicKey, signDeviceEnrollment, unwrapDeviceBoardKey, rotateBoardKeyForRoster, wrapBoardKeyToRoster, wrapDeviceBoardKey } from './src/logic/device.js';
export { forgetBoardKey, readBoardKey, scrubLegacyPersonSessions, storeBoardKey } from './src/io/relay.js';
export { relayJoin, relayPair } from './src/io/relay/client.js';
export { deliverPersonEnrollments } from './src/io/relay/enrollment.js';

/** The signing adapter factories load at the call, so status and next never load the adapter module; the factories it returns stay synchronous [C7,#1428]. */
export function loadSigningAdapter() {
  return import("./src/io/adapter/signing.js");
}
