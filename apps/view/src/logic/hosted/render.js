/**
 * Opening your board at https://app.pullboard.dev [N26,H5]: the page shows one screen at a time, in the words the
 * person approved on 17 Oct, until there is a board to show. Each screen is a heading, at most one line, one thing to
 * do, and, where something can go wrong, a sentence to copy for your agent. There is no Try again: the page looks
 * again by itself and says that it is waiting. hostedMarkup builds every part on the server; hostedState,
 * hostedBrowser and drawHosted run in the page, which inlines them by their source, so each reads nothing beyond its
 * own arguments.
 */

const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect fill="var(--accent)" width="56" height="14" x="3" y="25" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
const GITHUB = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const SPEECH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>';
const THEME = '<svg class="sys" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M8 2a6 6 0 0 1 0 12Z"/></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M3.4 12.6l.85-.85M11.75 4.25l.85-.85"/></svg><svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M13.6 9.6A6 6 0 1 1 6.4 2.4a5.2 5.2 0 0 0 7.2 7.2Z"/></svg>';

/** The sentence each computer command box offers to say to your agent instead. */
const OPEN_ASK = 'Help me open my Pullboard board.';

/**
 * A command in a mono box with its Copy button, then the "or" box of the same height that asks your agent instead.
 *
 * @param {string} command - The command, or '' for one the page fills in.
 * @param {string} ask - The sentence for the agent.
 * @param {string} [id] - The id prefix of a box whose command and sentence the page fills in.
 * @returns {string}
 */
function commandBoxes(command, ask, id = '') {
  const code = id ? ` id="${id}-code"` : '';
  const copy = id ? ` id="${id}-copy"` : '';
  const said = id ? ` id="${id}-ask"` : '';
  const agentCopy = id ? ` id="${id}-agent"` : '';
  return `<div class="ob-cmd"><code><span class="ob-p" aria-hidden="true">$</span><span${code}>${command}</span></code><button type="button" data-copy="${command}"${copy}>Copy</button></div>`
    + '<div class="ob-or">or</div>'
    + `<div class="ob-agent">${SPEECH}<span>Ask your agent<small${said}>“${ask}”</small></span><button type="button" data-copy="${ask}"${agentCopy}>Copy</button></div>`;
}

/**
 * Every part of every open-board screen, shown one screen at a time. The section keeps the ids the page always read
 * (local-note, local-note-title, local-note-text, local-note-code, local-note-view), so what reads them keeps working.
 * On the hosted page the first screen, Finding your boards, is there at first paint, before any script runs.
 *
 * @param {string} localView - The local view's address, the default the page links before it knows another.
 * @param {{looking?: boolean, signIn?: string|null}} [options] - Whether the page opens on Finding your boards, and the sign-in path.
 * @returns {string}
 */
export function hostedMarkup(localView, { looking = false, signIn = null } = {}) {
  const github = `<a class="ob-big ob-gh"${signIn ? ` href="${signIn}"` : ''}>${GITHUB}Sign in with GitHub</a>`;
  return `<section class="open-board" id="local-note" role="status" data-state="${looking ? 'looking' : ''}" data-kind="${looking ? 'state' : ''}"${looking ? '' : ' hidden'}>
    <header class="ob-top"><button class="theme-btn" id="ob-theme" type="button" title="Theme">${THEME}</button></header>
    <div class="ob-panel">
      <div class="ob-mark">${MARK}<span>Pullboard</span></div>
      <h1 id="local-note-title">${looking ? 'Finding your boards…' : ''}</h1>
      <p class="ob-say" id="local-note-text" hidden></p>
      <div class="ob-spin" data-part="spin" aria-hidden="true"${looking ? '' : ' hidden'}></div>
      <div class="ob-ask" data-part="ask" hidden><div class="t">app.pullboard.dev wants to</div> <div class="d">Access other apps and services on this device</div> <div class="b"><span>Block</span> <span class="yes">Allow</span></div> <div class="arrow">↑ click this</div></div>
      <ol class="ob-steps" data-part="steps" hidden><li><span>Click the <b>icon left of the address</b>, at the top of this window.</span></li><li><span>Find <b>Local network access</b>, or <b>Apps on this device</b>.</span></li><li><span>Set it to <b>Allow</b>.</span></li></ol>
      <div class="ob-two" data-part="two" hidden>
        <section class="ob-card"><span class="ob-k">Local only</span><h2>Open them on this computer</h2><p>Your boards stay on this computer, and only this computer sees them. Open a terminal and run:</p>
          <div class="ob-act">${commandBoxes('pullboard view', OPEN_ASK)}</div>
          <p class="ob-small">Either way, this page opens your boards by itself.</p></section>
        <section class="ob-card"><span class="ob-k">Everywhere</span><h2>Open them from any device</h2><p>Your boards on your phone and every computer, from the GitHub account you shared them with.</p>
          <div class="ob-act">${github}</div>
          <p class="ob-small">Not shared yet? After you sign in, it shows the one step.</p></section>
      </div>
      <div class="ob-act" data-part="github" hidden>${github.replace('<a ', '<a id="local-note-go" ')}</div>
      <div class="ob-act" data-part="command" hidden>${commandBoxes('', OPEN_ASK, 'local-note')}</div>
      <div class="ob-act" data-part="open" hidden><a class="ob-big ob-go" id="local-note-view" href="${localView}/local/view">Open your board</a></div>
      <p class="ob-small" data-part="local-open" hidden><a id="local-note-direct" href="${localView}/local/view">Open your board on this computer</a></p>
      <p class="ob-small" data-part="local-command" hidden>On this computer, run <code>pullboard view</code> to open your board in its own page.</p>
      <p class="ob-small" id="local-note-small" hidden></p>
      <p class="ob-live" id="local-note-live" hidden><i aria-hidden="true"></i><span></span></p>
      <div class="ob-help" id="local-note-help" hidden>${SPEECH}<span><span id="local-note-lead"></span><small id="local-note-said"></small></span><button type="button" id="local-note-help-copy" data-copy="">Copy</button></div>
    </div>
  </section>`;
}

/**
 * Name the browser the page runs in. Only Chromium browsers answer the local network permission the page asks about,
 * so they are the ones a block is ever reported from.
 *
 * @param {{userAgent?: string, userAgentData?: {brands?: {brand: string}[]}}} agent - The page's navigator.
 * @returns {string}
 */
export function hostedBrowser(agent) {
  const brands = (agent?.userAgentData?.brands || []).map((entry) => entry.brand).join(' ');
  const said = brands + ' ' + (agent?.userAgent || '');
  if (/Edge|Edg\//.test(said)) return 'Edge';
  if (/Opera|OPR\//.test(said)) return 'Opera';
  if (/Chrom/.test(said)) return 'Chrome';
  if (/Firefox\//.test(said)) return 'Firefox';
  if (/Safari\/|AppleWebKit\//.test(said)) return 'Safari';
  return 'This browser';
}

/**
 * What the page shows in one state, or null for none. A "state" stands in for the board, alone on the page; a "note"
 * is one quiet line over a list that shows. The words are the approved screens' own: Finding your boards, Click Allow,
 * Your browser said no and Where are your projects? on a computer, and #757's two screens, Your boards, on your phone
 * and One step on your computer, for a phone and for a person signed in with nothing shared.
 *
 * @param {string|null} state - looking, local-open, asking, blocked, not-running, mismatch, problem, signed-out, no-linked, unpaired, signed-out-paired, linked-failed or local-failed.
 * @param {{phone?: boolean, detail?: string, linked?: string[], localNavigationOnly?: boolean, listed?: boolean, signedIn?: boolean, localOriginKnown?: boolean}} [facts] - The device, refusal, linked boards and whether local boards need their own page beside a listed relay board.
 * @returns {null|{state: string, kind: string, heading: string, text?: string, parts: string[], command?: string, ask?: string, small?: string, live?: string, lead?: string, help?: string, detail?: string}}
 */
export function hostedState(state, facts = {}) {
  const agent = 'Something not working? Ask your agent';
  const opening = 'Help me open my Pullboard board.';
  const updating = 'Help me update Pullboard.';
  const shared = facts.linked || [];
  const share = { kind: 'state', heading: 'One step on your computer', text: 'On the computer with your projects, open a terminal and run this once:', parts: ['command'], command: 'pullboard relay on --all', ask: 'Help me share my boards with my phone.',
    small: 'It shares every project with your account. Your boards show up here by themselves.', live: 'Waiting for your boards' };
  const models = {
    'looking': { kind: 'state', heading: 'Finding your boards…', parts: ['spin'] },
    'local-open': { kind: facts.listed ? 'note' : 'state', heading: 'Open this computer’s board',
      text: !facts.listed && !facts.localOriginKnown ? 'This command opens your board in its own page.' : undefined,
      parts: [facts.listed ? (facts.localOriginKnown ? 'local-open' : 'local-command') : (facts.localOriginKnown ? 'open' : 'command'),
        ...(facts.signedIn ? [] : ['github'])], command: 'pullboard view', ask: opening },
    'asking': { kind: 'state', heading: 'Click Allow', text: 'Your browser is asking if this page may open the boards on this computer. Your boards stay on this computer.', parts: ['ask'],
      live: 'Waiting for you to click Allow', lead: agent, help: 'Help me allow Pullboard in my browser.' },
    'blocked': { kind: 'state', heading: 'Your browser said no', text: 'That\'s fine. Turn it back on in three clicks:', parts: ['steps'],
      live: 'Your boards open as soon as it\'s on', lead: agent, help: 'My browser blocked Pullboard. Help me fix it.' },
    'not-running': { kind: 'state', heading: 'Where are your projects?', parts: ['two'], live: 'Still looking on this computer', wide: true },
    'mismatch': { kind: 'state', heading: 'Update Pullboard on this computer', text: 'The Pullboard on this computer does not match this page. Update it, and this page opens your boards by itself.', parts: ['command'],
      command: 'npm i -g pullboard', ask: updating, live: 'Still looking on this computer', lead: agent, help: updating },
    'problem': { kind: 'state', heading: 'Open your board', text: facts.detail || 'This page could not take the connection Pullboard on this computer sent back.', parts: ['open'], lead: agent, help: opening },
    'signed-out': facts.phone
      ? { kind: 'state', heading: 'Your boards, on your phone', text: 'Sign in with the GitHub account you use on your computer.', parts: ['github'], small: 'Nothing to install on your phone.',
        lead: 'Stuck? On your computer, ask your agent', help: 'Help me see my boards on my phone.' }
      : { kind: 'state', heading: 'Open them from any device', text: 'Your boards on your phone and every computer, from the GitHub account you shared them with.', parts: ['github'], small: 'Not shared yet? After you sign in, it shows the one step.',
        lead: agent, help: opening },
    'no-linked': share,
    // The account shares boards this browser holds no key for. Running the command alone never opens them here: a
    // browser enrolls only from the pairing link the command prints (apps/relay/src/io/deploy/browser-devices.js enrollPhone), so the
    // screen says to open that link or scan its QR, as the screen before it did.
    'unpaired': { ...share, text: 'On the computer with your projects, open a terminal and run this, then open the link it prints here or scan its QR:', ask: opening,
      small: 'Your account shares ' + (shared.join(', ') || 'your boards') + '. This browser opens ' + (shared.length === 1 ? 'it' : 'them') + ' from that link.' },
    // A browser paired here before whose relay session ended: its shared boards cannot load, so it says why (#902).
    'signed-out-paired': { kind: 'note', heading: 'Signed out of pullboard.dev', text: 'Your session here ended, so your shared boards cannot open. Sign in again to see them; the boards on this computer stay open.', parts: ['github'] },
    'linked-failed': { kind: 'note', heading: 'Shared boards did not load', text: 'They show here by themselves once they answer.', parts: [], detail: facts.detail },
    'local-failed': { kind: 'note', heading: 'This computer\'s boards did not load', text: 'They show here by themselves once Pullboard answers.', parts: [], detail: facts.detail },
  };
  const model = state ? models[state] : null;
  return model ? { state, ...model, parts: [...model.parts,
    ...(facts.localNavigationOnly && state !== 'local-open' ? [facts.localOriginKnown ? 'local-open' : 'local-command'] : [])] } : null;
}

