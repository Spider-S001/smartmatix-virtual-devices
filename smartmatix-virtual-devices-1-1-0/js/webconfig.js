/**
 * webconfig.js
 * ---------------------------------------------------------------------------
 * Verhalten der Endpunkt-Konfigurationsseite.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  const T    = window.SMX?.text ?? {};
  const HL   = window.SMX?.lang ?? 'en';

  // Kurznamen der Fehlermeldungen
  const MSG = {
    invalid: T.errInvalid,
    locked:  T.errLocked,
    network: T.errNetwork,
    unknown: T.errUnknown,
    expired: T.errExpired,
  };

  // Alle uebrigen Texte aus T
  const MAP = T;
  const LBL = {
    name:       T.labelName,
    type:       T.labelType,
    model:      T.labelModel,
    firmware:   T.labelFirmware,
    deviceId:   T.labelDeviceId,
    endpointId: T.labelEndpointId,
  };

  const base    = window.location.pathname.replace(/\/$/, '');
  const hl      = (p) => base + p + '?hl=' + HL;
  const pwEl    = document.getElementById('pw');
  const btnEl   = document.getElementById('btn');
  const stEl    = document.getElementById('status');
  const lockCardEl = document.getElementById('card-lock');
  const panelEls   = document.querySelectorAll('.js-panel');

  /**
   * Wechselt zwischen Anmeldung und angemeldetem Zustand.
   * @param {boolean} loggedIn
   */
  function showPanels(loggedIn) {
    lockCardEl.classList.toggle('hidden', loggedIn);
    panelEls.forEach((el) => el.classList.toggle('hidden', !loggedIn));
  }
  let token = null;

  const err = (m) => { stEl.textContent = m; stEl.classList.remove('hidden'); };

  pwEl.addEventListener('input', () => { btnEl.disabled = !pwEl.value.trim(); });
  pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnEl.disabled) btnEl.click(); });

  btnEl.addEventListener('click', async () => {
    btnEl.disabled = true;
    stEl.classList.add('hidden');
    let res;

    try {
      res = await fetch(hl('/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwEl.value.trim() }),
      });
    } catch {
      err(MSG.network); btnEl.disabled = false; return;
    }

    if (!res.ok) {
      err(res.status === 429 ? MSG.locked : res.status === 404 ? MSG.unknown : MSG.invalid);
      btnEl.disabled = false;
      return;
    }

    token = (await res.json()).token;
    pwEl.value = '';
    await loadDevice();
  });

  document.getElementById('out').addEventListener('click', async () => {
    const usedToken = token;
    token = null;

    showPanels(false);
    clearSensitiveData();
    btnEl.disabled = true;

    // Sitzung auch serverseitig verwerfen, damit der Token nicht bis zum Ablauf der Gueltigkeit weiterverwendet werden kann.
    if (usedToken) {
      try {
        await fetch(hl('/session'), {
          method: 'DELETE',
          headers: { 'X-Endpoint-Token': usedToken },
        });
      } catch { /* Verworfen */ }
    }
  });

  function row(table, key, value) {
    const tr = document.createElement('tr');
    const k  = document.createElement('td'); k.className = 'k'; k.textContent = key;
    const v  = document.createElement('td'); v.className = 'v'; v.textContent = value;
    tr.appendChild(k); tr.appendChild(v); table.appendChild(tr);
  }

  async function loadDevice() {
    let res;

    try {
      res = await fetch(hl('/device'), { headers: { 'X-Endpoint-Token': token } });
    } catch {
      err(MSG.network); btnEl.disabled = false; return;
    }

    if (!res.ok) { 
      err(res.status === 401 ? MSG.expired : MSG.unknown); btnEl.disabled = false; return; 
    }

    const d = await res.json();
    const meta  = document.getElementById('meta');
    const state = document.getElementById('state');
    meta.textContent = ''; state.textContent = '';

    row(meta, LBL.name,       d.friendlyName    || '-');
    row(meta, LBL.type,       d.deviceType      || '-');
    row(meta, LBL.model,      d.modelType       || '-');
    row(meta, LBL.firmware,   d.firmwareVersion || '-');
    row(meta, LBL.deviceId,   d.deviceId        || '-');
    row(meta, LBL.endpointId, d.endpointId      || '-');

    (d.features || []).forEach((f) => {
      Object.keys(f).filter((k) => k !== 'type').forEach((k) => {
        row(state, f.type + '.' + k, String(f[k]));
      });
    });

    showPanels(true);
    await loadMapping();
  }

  // --- Zuordnung ---

  let targets = [];
  let rules   = [];

  const rulesEl = document.getElementById('rules');
  const msgEl   = document.getElementById('mapmsg');

  function msg(text, ok) {
    msgEl.textContent = text;
    msgEl.className = ok ? 'ok' : 'bad';
  }

  async function loadMapping() {
    let res;

    try { 
      res = await fetch(hl('/mapping'), { headers: { 'X-Endpoint-Token': token } }); 
    } catch { 
      msg(MSG.network, false); return; 
    }

    if (!res.ok) { 
      msg(res.status === 401 ? MSG.expired : MSG.unknown, false); return; 
    }

    const data = await res.json();
    targets  = data.targets  || [];
    rules    = data.rules    || [];
    outRules = data.outbound || [];
    calendar  = data.calendar || null;
    calStatus = data.calendarStatus || null;
    dataUrlCache = data.dataUrl;
    renderUrls(data.dataUrl);
    render();
    renderOut();
    renderCalendar();
    showMode(calendar?.enabled ? 'calendar' : 'endpoint');
  }

  function renderUrls(dataUrl) {
    const el = document.getElementById('urls');
    el.textContent = '';
    
    if (!dataUrl) return;

    const label = document.createElement('label');
    label.setAttribute('for', 'dataurl');
    label.textContent = MAP.deliveryAddress;

    const row = document.createElement('div');
    row.className = 'copyrow';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'dataurl';
    input.readOnly = true;
    input.value = dataUrl;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('click', () => input.select());

    const btn = document.createElement('button');
    btn.className = 'ghost copy';
    btn.textContent = MAP.deliveryCopy;
    btn.addEventListener('click', async () => {
      input.select();
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(dataUrl);
        else document.execCommand('copy');
        btn.textContent = MAP.deliveryCopied;
        setTimeout(() => { btn.textContent = MAP.deliveryCopy; }, 1500);
      } catch { /* Zwischenablage nicht verfuegbar: Text ist markiert */ }
    });

    row.appendChild(input); row.appendChild(btn);

    const hint = document.createElement('p');
    hint.className = 'hint hint-spaced';
    hint.textContent = MAP.deliveryHint;

    // Neues Passwort erzeugen; die Endpunkt-Kennung bleibt dabei erhalten
    const rotateRow = document.createElement('div');
    rotateRow.className = 'btnrow';
    const rotate = document.createElement('button');
    rotate.className = 'ghost';
    rotate.textContent = MAP.deliveryRotate;
    rotate.addEventListener('click', () => rotatePassword(rotate));
    rotateRow.appendChild(rotate);

    const rotMsg = document.createElement('div');
    rotMsg.id = 'rotmsg';

    el.appendChild(label); el.appendChild(row); el.appendChild(hint);
    el.appendChild(rotateRow); el.appendChild(rotMsg);
  }

  /**
   * Fordert ein neues Endpunkt-Passwort an.
   * Die Adresse wird anschliessend neu aufgebaut, weil sie das Passwort enthaelt.
   *
   * @param {HTMLButtonElement} btn – ausloesender Knopf waehrend Anforderung gesperrt
   */
  async function rotatePassword(btn) {
    if (!window.confirm(MAP.deliveryRotateAsk)) return;

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = MAP.deliveryRotating;

    let res;
    try {
      res = await fetch(hl('/rotate-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: '{}',
      });
    } catch {
      btn.disabled = false; btn.textContent = label;
      msg(MSG.network, false); return;
    }

    btn.disabled = false; btn.textContent = label;

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      msg((data.errors || [MSG.unknown]).join(' \u2022 '), false); // Aufzaehlungszeichen ergaenzen
      return;
    }

    dataUrlCache = data.dataUrl || dataUrlCache;
    renderUrls(dataUrlCache);

    const note = document.getElementById('rotmsg');
    if (note) { 
      note.textContent = MAP.deliveryRotated; note.className = 'ok'; 
    }
  }

  // Baut das Wert-Eingabefeld passend zum gewaehlten Ziel.
  function valueInput(target, value) {
    if (!target) { 
      const i = document.createElement('input'); i.type = 'text'; return i; 
    }

    if (target.valueType === 'BOOLEAN' || target.valueType === 'ENUM') {
      const sel  = document.createElement('select');
      const opts = target.valueType === 'BOOLEAN' ? ['true', 'false'] : (target.values || []);
      opts.forEach(o => {
        const op = document.createElement('option');
        op.value = o; op.textContent = o;
        if (String(value) === o) op.selected = true;
        sel.appendChild(op);
      });
      return sel;
    }

    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = target.integer ? '1' : 'any';
    
    if (target.min !== undefined) inp.min = target.min;
    
    if (target.max !== undefined) inp.max = target.max;
    
    inp.placeholder = MAP.mapValue +
      (target.min !== undefined || target.max !== undefined
        ? ' (' + (target.min ?? '') + '…' + (target.max ?? '') + ')' : '');
    
    if (value !== null && value !== undefined) inp.value = value;
    
    return inp;
  }

  // Fuegt weitere Regel-Zeilen hinzu
  function render() {
    rulesEl.textContent = '';

    if (targets.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = MAP.mapNoTargets;
      rulesEl.appendChild(p);
      document.getElementById('add').disabled = true;
      document.getElementById('savemap').disabled = true;
      
      return;
    }

    if (rules.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = MAP.mapEmpty;
      rulesEl.appendChild(p);
    }

    rules.forEach((rule, i) => rulesEl.appendChild(ruleRow(rule, i)));
  }

  /*
  * Neue Regel-Zeilen generieren
  *
  * @param {rule} rule – Regelobjekt, aus dem die Zeile generiert werden soll
  * @param {int} index – Stelle der Regel
  */
  function ruleRow(rule, index) {
    const target = targets.find(t => t.id === rule.target) || targets[0];
    rule.target = target.id;

    const box  = document.createElement('div'); box.className = 'rule';
    const grid = document.createElement('div'); grid.className = 'grid';

    // linke Seite: Name + Wert
    const left = document.createElement('div');
    const name = document.createElement('input');
    name.type = 'text'; name.placeholder = MAP.mapName; name.value = rule.externalName || '';
    rule.externalName = name.value;
    name.addEventListener('input', () => { rule.externalName = name.value; });
    left.appendChild(name);

    const extVal = document.createElement('input');
    extVal.type = 'text'; extVal.placeholder = MAP.mapValue;
    extVal.value = rule.externalValue ?? '';
    rule.externalValue = extVal.value;
    extVal.addEventListener('input', () => { rule.externalValue = extVal.value; });
    left.appendChild(extVal);

    const arrow = document.createElement('div');
    arrow.className = 'arrow'; arrow.textContent = '→';

    // rechte Seite: Attribut + Wert
    const right = document.createElement('div');
    const sel   = document.createElement('select');
    targets.forEach(t => {
      const op = document.createElement('option');
      op.value = t.id;
      op.textContent = t.id + (t.required ? ' – ' + MAP.mapRequired : '');
      if (t.id === rule.target) op.selected = true;
      sel.appendChild(op);
    });
    right.appendChild(sel);

    // Wichtig: den Wert sofort uebernehmen, nicht erst beim Aendern.
    function bindValue(el) {
      rule.targetValue = el.value;
      const sync = () => { rule.targetValue = el.value; };
      el.addEventListener('change', sync);
      el.addEventListener('input',  sync);
      return el;
    }

    let valEl = bindValue(valueInput(target, rule.targetValue));
    right.appendChild(valEl);

    sel.addEventListener('change', () => {
      rule.target = sel.value;
      const t2 = targets.find(t => t.id === rule.target);
      const fresh = bindValue(valueInput(t2, null));
      right.replaceChild(fresh, valEl);
      valEl = fresh;
      applyPass();
    });

    grid.appendChild(left); grid.appendChild(arrow); grid.appendChild(right);

    // Fusszeile: Durchreichen + Loeschen
    const foot = document.createElement('div'); foot.className = 'foot';
    const lab  = document.createElement('label'); lab.className = 'cb';
    const cb   = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = rule.passThrough === true;
    const cbText = document.createElement('span'); cbText.textContent = MAP.mapPass;
    lab.appendChild(cb); lab.appendChild(cbText);

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕ ' + MAP.mapRemove;
    del.addEventListener('click', () => { rules.splice(index, 1); render(); renderUrls(dataUrlCache); });

    foot.appendChild(lab); foot.appendChild(del);

    function applyPass() {
      const on = cb.checked;
      rule.passThrough = on;
      extVal.classList.toggle('hidden', on);
      valEl.classList.toggle('hidden', on);
    }
    cb.addEventListener('change', applyPass);
    applyPass();

    box.appendChild(grid); box.appendChild(foot);
    return box;
  }

  let dataUrlCache = null;

  // --- Ausgehende Aufrufe -------------------------------------------------

  let outRules = [];
  const outEl    = document.getElementById('outrules');

  /** Ersetzt Platzhalter der Form {name} in einem uebersetzten Text. */
  function fill(text, vars) {
    return Object.keys(vars).reduce(
      (out, k) => out.split('{' + k + '}').join(String(vars[k])), text);
  }

  const outMsgEl = document.getElementById('outmsg');

  function outMsg(text, ok) {
    outMsgEl.textContent = text;
    outMsgEl.className = ok ? 'ok' : 'bad';
  }

  function renderOut() {
    outEl.textContent = '';

    if (targets.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = MAP.mapNoTargets;
      outEl.appendChild(p);
      document.getElementById('outadd').disabled = true;
      document.getElementById('outsave').disabled = true;
      document.getElementById('outtest').disabled = true;
      return;
    }

    if (outRules.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = MAP.outNoCalls;
      outEl.appendChild(p);
    }

    outRules.forEach((call, i) => outEl.appendChild(callBox(call, i)));
  }

  /** Baut einen kompletten Aufruf mit Adresse und Zeilen. */
  function callBox(call, index) {
    if (!Array.isArray(call.rows)) call.rows = [];

    const box  = document.createElement('div'); box.className = 'call';
    const head = document.createElement('div'); head.className = 'head';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = fill(MAP.outCall, { n: index + 1 });

    const delCall = document.createElement('button');
    delCall.className = 'xbtn';
    delCall.textContent = '✕ ' + MAP.outRemoveCall;
    delCall.addEventListener('click', () => { outRules.splice(index, 1); renderOut(); });

    head.appendChild(title); head.appendChild(delCall);

    // Adresse
    const urlWrap = document.createElement('div'); urlWrap.className = 'urlfield';
    const urlLab  = document.createElement('label'); urlLab.textContent = MAP.outUrl;
    const urlIn   = document.createElement('input');
    urlIn.type = 'text'; urlIn.placeholder = MAP.outUrlHintNum; urlIn.value = call.url || '';
    call.url = urlIn.value;
    urlIn.addEventListener('input', () => { call.url = urlIn.value; });
    urlWrap.appendChild(urlLab); urlWrap.appendChild(urlIn);

    box.appendChild(head); box.appendChild(urlWrap);

    if (call.rows.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = MAP.outNoRows;
      box.appendChild(p);
    }

    call.rows.forEach((row, ri) => box.appendChild(rowBox(call, row, ri)));

    const addRow = document.createElement('button');
    addRow.className = 'addbtn';
    addRow.classList.add('addbtn-spaced');
    addRow.textContent = '+ ' + MAP.outAddRow;
    addRow.addEventListener('click', () => {
      call.rows.push({ source: targets[0]?.id, passThrough: false, pairs: [{ from: null, to: '' }] });
      renderOut();
    });
    box.appendChild(addRow);

    return box;
  }

  /** Baut eine Zeile: Attribut, Wertepaare, Durchreichen. */
  function rowBox(call, row, rowIndex) {
    const target = targets.find(t => t.id === row.source) || targets[0];
    row.source = target.id;
    if (!Array.isArray(row.pairs)) row.pairs = [];

    const box = document.createElement('div'); box.className = 'row';

    // Kopf: Platzhalternummer + Attributauswahl + Entfernen
    const rhead = document.createElement('div'); rhead.className = 'rhead';

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '{value' + (rowIndex + 1) + '}';

    const sel = document.createElement('select');
    targets.forEach(t => {
      const op = document.createElement('option');
      op.value = t.id;
      op.textContent = t.id + (t.required ? ' – ' + MAP.mapRequired : '');
      if (t.id === row.source) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', () => {
      row.source = sel.value;
      row.pairs = [{ from: null, to: '' }];
      renderOut();
    });

    const delRow = document.createElement('button');
    delRow.className = 'xbtn';
    delRow.textContent = '✕';
    delRow.title = MAP.outRemoveRow;
    delRow.addEventListener('click', () => { call.rows.splice(rowIndex, 1); renderOut(); });

    rhead.appendChild(num); rhead.appendChild(sel); rhead.appendChild(delRow);
    box.appendChild(rhead);

    // Wertepaare
    const pairsWrap = document.createElement('div');

    function renderPairs() {
      pairsWrap.textContent = '';
      if (row.passThrough) return;

      row.pairs.forEach((pair, pi) => {
        const line = document.createElement('div'); line.className = 'pair';

        const from = valueInput(target, pair.from);
        pair.from = from.value;
        const syncFrom = () => { pair.from = from.value; };
        from.addEventListener('change', syncFrom);
        from.addEventListener('input',  syncFrom);

        const ar = document.createElement('span');
        ar.className = 'ar'; ar.textContent = '→';

        const to = document.createElement('input');
        to.type = 'text'; to.placeholder = MAP.outSent; to.value = pair.to ?? '';
        pair.to = to.value;
        to.addEventListener('input', () => { pair.to = to.value; });

        const del = document.createElement('button');
        del.className = 'xbtn'; del.textContent = '✕';
        del.addEventListener('click', () => {
          row.pairs.splice(pi, 1);
          if (row.pairs.length === 0) row.pairs.push({ from: null, to: '' });
          renderPairs();
        });

        line.appendChild(from); line.appendChild(ar); line.appendChild(to); line.appendChild(del);
        pairsWrap.appendChild(line);
      });

      const addPair = document.createElement('button');
      addPair.className = 'addbtn';
      addPair.textContent = '+ ' + MAP.outAddPair;
      addPair.addEventListener('click', () => { row.pairs.push({ from: null, to: '' }); renderPairs(); });
      pairsWrap.appendChild(addPair);
    }

    box.appendChild(pairsWrap);

    // Fusszeile: Durchreichen
    const foot = document.createElement('div'); foot.className = 'foot';
    const lab  = document.createElement('label'); lab.className = 'cb';
    const cb   = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = row.passThrough === true;
    const cbText = document.createElement('span'); cbText.textContent = MAP.outPass;
    lab.appendChild(cb); lab.appendChild(cbText);
    foot.appendChild(lab);

    cb.addEventListener('change', () => {
      row.passThrough = cb.checked;
      if (!row.passThrough && row.pairs.length === 0) row.pairs.push({ from: null, to: '' });
      renderPairs();
    });

    box.appendChild(foot);
    renderPairs();
    return box;
  }


  // --- Betriebsart und Kalender ---

  let calendar = null;
  let calStatus = null;

  const paneEndpoint = document.getElementById('pane-endpoint');
  const paneCalendar = document.getElementById('pane-calendar');
  const btnEndpoint  = document.getElementById('mode-endpoint');
  const btnCalendar  = document.getElementById('mode-calendar');
  const calMsgEl     = document.getElementById('calmsg');

  function calMsg(text, ok) {
    calMsgEl.textContent = text;
    calMsgEl.className = ok ? 'ok' : 'bad';
  }

  // Zeigt eine der beiden Betriebsarten an.
  function showMode(mode) {
    const cal = mode === 'calendar';
    paneCalendar.classList.toggle('hidden', !cal);
    paneEndpoint.classList.toggle('hidden', cal);
    btnCalendar.classList.toggle('active', cal);
    btnEndpoint.classList.toggle('active', !cal);
    if (calendar) calendar.enabled = cal;
  }

  btnEndpoint.addEventListener('click', () => showMode('endpoint'));
  btnCalendar.addEventListener('click', () => showMode('calendar'));

  const provEl   = document.getElementById('calprov');
  const urlEl    = document.getElementById('calurl');
  const keyEl    = document.getElementById('calkey');
  const targetEl = document.getElementById('caltarget');
  const valWrap  = document.getElementById('calvalwrap');
  const hourEl   = document.getElementById('calhour');
  const helpEl   = document.getElementById('calhelp');
  const evEl     = document.getElementById('calevents');

  let calValueEl = null;

  // Anleitung passend zum gewaehlten Anbieter.
  function renderHelp() {
    const map = { google: T.calHelpGoogle, outlook: T.calHelpOutlook, ical: T.calHelpIcal };
    helpEl.textContent = (map[provEl.value] || '') + ' — ' + T.calHelp;
  }

  // Baut das Wertfeld passend zum gewaehlten Zielattribut.
  function renderCalValue() {
    const target = targets.find(t => t.id === targetEl.value);
    valWrap.textContent = '';
    calValueEl = valueInput(target, calendar?.value);
    calValueEl.id = 'calvalwrap-input';
    valWrap.appendChild(calValueEl);
  }

  // Fuellt die Kalendermaske aus den geladenen Einstellungen.
  function renderCalendar() {
    if (!calendar) return;

    provEl.value = calendar.provider || 'ical';
    urlEl.value  = calendar.url || '';
    keyEl.value  = calendar.keyword || '';
    hourEl.value = calendar.fetchHour ?? 3;

    targetEl.textContent = '';
    targets.forEach(t => {
      const op = document.createElement('option');
      op.value = t.id;
      op.textContent = t.id + (t.required ? ' \u2013 ' + MAP.mapRequired : '');
      if (t.id === calendar.target) op.selected = true;
      targetEl.appendChild(op);
    });

    renderHelp();
    renderCalValue();
    renderEvents();
  }

  // Zeigt die naechsten Termine sowie den laufenden an.
  function renderEvents() {
    evEl.textContent = '';

    if (!calStatus || calStatus.fetchedAt === null) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = T.calNeverFetched;
      evEl.appendChild(p);
      return;
    }

    if (calStatus.error) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = calStatus.error;
      evEl.appendChild(p);
      return;
    }

    const list = calStatus.upcoming || [];
    if (list.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty'; p.textContent = T.calNone;
      evEl.appendChild(p);
      return;
    }

    const now = Date.now();
    list.forEach((e) => {
      const start = new Date(e.start);
      const end   = new Date(e.end);
      const row   = document.createElement('div');
      row.className = 'ev' + (start.getTime() <= now && end.getTime() > now ? ' now' : '');

      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = e.allDay
        ? start.toLocaleDateString(HL)
        : start.toLocaleString(HL, { day: '2-digit', month: '2-digit',
            hour: '2-digit', minute: '2-digit' })
          + '\u2013' + end.toLocaleTimeString(HL, { hour: '2-digit', minute: '2-digit' });

      const what = document.createElement('span');
      what.className = 'what'; what.textContent = e.summary;

      row.appendChild(when); row.appendChild(what);
      evEl.appendChild(row);
    });
  }

  provEl.addEventListener('change', renderHelp);
  targetEl.addEventListener('change', () => { if (calendar) calendar.value = null; renderCalValue(); });

  // Liest die Maske in ein Einstellungsobjekt.
  function collectCalendar() {
    return {
      enabled:   !paneCalendar.classList.contains('hidden'),
      provider:  provEl.value,
      url:       urlEl.value.trim(),
      keyword:   keyEl.value.trim(),
      target:    targetEl.value,
      value:     calValueEl ? calValueEl.value : null,
      fetchHour: parseInt(hourEl.value, 10),
    };
  }

  document.getElementById('calsave').addEventListener('click', async () => {
    calMsgEl.className = '';
    let res;
    try {
      res = await fetch(hl('/mapping'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: JSON.stringify({ calendar: collectCalendar() }),
      });
    } catch { calMsg(MSG.network, false); return; }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      calMsg((data.errors || [MSG.unknown]).join(' \u2022 '), false);
      return;
    }
    calendar = data.calendar || calendar;
    calMsg(T.calSaved, true);
  });

  document.getElementById('calfetch').addEventListener('click', async () => {
    const btn = document.getElementById('calfetch');
    calMsgEl.className = '';

    // Erst speichern, damit die eingetragene Adresse verwendet wird
    try {
      const save = await fetch(hl('/mapping'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: JSON.stringify({ calendar: collectCalendar() }),
      });
      const saved = await save.json().catch(() => ({}));
      if (!save.ok || saved.ok === false) {
        calMsg((saved.errors || [MSG.unknown]).join(' \u2022 '), false);
        return;
      }
      calendar = saved.calendar || calendar;
    } catch { calMsg(MSG.network, false); return; }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = T.calFetching;

    let res;
    try {
      res = await fetch(hl('/calendar-fetch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: '{}',
      });
    } catch {
      btn.disabled = false; btn.textContent = label;
      calMsg(MSG.network, false); return;
    }

    btn.disabled = false; btn.textContent = label;

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      calMsg((data.errors || [MSG.unknown]).join(' \u2022 '), false);
      return;
    }

    calStatus = data.status || calStatus;
    renderEvents();
    calMsg(fill(T.calFetched, { count: data.count ?? 0 }), true);
  });

  document.getElementById('outadd').addEventListener('click', () => {
    outRules.push({
      url:  '',
      rows: [{ source: targets[0]?.id, passThrough: false, pairs: [{ from: null, to: '' }] }],
    });
    renderOut();
  });

  const outResEl = document.getElementById('outresults');

  document.getElementById('outtest').addEventListener('click', async () => {
    const btn = document.getElementById('outtest');
    outMsgEl.className = '';
    outResEl.textContent = '';

    if (outRules.length === 0) { outMsg(MAP.outTestEmpty, false); return; }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = MAP.outTestRun;

    let res;

    try {
      res = await fetch(hl('/outbound-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: JSON.stringify({ outbound: outRules }),
      });
    } catch {
      btn.disabled = false; btn.textContent = label;
      outMsg(MSG.network, false); return;
    }

    btn.disabled = false; btn.textContent = label;

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      outMsg((data.errors || [MSG.unknown]).join(' • '), false);
      return;
    }

    const results = data.results || [];
    const okCount = results.filter(r => r.ok).length;

    results.forEach((r) => {
      const row  = document.createElement('div');
      row.className = 'res ' + (r.ok ? 'good' : 'bad');

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = r.ok ? '✓' : '✕';

      const url = document.createElement('span');
      url.className = 'u'; url.textContent = r.url;

      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = r.ok
        ? fill(MAP.outTestOk,   { status: r.status })
        : fill(MAP.outTestFail, { error: r.error || ('HTTP ' + r.status) });

      row.appendChild(mark); row.appendChild(url); row.appendChild(st);
      outResEl.appendChild(row);
    });

    outMsg(fill(MAP.outTestResult, { ok: okCount, total: results.length }),
           okCount === results.length);
  });

  document.getElementById('outsave').addEventListener('click', async () => {
    outMsgEl.className = '';
    let res;
    
    try {
      res = await fetch(hl('/mapping'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: JSON.stringify({ outbound: outRules }),
      });
    } catch { 
      outMsg(MSG.network, false); return; 
    }

    const data = await res.json().catch(() => ({}));
    
    if (!res.ok || data.ok === false) {
      outMsg((data.errors || [MSG.unknown]).join(' • '), false);
      return;
    }
    
    outRules = data.outbound || outRules;
    renderOut();
    outResEl.textContent = '';
    outMsg(MAP.outSaved, true);
  });

  document.getElementById('add').addEventListener('click', () => {
    rules.push({ externalName: '', externalValue: '', passThrough: false,
                 target: targets[0]?.id, targetValue: null });
    render();
  });

  document.getElementById('savemap').addEventListener('click', async () => {
    msgEl.className = '';
    let res;
    
    try {
      res = await fetch(hl('/mapping'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Endpoint-Token': token },
        body: JSON.stringify({ rules }),
      });
    } catch { 
      msg(MSG.network, false); return; 
    }

    const data = await res.json().catch(() => ({}));
    
    if (!res.ok || data.ok === false) {
      msg((data.errors || [MSG.unknown]).join(' • '), false);
      return;
    }
    
    rules = data.rules || rules;
    render(); renderUrls(dataUrlCache);
    msg(MAP.mapSaved, true);
  });

  /**
   * Entfernt alle abgerufenen Daten aus der Seite.
   */
  function clearSensitiveData() {
    // Zwischengespeicherte Daten verwerfen
    targets      = [];
    rules        = [];
    outRules     = [];
    calendar     = null;
    calStatus    = null;
    dataUrlCache = null;

    // Erzeugte Inhalte entfernen
    ['meta', 'state', 'rules', 'urls', 'outrules', 'outresults', 'calevents',
     'caltarget', 'calvalwrap'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    });

    // Eingabefelder zuruecksetzen
    ['pw', 'calurl', 'calkey', 'calhour'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    calValueEl = null;
    helpEl.textContent = '';
    provEl.selectedIndex = 0;

    // Meldungen ausblenden
    ['mapmsg', 'outmsg', 'calmsg'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; el.className = ''; }
    });
    stEl.textContent = '';
    stEl.classList.add('hidden');
  }

})();