/** Old API1 routers may reject an unknown capability path with either supported envelope status [H15,H17]. */

/** Treat only a recognized old route response as unsupported, never an auth or uncertain transport refusal. */
export function legacyPageRoute(error) {
  return error?.relayVersion === 1 && (error.httpStatus === 404 || error.httpStatus === 400 && error.code === 'BAD_REQUEST');
}
