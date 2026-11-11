/** One status line about signing: whether person moves are signed, and where they are confirmed. */
export function signingLine(signing) {
  return signing.signed
    ? 'person moves are signed: each one waits for your passkey on the relay'
    : 'person moves are not signed; pullboard settings person.signed on makes each one wait for your passkey';
}
