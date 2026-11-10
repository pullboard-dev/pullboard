/** Shared real Chrome arguments, separate from generic Node process stand-ins [C7]. */
export function chromeLaunchArgs(profile) {
  return ['--disable-features=MacAppCodeSignClone', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-proxy-server',
    '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0',
    // A person's real view holds 4890; no test Chrome may reach it, even by preconnect.
    '--host-resolver-rules=MAP 127.0.0.1:4890 ~NOTFOUND, MAP localhost:4890 ~NOTFOUND', `--user-data-dir=${profile}`, 'about:blank'];
}
