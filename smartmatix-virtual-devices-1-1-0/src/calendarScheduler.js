'use strict';

/**
 * ==================
 * Steuert Geräte anhand von Kalenderterminen.
 *
 * Ablauf:
 *   1. Einmal täglich zur eingestellten Uhrzeit wird der Kalender abgerufen und
 *      die Termine des Tages abgelegt. Zusätzlich lässt sich der Abruf von Hand
 *      auslösen.
 *   2. Jede Minute wird geprüft, ob ein Termin beginnt oder endet.
 *   3. Beim Beginn wird der bisherige Wert gesichert und der eingestellte Wert
 *      geschrieben.
 *   4. Beim Ende wird der gesicherte Wert zurückgeschrieben – aber nur, wenn in
 *      der Zwischenzeit niemand von Hand eingegriffen hat.
 *
 * ==================
 */

const fs   = require('fs');
const path = require('path');

const log      = require('./logger');
const calendar = require('./calendar');

const TICK_MS         = 60_000;      // Prüfung auf Terminwechsel
const LOOKAHEAD_HOURS = 36;          // Zeitfenster, das beim Abruf geladen wird
const STATE_VERSION   = 1;

const DATA_DIR   = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'calendar-state.json');

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------

/** Liest den gespeicherten Zustand. */
function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: STATE_VERSION, devices: parsed?.devices ?? {} };
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('calendar-state.json nicht lesbar:', err.message);
    return { version: STATE_VERSION, devices: {} };
  }
}

/** Schreibt den Zustand. */
function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    log.error('calendar-state.json konnte nicht geschrieben werden:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Prüft, ob der Titel eines Termins zum eingestellten Stichwort passt.
 * Ohne Stichwort passt jeder Termin.
 *
 * @param {string} summary
 * @param {string} keyword
 */
function matchesKeyword(summary, keyword) {
  const needle = String(keyword ?? '').trim().toLowerCase();
  if (!needle) return true;
  return String(summary ?? '').toLowerCase().includes(needle);
}

/**
 * Vergleicht zwei Werte so, wie sie in den Features stehen.
 * Zahlen werden mit kleiner Toleranz verglichen, wegen Rundungsfehlern
 */
function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

// ---------------------------------------------------------------------------
//  Verarbeitung
// ---------------------------------------------------------------------------

/**
 * Erstellt den Kalender-Scheduler.
 *
 * @param {object}   options
 * @param {function} options.getDevices     () => alle Geräte
 * @param {function} options.getConfig      (deviceId) => Kalendereinstellungen
 * @param {function} options.readValue      (deviceId, target) => aktueller Wert
 * @param {function} options.writeValue     (deviceId, target, value) => void
 * @param {object}   [options.logger]
 */
function create({ getDevices, getConfig, readValue, writeValue, logger } = {}) {
  for (const [name, fn] of Object.entries({ getDevices, getConfig, readValue, writeValue })) {
    if (typeof fn !== 'function') throw new Error(`[calendarScheduler] ${name} ist erforderlich.`);
  }

  const out = logger ?? log;

  // deviceId > { events: [...], fetchedAt, error }
  const cache = new Map();

  let ticker      = null;
  let lastFetchDay = null;

  // Abruf

  /**
   * Ruft den Kalender eines Geräts ab und legt die Termine des Zeitfensters ab.
   *
   * @param   {string} deviceId
   * @returns {Promise<{ ok: boolean, count?: number, error?: string }>}
   */
  async function refreshDevice(deviceId) {
    const config = getConfig(deviceId);
    if (!config?.enabled || !config.url) {
      cache.delete(deviceId);
      return { ok: false, error: 'Kein Kalender eingerichtet' };
    }

    const from = new Date();
    const to   = new Date(from.getTime() + LOOKAHEAD_HOURS * 3600_000);

    const result = await calendar.loadEvents(config.url, from, to);

    if (!result.ok) {
      cache.set(deviceId, { events: [], fetchedAt: Date.now(), error: result.error });
      out.warn(`Kalender fuer "${deviceId}" nicht abrufbar: ${result.error}`);
      
      return { ok: false, error: result.error };
    }

    const matching = result.events.filter((e) => matchesKeyword(e.summary, config.keyword));

    cache.set(deviceId, { events: matching, fetchedAt: Date.now(), error: null });
    out.info(`Kalender fuer "${deviceId}": ${matching.length} passende(r) Termin(e) `
      + `von ${result.events.length} im Zeitfenster.`);

    return { ok: true, count: matching.length, total: result.events.length };
  }

  /**
   * Ruft die Kalender aller Geräte ab, die den Kalendermodus nutzen.
   * @returns {Promise<number>} Anzahl erfolgreicher Abrufe
   */
  async function refreshAll() {
    let done = 0;
    for (const device of getDevices()) {
      const config = getConfig(device.deviceId);
      if (!config?.enabled || !config.url) continue;
      const result = await refreshDevice(device.deviceId);
      if (result.ok) done++;
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  //  Auswertung
  // ---------------------------------------------------------------------------

  /**
   * Prüft für ein Gerät, ob ein Termin beginnt oder endet, und schaltet.
   * @param {string} deviceId
   * @param {Date}   now
   * @param {object} state – gemeinsamer Zustand, wird verändert
   */
  function applyDevice(deviceId, now, state) {
    const config = getConfig(deviceId);
    if (!config?.enabled || !config.target) return;

    const entry  = cache.get(deviceId);
    const events = entry?.events ?? [];
    const active = events.find((e) => e.start <= now && e.end > now);
    const stored = state.devices[deviceId] ?? null;

    // Ein Termin läuft gerade
    if (active) {
      const key = `${active.uid}|${active.start.getTime()}`;

      // Bereits für diesen Termin geschaltet
      if (stored?.eventKey === key) return;

      // Anderer Termin lief noch: erst dessen Wert zurückspielen
      if (stored) restore(deviceId, stored, state);

      const previous = readValue(deviceId, config.target);
      writeValue(deviceId, config.target, config.value);

      state.devices[deviceId] = {
        eventKey:  key,
        summary:   active.summary,
        target:    config.target,
        previous,
        applied:   config.value,
        startedAt: Date.now(),
        endsAt:    active.end.getTime(),
      };

      out.info(`Kalender: "${active.summary}" gestartet > ${deviceId} `
        + `${config.target} = ${config.value} (vorher ${previous}).`);
      return;
    }

    // Kein Termin läuft, aber es war einer aktiv
    if (stored) restore(deviceId, stored, state);
  }

  /**
   * Spielt den gesicherten Wert zurück, sofern niemand von Hand eingegriffen hat.
   * @param {string} deviceId
   * @param {object} stored
   * @param {object} state
   */
  function restore(deviceId, stored, state) {
    const current = readValue(deviceId, stored.target);

    if (!sameValue(current, stored.applied)) {
      out.info(`Kalender: "${stored.summary}" beendet > ${deviceId} bleibt auf ${current}, `
        + 'weil der Wert zwischenzeitlich geaendert wurde.');
    } else {
      writeValue(deviceId, stored.target, stored.previous);
      out.info(`Kalender: "${stored.summary}" beendet > ${deviceId} `
        + `${stored.target} zurueck auf ${stored.previous}.`);
    }

    delete state.devices[deviceId];
  }

  /**
   * Ein Durchlauf: Abruf falls fällig, dann alle Geräte prüfen.
   * @param {Date} [now]
   */
  async function tick(now = new Date()) {
    const config0 = getDevices()
      .map((d) => getConfig(d.deviceId))
      .find((c) => c?.enabled);

    // Täglicher Abruf zur eingestellten Uhrzeit
    const hour   = config0?.fetchHour ?? 3;
    const dayKey = now.toDateString();

    if (lastFetchDay !== dayKey && now.getHours() >= hour) {
      lastFetchDay = dayKey;
      out.info('Kalender: taeglicher Abruf.');
      await refreshAll();
    }

    const state = loadState();
    const before = JSON.stringify(state.devices);

    for (const device of getDevices()) {
      try {
        applyDevice(device.deviceId, now, state);
      } catch (err) {
        out.error(`Kalender: Fehler bei "${device.deviceId}":`, err.message);
      }
    }

    if (JSON.stringify(state.devices) !== before) saveState(state);
  }

  // ---------------------------------------------------------------------------
  //  Lebenszyklus
  // ---------------------------------------------------------------------------

  /** Startet die minütliche Prüfung. */
  function start() {
    if (ticker) return;

    // Beim Start einmal abrufen, damit sofort korrekt geschaltet wird
    refreshAll().then(() => tick()).catch((err) =>
      out.error('Kalender: Erstabruf fehlgeschlagen:', err.message));

    ticker = setInterval(() => {
      tick().catch((err) => out.error('Kalender: Durchlauf fehlgeschlagen:', err.message));
    }, TICK_MS);

    if (typeof ticker.unref === 'function') ticker.unref();
    out.info('Kalender-Zeitgeber gestartet.');
  }

  /** Beendet die Prüfung. */
  function stop() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
    out.info('Kalender-Zeitgeber beendet.');
  }

  /** Entfernt gespeicherte Zustände von Geräten, die es nicht mehr gibt. */
  function prune(existingDeviceIds = []) {
    const state = loadState();
    const keep  = new Set(existingDeviceIds);
    let removed = 0;

    for (const deviceId of Object.keys(state.devices)) {
      if (keep.has(deviceId)) continue;
      delete state.devices[deviceId];
      cache.delete(deviceId);
      removed++;
    }

    if (removed > 0) saveState(state);
    return removed;
  }

  /** Aktueller Stand für die Oberfläche. */
  function status(deviceId) {
    const entry  = cache.get(deviceId);
    const state  = loadState();
    const active = state.devices[deviceId] ?? null;

    return {
      fetchedAt: entry?.fetchedAt ?? null,
      error:     entry?.error ?? null,
      upcoming:  (entry?.events ?? []).slice(0, 10).map((e) => ({
        summary: e.summary,
        start:   e.start.toISOString(),
        end:     e.end.toISOString(),
        allDay:  e.allDay,
      })),
      active: active
        ? { summary: active.summary, target: active.target,
            applied: active.applied, previous: active.previous }
        : null,
    };
  }

  return { start, stop, tick, refreshDevice, refreshAll, prune, status };
}

module.exports = { create, matchesKeyword, STATE_FILE };
