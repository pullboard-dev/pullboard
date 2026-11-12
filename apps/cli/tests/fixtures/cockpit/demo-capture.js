/** Browser capture helpers for the cockpit demo journey [N26]. */
/** Observe the decision target, its render-time replacement, and native pointer geometry without changing input. */
export async function armDecisionPressCapture(chrome, selector) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const root = document.querySelector('#feed');
    const initial = document.querySelector(${JSON.stringify(selector)});
    if (!root || !initial) return { armed: false, reason: 'decision target was absent before press' };
    const events = [], renders = [], mutations = [], resizes = [];
    /** Read the old or current button's viewport box without mutating layout. */
    const box = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, connected: element.isConnected };
    };
    /** Identify the action node and record whether it is the original native target. */
    const identity = element => element ? { tag: element.tagName, className: String(element.className || '').slice(0, 80),
      action: element.getAttribute('data-go'), connected: element.isConnected, isInitial: element === initial, box: box(element) } : null;
    const initialSnapshot = identity(initial);
    /** Keep a bounded native-event sample with both target identities and their measured boxes. */
    const sample = (type, detail = {}) => {
      if (events.length >= 40) return;
      const current = document.querySelector(${JSON.stringify(selector)});
      events.push({ type, at: performance.now(), pointerId: detail.pointerId ?? null,
        x: detail.clientX ?? null, y: detail.clientY ?? null, hitWasInitial: detail.hitWasInitial ?? null,
        scrollX, scrollY,
        initial: identity(initial), initialAtArm: initialSnapshot, current: identity(current) });
    };
    let prototype = root, descriptor = null;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, 'innerHTML');
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor?.get || !descriptor?.set) return { armed: false, reason: 'native innerHTML descriptor unavailable' };
    const previousOwn = Object.getOwnPropertyDescriptor(root, 'innerHTML');
    Object.defineProperty(root, 'innerHTML', { configurable: true, enumerable: descriptor.enumerable,
      /** Preserve the native element getter while observing production assignments to the decision panel. */
      get() { return descriptor.get.call(root); },
      /** Retain inline cockpit frames without exposing the view URL or its capability. */
      set(value) {
        if (renders.length < 20) renders.push({ at: performance.now(), oldInitialConnected: initial.isConnected,
          stack: (new Error().stack || '').split('\\n').filter(line => line.includes(location.origin))
            .map(line => line.replace(/https?:\\/\\/[^\\s)]+:(\\d+):(\\d+)/g, 'cockpit.inline:$1:$2')).slice(0, 4) });
        return descriptor.set.call(root, value);
      } });
    /** Record real browser pointer and mouse events at the document capture boundary. */
    const listener = event => {
      const hasPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
      sample(event.type, { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        hitWasInitial: hasPoint ? document.elementFromPoint(event.clientX, event.clientY) === initial : null });
    };
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) document.addEventListener(type, listener, true);
    window.addEventListener('scroll', listener, true);
    /** Record bounded panel mutations, including whether the original action was removed. */
    const observer = new MutationObserver(records => {
      if (mutations.length < 20) mutations.push({ at: performance.now(), records: records.length,
        removedInitial: records.some(record => [...record.removedNodes].some(node => node === initial || node.contains?.(initial))),
        current: identity(document.querySelector(${JSON.stringify(selector)})) });
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    /** Record native box-size notifications for the original and current action. */
    const resize = new ResizeObserver(entries => {
      if (resizes.length < 20) resizes.push({ at: performance.now(), entries: entries.length,
        initial: box(initial), current: box(document.querySelector(${JSON.stringify(selector)})) });
    });
    resize.observe(initial);
    window.__decisionPressCapture = { armed: true, selector: ${JSON.stringify(selector)}, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      armedAt: performance.now(), initial: identity(initial), events, renders, mutations, resizes,
      /** Stop all observation and restore the native innerHTML property before returning evidence. */
      finish() {
        sample('capture-finish');
        observer.disconnect(); resize.disconnect();
        for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) document.removeEventListener(type, listener, true);
        window.removeEventListener('scroll', listener, true);
        if (previousOwn) Object.defineProperty(root, 'innerHTML', previousOwn); else delete root.innerHTML;
        const result = { armed: true, selector: this.selector, viewport: this.viewport, armedAt: this.armedAt,
          initial: this.initial, events: this.events, renders: this.renders, mutations: this.mutations, resizes: this.resizes };
        delete window.__decisionPressCapture;
        return result;
      } };
    sample('capture-armed');
    return { armed: true, initial: identity(initial), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
  })())`, "document.querySelector('#feed')"));
}

/** Finish capture on the stable Needs-you root, removing every observer even after a failed press. */
export async function finishDecisionPressCapture(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify(window.__decisionPressCapture?.finish() || null)`, "document.querySelector('#feed')"));
}

/** Observe the existing shout form's native submit, validation, input and production value-clear path without changing them. */
export async function armPhoneAnswerLifecycleCapture(chrome, answerText) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const form = document.querySelector('#shout-form');
    const field = document.querySelector('#shout-text');
    if (!form || !field) return { armed: false, reason: 'shout form or text field was absent' };
    const originalForm = form;
    const originalField = field;
    const events = [];
    const cap = 100;
    const sentinel = ${JSON.stringify(answerText)};
    const observerErrors = [];
    let droppedEvents = 0;
    const sample = (type, extra = {}) => {
      try {
        if (events.length >= cap) { droppedEvents += 1; return; }
        const answerMode = document.querySelector('#answering');
        const submit = form.querySelector('[type="submit"]');
        const rect = submit?.getBoundingClientRect();
        const consoleNode = document.querySelector('#console');
        let acting = null, answering = null, viewStateAvailable = false;
        try { if (typeof view !== 'undefined') { viewStateAvailable = true; acting = view.acting ?? null; answering = view.answering ? { id: view.answering.id, rootMatches: view.answering.root === view.root } : null; } }
        catch { /* DOM state remains useful when module-local state is not exposed to this evaluation. */ }
        events.push({ type, wallAt: Date.now(), monotonicAt: performance.now(), valueLength: field.value.length,
          sentinelMatch: field.value === sentinel, answerModeVisible: Boolean(answerMode && !answerMode.hidden),
          answerModeTextLength: answerMode?.innerText?.length ?? 0,
          validity: { valid: field.validity.valid, valueMissing: field.validity.valueMissing, tooLong: field.validity.tooLong },
          formConnected: originalForm.isConnected, sameForm: document.querySelector('#shout-form') === originalForm,
          fieldConnected: originalField.isConnected, sameField: document.querySelector('#shout-text') === originalField,
          viewStateAvailable, acting, answering, console: consoleNode ? { className: consoleNode.className, hidden: consoleNode.hidden,
            textLength: consoleNode.textContent.length } : null,
          submit: submit ? { connected: submit.isConnected, disabled: submit.disabled,
            x: rect?.x ?? null, y: rect?.y ?? null, width: rect?.width ?? null, height: rect?.height ?? null } : null,
          ...extra });
      } catch (error) {
        if (observerErrors.length < 20) observerErrors.push({ type });
      }
    };
    const safeSample = (type, details) => {
      try { sample(type, details()); }
      catch { if (observerErrors.length < 20) observerErrors.push({ type }); }
    };
    const onInput = event => safeSample(event.type, () => ({ isTrusted: event.isTrusted }));
    const onSubmitCapture = event => safeSample('submit-capture', () => ({ isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented }));
    const onSubmitBubble = event => safeSample('submit-bubble', () => ({ isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented }));
    const onInvalid = event => safeSample('invalid', () => ({ isTrusted: event.isTrusted, targetId: event.target?.id ?? null,
      validity: event.target?.validity ? { valid: event.target.validity.valid, valueMissing: event.target.validity.valueMissing } : null }));
    const onClick = event => safeSample('send-click', () => ({ isTrusted: event.isTrusted,
      onSendButton: Boolean(event.target?.closest?.('#shout-send')) }));
    const fieldDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value');
    if (!fieldDescriptor?.get || !fieldDescriptor?.set) return { armed: false, reason: 'native textarea value descriptor was unavailable' };
    const priorField = Object.getOwnPropertyDescriptor(field, 'value');
    const priorRequestSubmit = Object.getOwnPropertyDescriptor(form, 'requestSubmit');
    const nativeRequestSubmit = form.requestSubmit;
    if (typeof nativeRequestSubmit !== 'function') return { armed: false, reason: 'native requestSubmit was unavailable' };
    Object.defineProperty(field, 'value', { configurable: true,
      get() { return fieldDescriptor.get.call(this); },
      set(value) {
        try {
          const before = fieldDescriptor.get.call(this);
          const after = typeof value === 'string' ? value : null;
          const stack = (new Error().stack || '').split('\\n').slice(1, 6)
            .map(line => line.replace(/https?:\\/\\/[^\\s)]+:(\\d+):(\\d+)/g, 'view.inline:$1:$2'));
          safeSample('value-set', () => ({ beforeLength: before.length, afterLength: after?.length ?? null,
            beforeSentinel: before === sentinel, afterSentinel: after === sentinel, stack }));
        } catch { safeSample('value-set-observer-error', () => ({})); }
        return fieldDescriptor.set.call(this, value);
      } });
    Object.defineProperty(form, 'requestSubmit', { configurable: true, writable: true,
      value(...args) {
        safeSample('requestSubmit-call', () => ({ submitterId: args[0]?.id ?? null, submitterConnected: args[0]?.isConnected ?? null }));
        try { return nativeRequestSubmit.apply(this, args); }
        finally { safeSample('requestSubmit-return', () => ({})); }
      } });
    form.addEventListener('submit', onSubmitCapture, true);
    form.addEventListener('submit', onSubmitBubble, false);
    form.addEventListener('invalid', onInvalid, true);
    field.addEventListener('input', onInput, true);
    field.addEventListener('change', onInput, true);
    form.addEventListener('click', onClick, true);
    const capture = { armed: true, armedAt: Date.now(), monotonicArmedAt: performance.now(), events,
      finish() {
        sample('capture-finish');
        form.removeEventListener('submit', onSubmitCapture, true);
        form.removeEventListener('submit', onSubmitBubble, false);
        form.removeEventListener('invalid', onInvalid, true);
        field.removeEventListener('input', onInput, true);
        field.removeEventListener('change', onInput, true);
        form.removeEventListener('click', onClick, true);
        if (priorField) Object.defineProperty(field, 'value', priorField); else delete field.value;
        if (priorRequestSubmit) Object.defineProperty(form, 'requestSubmit', priorRequestSubmit); else delete form.requestSubmit;
        const result = { armed: true, complete: droppedEvents === 0 && observerErrors.length === 0,
          droppedEvents, observerErrors, cap, armedAt: this.armedAt, monotonicArmedAt: this.monotonicArmedAt,
          viewport: { width: innerWidth, height: innerHeight }, events: this.events };
        delete window.__phoneAnswerLifecycleCapture;
        return result;
      } };
    window.__phoneAnswerLifecycleCapture = capture;
    sample('capture-armed');
    return { armed: true, armedAt: capture.armedAt, viewport: capture.viewport, initialValueLength: field.value.length };
  })())`));
}

/** Remove the answer lifecycle observers and restore the native textarea/form properties. */
export async function finishPhoneAnswerLifecycleCapture(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify(window.__phoneAnswerLifecycleCapture?.finish() || null)`, "document.querySelector('#shout-form')"));
}
