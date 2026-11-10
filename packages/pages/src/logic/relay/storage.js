/** Old API1 routers may reject an unknown capability path with either supported envelope status [H15,H17]. */

/** Treat only a recognized old route response as unsupported, never an auth or uncertain transport refusal. */
export function legacyPageRoute(error) {
  return error?.relayVersion === 1 && (error.httpStatus === 404 || error.httpStatus === 400 && error.code === 'BAD_REQUEST');
}

/** Keep account quota status only after validating its credential-free response fields. */
export function relayStorage(value) {
  if (!value || typeof value.account?.id !== 'string' || typeof value.account?.login !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/u.test(value.account.id) || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.account.login) ||
      !Number.isSafeInteger(value.usedBytes) || value.usedBytes < 0 || !Number.isSafeInteger(value.limitBytes) || value.limitBytes < 1) return null;
  return { account: { id: value.account.id, login: value.account.login }, usedBytes: value.usedBytes, limitBytes: value.limitBytes };
}

/** Print account, used bytes and the operator-set limit without importing server-only quota storage into the CLI. */
export function relayStorageLine(value) {
  const storage = relayStorage(value);
  return storage ? `relay storage: account ${storage.account.login}, ${(storage.usedBytes / 1_000_000).toFixed(1)} MB used of ${(storage.limitBytes / 1_000_000).toFixed(1)} MB` : '';
}
