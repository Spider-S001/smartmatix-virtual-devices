'use strict';

/**
 * ==================
 * Ruft einen Kalender im iCalendar-Format (RFC 5545) ab und ermittelt daraus
 * die Termine eines Tages.
 *
 * Unterstützter Funktionsumfang:
 *   • VEVENT mit DTSTART und DTEND bzw. DURATION
 *   • ganztägige Termine (VALUE=DATE)
 *   • Zeitzonen über TZID sowie UTC-Zeiten mit Z-Endung
 *   • Wiederholungen: FREQ=DAILY, WEEKLY, MONTHLY, YEARLY
 *     mit INTERVAL, BYDAY, BYMONTHDAY, COUNT und UNTIL
 *   • ausgenommene Einzeltermine über EXDATE
 *   • geänderte Einzeltermine über RECURRENCE-ID
 *   • entfaltete Zeilen (Fortsetzung mit Leerzeichen) und maskierte Zeichen
 * ==================
 */

const http  = require('http');
const https = require('https');

const log      = require('./logger');
const netguard = require('./netguard');

const FETCH_TIMEOUT_MS = 20_000;
const MAX_FEED_BYTES   = 8 * 1024 * 1024;
const MAX_REDIRECTS    = 5;
const MAX_OCCURRENCES  = 1000;  // Sicherheitsgrenze beim Entfalten einer Regel

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---------------------------------------------------------------------------
//  Abruf
// ---------------------------------------------------------------------------

/**
 * Lädt einen ICS-Feed.
 *
 * webcal:// wird auf https:// abgebildet, weil viele Anbieter diese Form
 * anbieten, sie aber kein eigenes Protokoll ist.
 *
 * @param   {string} url
 * @param   {number} [redirects] interner Zähler für Weiterleitungen
 * @param   {string} [fromScope] Einstufung der ersten Adresse der Kette
 * @returns {Promise<{ ok: boolean, body?: string, status?: number, error?: string }>}
 */
async function fetchFeed(url, redirects = 0, fromScope = null) {
  const normalized = String(url).replace(/^webcal:/i, 'https:');

  const verdict = await netguard.checkTarget(normalized, fromScope);
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  return new Promise((resolve) => {
    const target = new URL(normalized);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      method:  'GET',
      headers: { 'User-Agent': 'SmartMatix-Virtual-Devices', Accept: 'text/calendar, */*' },
      // Zertifikate pruefen
      ...(target.protocol === 'https:' ? netguard.tlsOptions(verdict.scope) : {}),
    }, (res) => {
      // Weiterleitungen folgen
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();

        if (redirects >= MAX_REDIRECTS) {
          return resolve({ ok: false, error: 'Zu viele Weiterleitungen' });
        }

        const next = new URL(res.headers.location, target).toString();
        return resolve(fetchFeed(next, redirects + 1, fromScope ?? verdict.scope));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
      }

      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);

        if (size > MAX_FEED_BYTES) {
          req.destroy();
          return resolve({ ok: false, error: 'Kalender zu gross' });
        }

        body += chunk;
      });
      res.on('end', () => resolve({ ok: true, body, status: res.statusCode }));
    });

    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, error: `Zeitlimit nach ${FETCH_TIMEOUT_MS} ms` });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Auswertung des Formats
// ---------------------------------------------------------------------------

/**
 * Setzt umbrochene Zeilen wieder zusammen.
 *
 * @param   {string} text
 * @returns {string[]}
 */
function unfoldLines(text) {
  const raw   = String(text).split(/\r\n|\n|\r/);
  const lines = [];

  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  return lines;
}

/**
 * Zerlegt eine Zeile in Name, Parameter und Wert.
 * Beispiel: DTSTART;TZID=Europe/Berlin:20260803T060000
 *
 * @param   {string} line
 * @returns {{ name: string, params: object, value: string } | null}
 */
function parseLine(line) {
  const colon = findValueSeparator(line);
  if (colon === -1) return null;

  const head  = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');

  const params = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }

  return { name: parts[0].toUpperCase(), params, value };
}

/**
 * Findet den Doppelpunkt, der Kopf und Wert trennt.
 * Doppelpunkte innerhalb von Anführungszeichen zählen nicht.
 *
 * @param {string} line
 */
function findValueSeparator(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) return i;
  }
  return -1;
}

/** Löst die Maskierungen in einem Textwert auf (\n, \, ; und ,). */
function unescapeText(value) {
  return String(value)
    .replace(/\\n/gi, '\n')
    .replace(/\\([\\;,])/g, '$1');
}

/**
 * Wandelt einen Datums- oder Zeitwert in ein Date um.
 *
 * Drei Formen kommen vor:
 *   20260803          ganztägig (VALUE=DATE)
 *   20260803T060000Z  UTC
 *   20260803T060000   Ortszeit, ggf. mit TZID
 *
 * Ortszeiten ohne Z werden in der Zeitzone des Containers ausgelegt
 *
 * @param   {string} value
 * @param   {object} [params]
 * @returns {{ date: Date, allDay: boolean } | null}
 */
function parseDateValue(value, params = {}) {
  const text = String(value).trim();
  const dateOnly = text.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { date: new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0), allDay: true };
  }

  const dateTime = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!dateTime) return null;

  const [, y, mo, d, h, mi, s, utc] = dateTime;
  const nums = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];

  if (utc) return { date: new Date(Date.UTC(...nums)), allDay: false };

  // TZID wird nicht in eine echte Zeitzonenrechnung übersetzt; die lokale Zeit
  // des Containers entspricht in aller Regel der des Kalenders.
  if (params.TZID) log.debug(`Kalender: TZID ${params.TZID} wird als Ortszeit ausgelegt.`);
  return { date: new Date(...nums), allDay: false };
}

/**
 * Liest alle VEVENT-Einträge aus einem ICS-Text.
 *
 * @param   {string} text
 * @returns {Array<object>} Rohtermine mit start, end, summary, rrule, exdates …
 */
function parseEvents(text) {
  const lines  = unfoldLines(text);
  const events = [];

  let current = null;
  let depth   = 0;

  for (const line of lines) {
    const parsed = parseLine(line);

    if (!parsed) continue;

    const { name, params, value } = parsed;

    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && depth === 0) {
        current = { summary: '', exdates: [], rrule: null, recurrenceId: null };
        depth = 1;
      } else if (depth > 0) {
        // Verschachtelte Komponente (z.B. VALARM) überspringen
        depth++;
      }
      continue;
    }

    if (name === 'END') {
      if (value.toUpperCase() === 'VEVENT' && depth === 1) {
        if (current?.start) events.push(current);
        current = null;
        depth = 0;
      } else if (depth > 1) {
        depth--;
      }

      continue;
    }

    // Nur die oberste Ebene eines VEVENT auswerten
    if (!current || depth !== 1) continue;

    switch (name) {
      case 'UID':     current.uid     = value; break;
      case 'SUMMARY': current.summary = unescapeText(value); break;

      case 'DTSTART': {
        const parsedDate = parseDateValue(value, params);
        if (parsedDate) {
          current.start  = parsedDate.date;
          current.allDay = parsedDate.allDay;
        }
        break;
      }

      case 'DTEND': {
        const parsedDate = parseDateValue(value, params);
        if (parsedDate) current.end = parsedDate.date;
        break;
      }

      case 'DURATION':
        current.duration = parseDuration(value);
        break;

      case 'RRULE':
        current.rrule = parseRRule(value);
        break;

      case 'EXDATE': {
        for (const part of value.split(',')) {
          const parsedDate = parseDateValue(part, params);
          if (parsedDate) current.exdates.push(parsedDate.date.getTime());
        }
        break;
      }

      case 'RECURRENCE-ID': {
        const parsedDate = parseDateValue(value, params);
        if (parsedDate) current.recurrenceId = parsedDate.date.getTime();
        break;
      }

      default: break;
    }
  }

  return events;
}

/**
 * Wandelt eine Dauer nach ISO 8601 in Millisekunden um, z.B. PT1H30M.
 * @param {string} value
 */
function parseDuration(value) {
  const m = String(value).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;

  const [, sign, w, d, h, mi, s] = m;
  const ms = (Number(w || 0) * 7 * 86400 + Number(d || 0) * 86400
           + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0)) * 1000;

  return sign === '-' ? -ms : ms;
}

/**
 * Zerlegt eine Wiederholungsregel.
 * @param   {string} value z.B. FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T000000Z
 * @returns {object|null}
 */
function parseRRule(value) {
  const rule = {};

  for (const part of String(value).split(';')) {
    const eq = part.indexOf('=');

    if (eq === -1) continue;
    rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }

  if (!rule.FREQ) return null;

  return {
    freq:       rule.FREQ.toUpperCase(),
    interval:   Math.max(1, parseInt(rule.INTERVAL ?? '1', 10) || 1),
    count:      rule.COUNT ? parseInt(rule.COUNT, 10) : null,
    until:      rule.UNTIL ? parseDateValue(rule.UNTIL)?.date ?? null : null,
    byDay:      rule.BYDAY ? rule.BYDAY.split(',').map((d) => d.trim().toUpperCase()) : null,
    byMonthDay: rule.BYMONTHDAY
      ? rule.BYMONTHDAY.split(',').map((d) => parseInt(d, 10)).filter(Number.isFinite)
      : null,
    byMonth:    rule.BYMONTH
      ? rule.BYMONTH.split(',').map((d) => parseInt(d, 10)).filter(Number.isFinite)
      : null,
    // Nicht unterstützte Angaben merken, damit sie protokolliert werden können
    unsupported: ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY'].filter((k) => k in rule),
  };
}

// ---------------------------------------------------------------------------
//  Termine eines Zeitraums ermitteln
// ---------------------------------------------------------------------------

/** Datum ohne Uhrzeit, als neues Date. */
function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Verschiebt ein Datum um n Tage und behält die Uhrzeit. */
function addDays(date, n) {
  const out = new Date(date);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Prüft, ob ein Zeitpunkt zur Wiederholungsregel passt.
 * @param {Date}   candidate  zu prüfender Zeitpunkt
 * @param {Date}   start      erster Termin der Reihe
 * @param {object} rule
 */
function matchesRule(candidate, start, rule) {
  if (rule.byMonth && !rule.byMonth.includes(candidate.getMonth() + 1)) return false;

  switch (rule.freq) {
    case 'DAILY': {
      const days = Math.round((startOfDay(candidate) - startOfDay(start)) / 86400000);
      return days >= 0 && days % rule.interval === 0;
    }

    case 'WEEKLY': {
      const weekOf = (d) => {
        const s = startOfDay(d);
        s.setDate(s.getDate() - s.getDay());
        return s.getTime();
      };

      const weeks = Math.round((weekOf(candidate) - weekOf(start)) / (7 * 86400000));
      
      if (weeks < 0 || weeks % rule.interval !== 0) return false;

      const wanted = rule.byDay ?? [WEEKDAYS[start.getDay()]];
      return wanted.includes(WEEKDAYS[candidate.getDay()]);
    }

    case 'MONTHLY': {
      const months = (candidate.getFullYear() - start.getFullYear()) * 12
                   + (candidate.getMonth() - start.getMonth());
      if (months < 0 || months % rule.interval !== 0) return false;

      if (rule.byMonthDay) return rule.byMonthDay.includes(candidate.getDate());
      
      if (rule.byDay) {
        // Form "2TU" – n-ter Wochentag im Monat
        return rule.byDay.some((entry) => {
          const m = entry.match(/^(-?\d+)?([A-Z]{2})$/);
          
          if (!m) return false;
          
          const [, nth, day] = m;
          
          if (WEEKDAYS[candidate.getDay()] !== day) return false;
          if (!nth) return true;
          const week = Math.floor((candidate.getDate() - 1) / 7) + 1;
          
          return Number(nth) === week;
        });
      }
      return candidate.getDate() === start.getDate();
    }

    case 'YEARLY': {
      const years = candidate.getFullYear() - start.getFullYear();
      
      if (years < 0 || years % rule.interval !== 0) return false;
      
      return candidate.getMonth() === start.getMonth()
          && candidate.getDate() === start.getDate();
    }

    default:
      return false;
  }
}

/**
 * Ermittelt alle Termine, die einen Zeitraum berühren.
 *
 * @param   {Array}  events  Rohtermine aus parseEvents()
 * @param   {Date}   from    Beginn des Zeitraums
 * @param   {Date}   to      Ende des Zeitraums
 * @returns {Array<{ uid: string, summary: string, start: Date, end: Date, allDay: boolean }>}
 */
function expandEvents(events, from, to) {
  const result = [];

  // Geänderte Einzeltermine einer Reihe getrennt behandeln
  const overrides = new Map();
  for (const event of events) {
    if (event.recurrenceId === null) continue;
    overrides.set(`${event.uid}|${event.recurrenceId}`, event);
  }

  for (const event of events) {
    if (event.recurrenceId !== null) continue;
    if (!event.start) continue;

    const durationMs = event.end
      ? event.end - event.start
      : (event.duration ?? (event.allDay ? 86400000 : 3600000));

    // Einzeltermin
    if (!event.rrule) {
      pushIfInRange(result, event, event.start, durationMs, from, to);
      continue;
    }

    if (event.rrule.unsupported.length > 0) {
      log.warn(`Kalender: "${event.summary}" nutzt ${event.rrule.unsupported.join(', ')} `
        + '– diese Angaben werden nicht ausgewertet.');
    }

    // Wiederholung: jeden Tag im Zeitraum prüfen
    let emitted = 0;
    const scanFrom = startOfDay(new Date(Math.max(from.getTime() - durationMs, event.start.getTime())));

    for (let day = scanFrom; day <= to && emitted < MAX_OCCURRENCES; day = addDays(day, 1)) {
      const candidate = new Date(day);
      
      candidate.setHours(event.start.getHours(), event.start.getMinutes(),
                         event.start.getSeconds(), 0);

      if (candidate < event.start) continue;
      if (event.rrule.until && candidate > event.rrule.until) break;
      if (!matchesRule(candidate, event.start, event.rrule)) continue;
      if (event.exdates.includes(candidate.getTime())) continue;

      emitted++;

      // Einzeltermin geaendert
      const override = overrides.get(`${event.uid}|${candidate.getTime()}`);
      if (override) {
        const overrideDuration = override.end
          ? override.end - override.start
          : (override.duration ?? durationMs);
        pushIfInRange(result, override, override.start, overrideDuration, from, to);
        continue;
      }

      pushIfInRange(result, event, candidate, durationMs, from, to);
    }

    // COUNT begrenzt die Gesamtzahl der Wiederholungen
    if (event.rrule.count) applyCountLimit(result, event, from, to);
  }

  result.sort((a, b) => a.start - b.start);
  return result;
}

/** Übernimmt einen Termin, wenn er den Zeitraum ueberschneidet. */
function pushIfInRange(result, event, start, durationMs, from, to) {
  const end = new Date(start.getTime() + durationMs);
  
  if (end <= from || start >= to) return;

  result.push({
    uid:     event.uid ?? '',
    summary: event.summary ?? '',
    start:   new Date(start),
    end,
    allDay:  event.allDay === true,
  });
}

/**
 * Entfernt Vorkommen, die jenseits von COUNT liegen.
 * Gezählt wird ab dem ersten Termin der Reihe.
 */
function applyCountLimit(result, event, from, to) {
  const rule = event.rrule;
  let counted = 0;
  let limit   = null;

  for (let day = startOfDay(event.start); day <= to && counted <= rule.count; day = addDays(day, 1)) {
    const candidate = new Date(day);
    candidate.setHours(event.start.getHours(), event.start.getMinutes(),
                       event.start.getSeconds(), 0);
    
    if (candidate < event.start) continue;
    if (!matchesRule(candidate, event.start, rule)) continue;
    if (event.exdates.includes(candidate.getTime())) continue;

    counted++;
    if (counted === rule.count) { limit = candidate.getTime(); break; }
  }

  if (limit === null) return;

  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].uid === event.uid && result[i].start.getTime() > limit) result.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Lädt einen Kalender und liefert die Termine eines Zeitraums.
 *
 * @param   {string} url
 * @param   {Date}   from
 * @param   {Date}   to
 * @returns {Promise<{ ok: boolean, events?: Array, total?: number, error?: string }>}
 */
async function loadEvents(url, from, to) {
  const response = await fetchFeed(url);
  if (!response.ok) return { ok: false, error: response.error };

  if (!/BEGIN:VCALENDAR/i.test(response.body)) {
    return { ok: false, error: 'Antwort ist kein Kalender im iCalendar-Format' };
  }

  try {
    const raw    = parseEvents(response.body);
    const events = expandEvents(raw, from, to);
    return { ok: true, events, total: raw.length };
  } catch (err) {
    return { ok: false, error: `Kalender nicht lesbar: ${err.message}` };
  }
}

module.exports = {
  loadEvents, fetchFeed,
  parseEvents, expandEvents, parseRRule, parseDateValue, parseDuration,
  unfoldLines, parseLine, unescapeText,
};
