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
const MAX_LEAD_HOURS  = 24;          // Obergrenze des Vorlaufs, erweitert das Fenster
const STATE_VERSION   = 1;

const DATA_DIR   = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'calendar-state.json');

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------

/** Liest den gespeicherten Zustand. */
// Zwischenspeicher wie in mappings.js: der Zeitgeber liest den Zustand jede
// Minute, ohne dass sich in aller Regel etwas geändert hat.
let stateCache   = null;
let stateMtimeMs = 0;

function loadState() {
  try {
    const mtimeMs = fs.statSync(STATE_FILE).mtimeMs;
    if (stateCache && mtimeMs === stateMtimeMs) return stateCache;

    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    stateCache   = { version: STATE_VERSION, devices: parsed?.devices ?? {} };
    stateMtimeMs = mtimeMs;
    return stateCache;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('calendar-state.json nicht lesbar:', err.message);
    stateCache = null;
    stateMtimeMs = 0;
    return { version: STATE_VERSION, devices: {} };
  }
}

/** Schreibt den Zustand. */
function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    stateCache   = state;
    stateMtimeMs = fs.statSync(STATE_FILE).mtimeMs;
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
  // Mehrere Stichworte durch Komma getrennt; es genuegt, wenn eines passt.
  const needles = String(keyword ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  if (needles.length === 0) return true;

  const text = String(summary ?? '').toLowerCase();
  return needles.some((n) => text.includes(n));
}

/**
 * Vor- und Nachlauf eines Termins in Millisekunden.
 * @param   {object} config – Kalendereinstellungen eines Geräts
 * @returns {{ lead: number, trail: number }}
 */
function offsets(config) {
  const lead = config?.leadEnabled
    ? ((config.leadHours ?? 0) * 60 + (config.leadMinutes ?? 0)) * 60_000
    : 0;
  const trail = config?.trailEnabled
    ? ((config.trailHours ?? 0) * 60 + (config.trailMinutes ?? 0)) * 60_000
    : 0;
  return { lead, trail };
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
  let lastFetchAt  = null;

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

    // Das Fenster beginnt um den moeglichen Vorlauf frueher, damit ein Termin,
    // dessen Vorlauf bereits laeuft, beim Abruf noch gefunden wird.
    const from = new Date(Date.now() - MAX_LEAD_HOURS * 3600_000);
    const to   = new Date(Date.now() + LOOKAHEAD_HOURS * 3600_000);

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
    // Mehrere Geräte teilen sich häufig einen Kalender. Jede Adresse wird
    // deshalb nur einmal geladen und das Ergebnis an alle Geräte verteilt, die sie verwenden.
    const byUrl = new Map();

    for (const device of getDevices()) {
      const config = getConfig(device.deviceId);
      if (!config?.enabled || !config.url) continue;
      if (!byUrl.has(config.url)) byUrl.set(config.url, []);
      byUrl.get(config.url).push(device.deviceId);
    }

    const from = new Date(Date.now() - MAX_LEAD_HOURS * 3600_000);
    const to   = new Date(Date.now() + LOOKAHEAD_HOURS * 3600_000);
    let done = 0;

    for (const [url, deviceIds] of byUrl) {
      const result = await calendar.loadEvents(url, from, to);

      if (!result.ok) {
        for (const deviceId of deviceIds) {
          cache.set(deviceId, { events: [], fetchedAt: Date.now(), error: result.error });
        }
        out.warn(`Kalender nicht abrufbar (${deviceIds.length} Geraet(e)): ${result.error}`);
        continue;
      }

      for (const deviceId of deviceIds) {
        const config   = getConfig(deviceId);
        const matching = result.events.filter((e) => matchesKeyword(e.summary, config.keyword));
        cache.set(deviceId, { events: matching, fetchedAt: Date.now(), error: null });
        done++;
      }

      out.info(`Kalender abgerufen fuer ${deviceIds.length} Geraet(e): `
        + `${result.events.length} Termin(e) im Zeitfenster.`);
    }

    if (byUrl.size > 0) {
      out.info(`${byUrl.size} Kalenderadresse(n) fuer ${done} Geraet(e) geladen.`);
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
    const stored = state.devices[deviceId] ?? null;

    // Vor- und Nachlauf verschieben die wirksamen Grenzen eines Termins
    const { lead, trail } = offsets(config);
    const active = events.find((e) =>
      e.start.getTime() - lead <= now.getTime() && e.end.getTime() + trail > now.getTime());

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
        endsAt:    active.end.getTime() + trail,
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

    const hour  = config0?.fetchHour ?? 3;
    const every = Math.min(Math.max(parseInt(config0?.fetchEveryHours, 10) || 24, 1), 24);

    if (every >= 24) {
      // Einmal taeglich zur eingestellten Stunde
      const dayKey = now.toDateString();
      if (lastFetchDay !== dayKey && now.getHours() >= hour) {
        lastFetchDay = dayKey;
        out.info('Kalender: taeglicher Abruf.');
        await refreshAll();
      }
    } else if (lastFetchAt === null || now.getTime() - lastFetchAt >= every * 3600_000) {
      // Im eingestellten Abstand
      lastFetchAt = now.getTime();
      out.info(`Kalender: Abruf im ${every}-Stunden-Takt.`);
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
    lastFetchDay = new Date().toDateString();
    lastFetchAt  = Date.now();
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
