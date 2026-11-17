/* Rig views runtime, hosted variant (spike, 12 Nov 2026).
   Same API as runtime/rig-view.js. What changes when Rig hosts the view in a sandboxed frame:
   - Data arrives from the host as a message. The page has no network, so it never fetches.
   - rig.act posts to the host only. The host knows which view and which person; the page does not say.
   - rig.me is the person looking at the view, given by the host.
   - rig.card(step) draws Rig's action card: the proposed action, alternatives, and a line to add context.
   Opened outside Rig (no parent frame), it falls back to polling data.json like the original. */
(function () {
  const POLL_MS = 4000;
  const hosted = window.parent && window.parent !== window;
  let lastText = null;
  let lastData = null;
  let renderFn = null;
  let root = null;
  let me = null;
  // The members of the space, given by the host: [{ id, name }].
  let people = [];
  const state = {};

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  class Raw {
    constructor(html) { this.html = String(html); }
    toString() { return this.html; }
  }
  const raw = (html) => (html instanceof Raw ? html : new Raw(html));
  const part = (v) => {
    if (v === null || v === undefined || v === false) return '';
    if (Array.isArray(v)) return v.map(part).join('');
    return v instanceof Raw ? v.html : esc(v);
  };
  const h = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + part(vals[i - 1]) + s));

  const FACES = ['--f1', '--f2', '--f3', '--f4', '--f5', '--f6', '--f7'];
  const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  const av = (name) =>
    raw(`<span class="rv-av" title="${esc(name || 'No owner')}" style="background:var(${name ? FACES[hash(name) % FACES.length] : '--f7'})">${esc(name ? initials(name) : '–')}</span>`);

  const ago = (iso, now = Date.now()) => {
    const m = Math.round((now - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
  };
  const time = (iso) => {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${hm}`;
  };

  // One toast at a time, at the foot of the view. A choice shows as its own words while the
  // session takes it ("Post now · on it"), then as done or as what went wrong.
  let toastEl = null, toastTimer = 0, pendingAct = null;
  function toast(text, { sub = '', tone = '', ms = 2400 } = {}) {
    clearTimeout(toastTimer);
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.className = 'rv-toast' + (tone ? ' ' + tone : '');
    const mark = tone === 'busy' ? '<span class="rv-toast-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
      : tone === 'ok' ? '<span class="rv-toast-mark" aria-hidden="true">✓</span>'
      : tone === 'bad' ? '<span class="rv-toast-mark" aria-hidden="true">!</span>' : '';
    toastEl.innerHTML = mark + `<span class="rv-toast-text">${esc(text)}</span>` + (sub ? `<span class="rv-toast-sub">${esc(sub)}</span>` : '');
    const el = toastEl;
    toastTimer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { if (el.classList.contains('out')) { el.remove(); if (toastEl === el) toastEl = null; } }, 180);
    }, ms);
  }

  // label: the words on what the person pressed, when a press started it. item: the title of
  // the card it was pressed on. Both go to Rig for the line the Room shows above the reply.
  function act(intent, payload = {}, label = '', item = '') {
    const short = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const msg = { type: 'rig:act', intent, payload, label: short(label, 60), item: short(item, 100) };
    // Sent with the gesture that made it: Rig starts a turn only for a real press, never for a page
    // that calls this by itself (on load, on a timer).
    if (hosted) {
      try { window.parent.postMessage(msg, { targetOrigin: '*', includeUserActivation: true }); }
      catch { window.parent.postMessage(msg, '*'); }
    }
    window.dispatchEvent(new CustomEvent('rig:act', { detail: msg }));
    const said = (label || '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Your choice';
    pendingAct = hosted ? said : null;
    toast(said, hosted ? { sub: 'on it', tone: 'busy', ms: 6000 } : { sub: 'sent' });
  }

  // What Rig did or thinks, set apart: the mark, then the words. One per view, at the top.
  const MARK = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M256 256H128L0 128h128zM256 128H128L0 0h128z"/></svg>';
  const note = (text) => (text ? h`<div class="rv-note" data-key="rig-note"><span class="rv-mark">${raw(MARK)}</span><div>${text}</div></div>` : '');

  // Small parts, so a page does not hand-write their classes. tone: '' | ok | warn | bad | accent | violet | quiet (pill only).
  const TONES = /^(ok|warn|bad|accent|violet|quiet)$/;
  const tone = (t) => (TONES.test(t || '') ? ' ' + t : '');
  const pill = (text, t, dot) => h`<span class="rv-pill${tone(t)}">${dot ? raw('<i class="rv-dot"></i>') : ''}${text}</span>`;
  const tag = (text, t) => h`<span class="rv-tag${tone(t)}">${text}</span>`;
  // Priority as colored text: prio('High'). Draws nothing for an empty value.
  const prio = (p) => (p ? h`<span class="rv-prio-${String(p).toLowerCase().replace(/[^a-z]/g, '') || 'none'}">${p}</span>` : '');
  // Nothing to show: a bold line saying what, then a line saying when it will fill.
  const empty = (title, text) => h`<div class="rv-empty">${title ? h`<b>${title}</b>` : ''}${text || ''}</div>`;

  // A step someone just acted on: its controls stop, and it says where the choice went. It stays that
  // way until the view's data changes (the session rewrote it) or the host says the turn is over.
  function hold(step) {
    step.classList.add('rv-step-held');
    step.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    const line = document.createElement('div');
    line.className = 'rv-step-sent';
    line.setAttribute('role', 'status');
    line.textContent = 'Sent to your session';
    step.appendChild(line);
  }

  // The action card. One proposed action, alternatives beside it, and a line the person can add.
  // step: { id, label?, title?, body?, why, actions: [{ act, label, primary }], note: 'placeholder' | false }
  // title is a short name for the step; body is the thing itself when it is text to read (a draft, a message).
  // label is a small mono line above both, for what kind of step it is ("Draft · #bug-bash").
  const card = (step) => h`
    <article class="rv-step" data-key="step-${step.id}" data-step="${step.id}">
      ${step.label ? h`<div class="rv-step-label">${step.label}</div>` : ''}
      ${step.title ? h`<div class="rv-step-title">${step.title}</div>` : ''}
      ${step.body ? h`<div class="rv-step-body">${step.body}</div>` : ''}
      ${step.why ? h`<div class="rv-step-why">${step.why}</div>` : ''}
      ${step.note === false ? '' : h`<input class="rv-step-note" type="text" aria-label="Add context" placeholder="${step.note || 'Add a line of context (optional)'}">`}
      <div class="rv-step-actions">${(step.actions || []).map((a) =>
        h`<button class="rv-btn ${a.primary ? 'primary' : ''}" data-act="${a.act}" data-id="${step.id}">${a.label}</button>`)}</div>
    </article>`;

  const snapshot = () => {
    const m = new Map();
    // Last round's marks are not content: without this a card that flashed once flashes on every later update.
    root.querySelectorAll('.rv-fresh').forEach((el) => el.classList.remove('rv-fresh'));
    root.querySelectorAll('[data-key]').forEach((el) => m.set(el.dataset.key, el.outerHTML));
    return m;
  };

  function paint(ctx) {
    const before = ctx.changed ? snapshot() : null;
    const out = renderFn(lastData, ctx);
    if (out !== undefined && out !== null) root.innerHTML = String(out);
    if (!before) return;
    root.querySelectorAll('[data-key]').forEach((el) => {
      if (before.get(el.dataset.key) !== el.outerHTML) el.classList.add('rv-fresh');
    });
  }

  function take(text, force) {
    if (text === lastText && !force) return;
    const changed = lastText !== null && text !== lastText;
    lastText = text;
    lastData = JSON.parse(text);
    paint({ changed, state, me });
  }

  async function tick(first) {
    try {
      const res = await fetch('data.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('data.json ' + res.status);
      take(await res.text());
    } catch (e) {
      if (first) root.innerHTML = `<div class="rv-empty">This view couldn't read its data (${esc(e.message)}). Ask Rig to refresh it.</div>`;
    }
  }

  function mount(render, el) {
    renderFn = render;
    root = el || document.getElementById('root') || document.body;
    if (hosted) {
      // Only the frame that embeds this page may feed it.
      window.addEventListener('message', (e) => {
        if (e.source !== window.parent || !e.data) return;
        // The turn an action started is over. If the data did not change, the step is offered again.
        if (e.data.type === 'rig:act-result') {
          const said = pendingAct;
          pendingAct = null;
          if (!e.data.ok) toast(e.data.message || "That didn't reach your session", { tone: 'bad', ms: 5000 });
          else if (said) toast(said, { sub: 'done', tone: 'ok', ms: 2000 });
          if (lastData) paint({ changed: false, state, me });
          return;
        }
        if (e.data.type !== 'rig:data') return;
        const who = e.data.viewer || null;
        const roster = Array.isArray(e.data.people) ? e.data.people : [];
        const newViewer = JSON.stringify(who) !== JSON.stringify(me) || JSON.stringify(roster) !== JSON.stringify(people);
        me = who;
        people = roster;
        try { take(e.data.text, newViewer); } catch (err) {
          root.innerHTML = `<div class="rv-empty">This view couldn't read its data (${esc(err.message)}). Ask Rig to refresh it.</div>`;
        }
      });
      window.parent.postMessage({ type: 'rig:ready' }, '*');
    } else {
      tick(true);
      setInterval(tick, POLL_MS);
    }
    // A link opens in the person's own browser. The frame itself can go nowhere, so the click is
    // handed to Rig, with the gesture that made it, and Rig opens web addresses only.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      if (!hosted || !/^https?:\/\//i.test(a.href)) return;
      try { window.parent.postMessage({ type: 'rig:open', url: a.href }, { targetOrigin: '*', includeUserActivation: true }); }
      catch { window.parent.postMessage({ type: 'rig:open', url: a.href }, '*'); }
    });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act: intent, ...rest } = b.dataset;
      const step = b.closest('[data-step]');
      const note = step && step.querySelector('.rv-step-note');
      if (note && note.value.trim()) rest.note = note.value.trim();
      const title = step && step.querySelector('.rv-step-title');
      act(intent, rest, b.textContent, title ? title.textContent : '');
      if (step && hosted) hold(step);
    });
  }

  const rerender = () => lastData && paint({ changed: false, state, me });

  window.rig = { mount, rerender, state, act, card, note, h, raw, esc, av, ago, time, pill, tag, prio, empty,
    // who(id): the member's name for a relay id, or null when they are not (or no longer) in the space.
    who: (id) => { const p = people.find((x) => x.id === id); return p ? p.name : null; },
    get data() { return lastData; }, get me() { return me; }, get people() { return people; } };
})();
