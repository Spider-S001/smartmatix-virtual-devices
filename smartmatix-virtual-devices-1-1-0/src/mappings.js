'use strict';

/**
 * ==================
 * Speichert und wertet die Zuordnungsregeln der Daten-Endpunkte aus.
 *
 * Eine Regel beschreibt, wie ein extern angelieferter Wert in ein Attribut des
 * Homematic IP Geräts überführt wird:
 *
 *   {
 *     id:            't8f2…',              eindeutige ID der Regel
 *     externalName:  'state',               Name im angelieferten Datensatz
 *     externalValue: 'ON',                  zu treffender Wert (null bei passThrough)
 *     passThrough:   false,                 true = Wert unverändert übernehmen
 *     target:        'switchState.on',      Ziel-Attribut aus dem Feature-Katalog
 *     targetValue:   true,                  zu setzender Wert (null bei passThrough)
 *   }
 *
 * Für die Gegenrichtung beschreibt eine Regel, welche Adresse bei einer
 * Zustandsänderung des Geräts aufgerufen wird:
 *
 *   {
 *     id:            'a1c9…',
 *     source:        'switchState.on',      beobachtetes Attribut
 *     sourceValue:   true,                  auslösender Wert (null bei passThrough)
 *     passThrough:   false,                 true = jeder Wert löst aus
 *     externalValue: 'ON',                  zu sendender Wert (null bei passThrough)
 *     url:           'http://host/api?s={value}',
 *   }
 *
 * Ablage in data/mappings.json, geschlüsselt nach deviceId:
 *
 *   {
 *     "version": 1,
 *     "devices": {
 *       "vardev-light-1": {
 *         "inbound":  [ …Regeln… ],
 *         "outbound": [ …Aufrufe… ],
 *         "calendar": { …Einstellungen… }
 *       }
 *     }
 *   }
 *
 * Der Vergleich externer Werte erfolgt als Text ohne Beachtung von
 * Groß-/Kleinschreibung. Trifft für einen Namen sowohl eine Regel mit festem
 * Wert als auch eine Durchreich-Regel zu, gewinnt die Regel mit festem Wert.
 *
 * ==================
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const log = require('./logger');
const { t } = require('./localization');
const { getTargets, getTarget } = require('../constants/feature_catalog.js');

/**
 * Übersetzt einen Schlüssel und ersetzt Platzhalter der Form {name}.
 * @param {string} lang
 * @param {string} key     Schlüssel aus lang/localization.json
 * @param {object} [vars]  Werte für die Platzhalter
 */
function msg(lang, key, vars = {}) {
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value)),
    t(lang, key));
}

const SCHEMA_VERSION = 1;
const MAX_RULES_PER_DEVICE = 200;

// Platzhalter der Form {value1}, {value2} in der Zieladresse.
// Die angehaengte Zahl verweist auf die Zeile innerhalb desselben Aufrufs.
const PLACEHOLDER_RE = /\{value(\d+)\}/g;

const MAX_CALLS_PER_DEVICE = 50;
const MAX_ROWS_PER_CALL    = 30;

// Persistenz-Verzeichnis
const DATA_DIR  = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'mappings.json');

// ---------------------------------------------------------------------------
//  Persistenz
// ---------------------------------------------------------------------------

/**
 * Ergänzt fehlende Felder eines Geräteeintrags.
 *
 * Fängt unvollständige oder von Hand bearbeitete Dateien ab, damit ein
 * fehlender Abschnitt nicht später zu einem Zugriff auf undefined führt.
 *
 * @param {*} entry
 */
function normalizeEntry(entry) {
  return {
    inbound:  Array.isArray(entry?.inbound)  ? entry.inbound  : [],
    outbound: Array.isArray(entry?.outbound) ? entry.outbound : [],
    calendar: entry?.calendar ?? null,
  };
}

/** Vorgabe für die Kalendereinstellungen eines Geräts. */
function defaultCalendar() {
  return {
    enabled:   false,
    provider:  'ical',
    url:       '',
    keyword:   '',
    target:    '',
    value:     null,
    fetchHour: 3,
  };
}

/**
 * Gibt die Kalendereinstellungen eines Geräts zurück.
 * 
 * @param   {string} deviceId
 * @returns {object}
 */
function getCalendar(deviceId) {
  return load().devices[deviceId]?.calendar ?? defaultCalendar();
}

/**
 * Prüft und speichert die Kalendereinstellungen eines Geräts.
 *
 * @param   {object} config      Einstellungen aus der Oberfläche
 * @param   {string} deviceType  bestimmt die erlaubten Ziele
 * @param   {string} [lang]      Sprache der Fehlermeldungen
 * @returns {{ config: object|null, errors: string[] }}
 */
function validateCalendar(config, deviceType, lang = 'de') {
  const errors  = [];
  const enabled = config?.enabled === true;

  if (!enabled) return { config: { ...defaultCalendar(), ...pickCalendar(config), enabled: false }, errors };

  const url = String(config?.url ?? '').trim();
  
  if (!url) {
    errors.push(msg(lang, 'calendar.error.urlMissing'));
  } else {
    try {
      const parsed = new URL(url.replace(/^webcal:/i, 'https:'));
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push(msg(lang, 'calendar.error.urlScheme'));
      }
    } catch {
      errors.push(msg(lang, 'calendar.error.urlInvalid'));
    }
  }

  const target = getTarget(deviceType, String(config?.target ?? ''));
  
  if (!target) errors.push(msg(lang, 'calendar.error.targetMissing'));

  let value = null;
  
  if (target) {
    const converted = coerce(config?.value, target, lang);
    
    if (!converted.ok) errors.push(converted.reason);
    else value = converted.value;
  }

  const fetchHour = parseInt(config?.fetchHour, 10);
  if (!Number.isFinite(fetchHour) || fetchHour < 0 || fetchHour > 23) {
    errors.push(msg(lang, 'calendar.error.hourRange'));
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: {
      enabled:   true,
      provider:  ['google', 'outlook', 'ical'].includes(config?.provider) ? config.provider : 'ical',
      url,
      keyword:   String(config?.keyword ?? '').trim().slice(0, 100),
      target:    target.id,
      value,
      fetchHour,
    },
    errors: [],
  };
}

/** Übernimmt nur die bekannten Felder aus einer Eingabe. */
function pickCalendar(config) {
  return {
    provider:  config?.provider,
    url:       typeof config?.url === 'string' ? config.url.trim() : '',
    keyword:   typeof config?.keyword === 'string' ? config.keyword.trim() : '',
    target:    typeof config?.target === 'string' ? config.target : '',
    value:     config?.value ?? null,
    fetchHour: Number.isFinite(parseInt(config?.fetchHour, 10)) ? parseInt(config.fetchHour, 10) : 3,
  };
}

/**
 * Schreibt die Kalendereinstellungen des Geräts.
 * 
 * @param   {string} deviceId
 * @param   {object} config
 * @returns {boolean}
 */
function setCalendar(deviceId, config) {
  const data  = load();
  const entry = data.devices[deviceId] ?? { inbound: [], outbound: [], calendar: null };
  entry.calendar = config;

  const empty = entry.inbound.length === 0 && entry.outbound.length === 0
    && (!entry.calendar || entry.calendar.enabled !== true);

  if (empty) delete data.devices[deviceId];
  else       data.devices[deviceId] = entry;

  return save(data);
}

/** Liest die mappings.json. Fehlt oder ist sie defekt, wird leer gestartet. */
function load() {
  try {
    const raw     = fs.readFileSync(FILE_PATH, 'utf8');
    const parsed  = JSON.parse(raw);
    const devices = {};

    for (const [deviceId, entry] of Object.entries(parsed?.devices ?? {})) {
      devices[deviceId] = normalizeEntry(entry);
    }

    if (parsed?.version !== SCHEMA_VERSION) {
      log.warn(`mappings.json meldet Schema ${parsed?.version ?? '?'}, erwartet ${SCHEMA_VERSION}. `
        + 'Der Inhalt wird unveraendert verwendet.');
    }

    return { version: SCHEMA_VERSION, devices };
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('mappings.json nicht lesbar:', err.message);
    
    return { version: SCHEMA_VERSION, devices: {} };
  }
}

/** Schreibt die mappings.json */
function save(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
    
    return true;
  } catch (err) {
    log.error('mappings.json konnte nicht geschrieben werden:', err.message);
    
    return false;
  }
}

/**
 * Gibt die Regeln eines Geräts zurück.
 * 
 * @param   {string} deviceId
 * @returns {Array}
 */
function getRules(deviceId) {
  return load().devices[deviceId]?.inbound ?? [];
}

/**
 * Gibt die ausgehenden Regeln eines Geräts zurück.
 * 
 * @param   {string} deviceId
 * @returns {Array}
 */
function getOutboundCalls(deviceId) {
  return load().devices[deviceId]?.outbound ?? [];
}

/**
 * Ersetzt die Regeln eines Geräts.
 * 
 * @param   {string} deviceId
 * @param   {Array}  rules
 * @returns {boolean}
 */
function setRules(deviceId, rules) {
  return setSection(deviceId, 'inbound', rules);
}

/**
 * Ersetzt die ausgehenden Regeln eines Geräts
 * 
 * @param   {string} deviceId
 * @param   {Array}  rules
 * @returns {boolean}
 */
function setOutboundCalls(deviceId, rules) {
  return setSection(deviceId, 'outbound', rules);
}

/**
 * Schreibt einen der beiden Regelabschnitte eines Geräts.
 * Sind danach beide leer, wird der Geräteeintrag ganz gelöscht.
 *
 * @param   {string} deviceId
 * @param   {'inbound'|'outbound'} section
 * @param   {Array}  rules
 * @returns {boolean}
 */
function setSection(deviceId, section, rules) {
  const data  = load();
  const entry = data.devices[deviceId] ?? { inbound: [], outbound: [], calendar: null };
  entry[section] = rules;

  const empty = entry.inbound.length === 0 && entry.outbound.length === 0
    && (!entry.calendar || entry.calendar.enabled !== true);

  if (empty) delete data.devices[deviceId];
  else       data.devices[deviceId] = entry;

  return save(data);
}

/**
 * Entfernt die Regeln eines Geräts, z.B. wenn es gelöscht wurde.
 * 
 * @param {string} deviceId
 */
function removeRules(deviceId) {
  const data = load();
  if (!(deviceId in data.devices)) return false;
  delete data.devices[deviceId];
  return save(data);
}

/**
 * Entfernt Regeln aller Geräte, die nicht mehr existieren.
 * 
 * @param   {string[]} existingDeviceIds
 * @returns {number} Anzahl der entfernten Geräteeinträge
 */
function pruneRules(existingDeviceIds = []) {
  const data  = load();
  const keep  = new Set(existingDeviceIds);
  let removed = 0;

  for (const deviceId of Object.keys(data.devices)) {
    if (keep.has(deviceId)) continue;
    delete data.devices[deviceId];
    removed++;
  }

  if (removed > 0) {
    save(data);
    log.info(`${removed} verwaiste Zuordnung(en) entfernt.`);
  }
  
  return removed;
}

// ---------------------------------------------------------------------------
//  Wertumwandlung
// ---------------------------------------------------------------------------

/**
 * Wandelt einen beliebigen Eingabewert in den vom Ziel erwarteten Typ um.
 *
 * BOOLEAN: ausschließlich true und 1 gelten als wahr (auch als Text), alles andere als falsch.
 * NUMBER:  Zahl, auf min/max begrenzt, bei Integer gerundet.
 * ENUM:    muss einem der erlaubten Werte entsprechen (Groß-/Kleinschreibung wird ignoriert), sonst Ablehnung.
 *
 * @param   {*}      value   Eingabewert
 * @param   {object} target  Zieldefinition aus dem Feature-Katalog
 * @param   {string} [lang]  Sprache der Rückmeldung
 * @returns {{ ok: true, value: * } | { ok: false, reason: string }}
 */
function coerce(value, target, lang = 'de') {
  if (value === undefined || value === null || value === '') {
    return { ok: false, reason: msg(lang, 'mapping.error.valueMissing') };
  }

  const text = String(value).trim();

  switch (target.valueType) {
    case 'BOOLEAN': {
      const truthy = value === true || value === 1 ||
                     text.toLowerCase() === 'true' || text === '1';
      return { ok: true, value: truthy };
    }

    case 'NUMBER': {
      // Komma als Dezimaltrennzeichen
      const num = Number(text.replace(',', '.'));
      if (!Number.isFinite(num)) {
        return { ok: false, reason: msg(lang, 'mapping.error.notANumber', { value: text }) };
      }

      let result = target.integer ? Math.round(num) : num;
      
      if (target.min !== undefined && result < target.min) result = target.min;
      if (target.max !== undefined && result > target.max) result = target.max;
      
      return { ok: true, value: result };
    }

    case 'ENUM': {
      const match = (target.values ?? []).find((v) => v.toLowerCase() === text.toLowerCase());
      if (!match) {
        return { ok: false, reason: msg(lang, 'mapping.error.notInEnum',
          { value: text, values: (target.values ?? []).join(', ') }) };
      }
      
      return { ok: true, value: match };
    }

    default:
      return { ok: true, value: text };
  }
}

// ---------------------------------------------------------------------------
//  Validierung
// ---------------------------------------------------------------------------

/**
 * Prüft und gleich die Regelliste vor dem Speichern an.
 *
 * @param   {Array}  rules       Regeln aus der Oberfläche
 * @param   {string} deviceType  Gerätetyp, bestimmt die erlaubten Ziele
 * @param   {string} [lang]      Sprache der Fehlermeldungen
 * @returns {{ rules: Array, errors: string[] }}
 */
function validateRules(rules, deviceType, lang = 'de') {
  const errors = [];
  const clean  = [];

  if (!Array.isArray(rules)) {
    return { rules: [], errors: [msg(lang, 'mapping.error.listExpected')] };
  }
  if (rules.length > MAX_RULES_PER_DEVICE) {
    return { rules: [], errors: [msg(lang, 'mapping.error.tooManyRules', { max: MAX_RULES_PER_DEVICE })] };
  }

  const fail = (line, key, vars) =>
    errors.push(`${msg(lang, 'mapping.error.linePrefix', { line })}: ${msg(lang, key, vars)}`);

  rules.forEach((rule, i) => {
    const nr   = i + 1;
    const name = String(rule?.externalName ?? '').trim();

    if (!name) { fail(nr, 'mapping.error.nameMissing'); return; }
    if (name.length > 64) { fail(nr, 'mapping.error.nameTooLong'); return; }

    const target = getTarget(deviceType, String(rule?.target ?? ''));
    if (!target) { fail(nr, 'mapping.error.targetInvalid'); return; }

    const passThrough = rule?.passThrough === true;

    // Durchreichen: beide Wertfelder entfallen
    if (passThrough) {
      clean.push({
        id:            typeof rule?.id === 'string' && rule.id ? rule.id : crypto.randomUUID(),
        externalName:  name,
        externalValue: null,
        passThrough:   true,
        target:        target.id,
        targetValue:   null,
      });
      return;
    }

    const externalValue = String(rule?.externalValue ?? '').trim();
    if (!externalValue) { fail(nr, 'mapping.error.externalMissing'); return; }

    const converted = coerce(rule?.targetValue, target, lang);
    
    if (!converted.ok) {
      errors.push(`${msg(lang, 'mapping.error.linePrefix', { line: nr })}: ${converted.reason}`);
      return;
    }

    clean.push({
      id:            typeof rule?.id === 'string' && rule.id ? rule.id : crypto.randomUUID(),
      externalName:  name,
      externalValue,
      passThrough:   false,
      target:        target.id,
      targetValue:   converted.value,
    });
  });

  return { rules: clean, errors };
}

// ---------------------------------------------------------------------------
//  Auswertung
// ---------------------------------------------------------------------------

/**
 * Wendet die Regeln des Geräts auf einen angelieferten Datensatz an.
 *
 * @param   {Array}  rules       Regeln des Geräts
 * @param   {object} incoming    angelieferte Daten als { name: wert }
 * @param   {string} deviceType  Gerätetyp für die Zielauflösung
 * @param   {string} [lang]      Sprache der Rückmeldungen
 * @returns {{ updates: Array<{featureType,attribute,value,target}>,
 *             applied: Array, ignored: Array }}
 */
function evaluate(rules, incoming, deviceType, lang = 'de') {
  const updates = [];
  const applied = [];
  const ignored = [];

  for (const [name, rawValue] of Object.entries(incoming ?? {})) {
    const candidates = rules.filter(
      (r) => r.externalName.toLowerCase() === String(name).toLowerCase());

    if (candidates.length === 0) {
      ignored.push({ name, reason: msg(lang, 'mapping.ignored.noRule') });
      continue;
    }

    // Feste Werte haben Vorrang vor dem Durchreichen
    const exact = candidates.find(
      (r) => !r.passThrough &&
             String(r.externalValue).toLowerCase() === String(rawValue).trim().toLowerCase());
    const rule = exact ?? candidates.find((r) => r.passThrough);

    if (!rule) {
      ignored.push({ name, value: rawValue, reason: msg(lang, 'mapping.ignored.noMatch') });
      continue;
    }

    const target = getTarget(deviceType, rule.target);
    if (!target) {
      ignored.push({ name, reason: msg(lang, 'mapping.ignored.unknownTarget',
        { target: rule.target, deviceType }) });
      continue;
    }

    // Bei festem Wert steht das Ergebnis in der Regel, sonst umwandeln
    const result = rule.passThrough
      ? coerce(rawValue, target, lang)
      : { ok: true, value: rule.targetValue };
    if (!result.ok) {
      ignored.push({ name, value: rawValue, reason: result.reason });
      continue;
    }

    updates.push({
      featureType: target.featureType,
      attribute:   target.attribute,
      value:       result.value,
      target:      target.id,
    });
    
    applied.push({ name, value: rawValue, target: target.id, result: result.value });
  }

  return { updates, applied, ignored };
}

// ---------------------------------------------------------------------------
//  Ausgehende Aufrufe
// ---------------------------------------------------------------------------

/**
 * Prüft und normalisiert die ausgehenden Aufrufe vor dem Speichern.
 *
 * @param   {Array}  calls       Aufrufe aus der Oberfläche
 * @param   {string} deviceType  Gerätetyp, bestimmt die erlaubten Quellen
 * @param   {string} [lang]      Sprache der Fehlermeldungen
 * @returns {{ calls: Array, errors: string[] }}
 */
function validateOutboundCalls(calls, deviceType, lang = 'de') {
  const errors = [];
  const clean  = [];

  if (!Array.isArray(calls)) {
    return { calls: [], errors: [msg(lang, 'mapping.error.listExpected')] };
  }
  if (calls.length > MAX_CALLS_PER_DEVICE) {
    return { calls: [], errors: [msg(lang, 'mapping.error.tooManyCalls', { max: MAX_CALLS_PER_DEVICE })] };
  }

  calls.forEach((call, ci) => {
    const callNo = ci + 1;
    const at     = (rowNo) => rowNo === undefined
      ? msg(lang, 'mapping.error.callPrefix', { call: callNo })
      : `${msg(lang, 'mapping.error.callPrefix', { call: callNo })}, `
        + msg(lang, 'mapping.error.linePrefix', { line: rowNo });
    const fail = (rowNo, key, vars) => errors.push(`${at(rowNo)}: ${msg(lang, key, vars)}`);

    // Adresse
    const url = String(call?.url ?? '').trim();
    if (!url) { fail(undefined, 'mapping.error.urlMissing'); return; }

    let parsed;
    try { 
      parsed = new URL(url.replace(PLACEHOLDER_RE, 'x')); 
    } catch { 
      fail(undefined, 'mapping.error.urlInvalid'); return; 
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      fail(undefined, 'mapping.error.urlScheme');
      return;
    }

    // Zeilen
    const rows = Array.isArray(call?.rows) ? call.rows : [];
    if (rows.length === 0) { fail(undefined, 'mapping.error.rowsMissing'); return; }
    if (rows.length > MAX_ROWS_PER_CALL) {
      fail(undefined, 'mapping.error.tooManyRows', { max: MAX_ROWS_PER_CALL });
      return;
    }

    // Platzhalter dürfen nur auf vorhandene Zeilen zeigen
    let placeholderError = false;
    for (const match of url.matchAll(PLACEHOLDER_RE)) {
      const index = parseInt(match[1], 10);
      
      if (index >= 1 && index <= rows.length) continue;
      fail(undefined, 'mapping.error.placeholderRange', { placeholder: match[0] });
      placeholderError = true;
    }
    if (placeholderError) return;

    const cleanRows = [];
    let rowError = false;

    rows.forEach((row, ri) => {
      const rowNo  = ri + 1;
      const source = getTarget(deviceType, String(row?.source ?? ''));
      if (!source) { fail(rowNo, 'mapping.error.targetInvalid'); rowError = true; return; }

      const passThrough = row?.passThrough === true;

      if (passThrough) {
        cleanRows.push({
          id:          typeof row?.id === 'string' && row.id ? row.id : crypto.randomUUID(),
          source:      source.id,
          passThrough: true,
          pairs:       [],
        });
        return;
      }

      const pairs = Array.isArray(row?.pairs) ? row.pairs : [];
      if (pairs.length === 0) { fail(rowNo, 'mapping.error.pairsMissing'); rowError = true; return; }

      const cleanPairs = [];
      pairs.forEach((pair, pi) => {
        const converted = coerce(pair?.from, source, lang);
        if (!converted.ok) {
          errors.push(`${at(rowNo)}.${pi + 1}: ${converted.reason}`);
          rowError = true;
          return;
        }
        
        const to = String(pair?.to ?? '').trim();
        
        if (!to) {
          errors.push(`${at(rowNo)}.${pi + 1}: ${msg(lang, 'mapping.error.sentMissing')}`);
          rowError = true;
          return;
        }
        
        cleanPairs.push({ from: converted.value, to });
      });

      if (cleanPairs.length === 0) { rowError = true; return; }

      cleanRows.push({
        id:          typeof row?.id === 'string' && row.id ? row.id : crypto.randomUUID(),
        source:      source.id,
        passThrough: false,
        pairs:       cleanPairs,
      });
    });

    if (rowError) return;

    clean.push({
      id:   typeof call?.id === 'string' && call.id ? call.id : crypto.randomUUID(),
      url,
      rows: cleanRows,
    });
  });

  return { calls: clean, errors };
}

/**
 * Ermittelt, welche Attribute sich zwischen zwei Feature-Listen geändert haben.
 *
 * Nur echte Wertänderungen zählen; identischer Wert erzeugt keinen Eintrag und damit auch keinen ausgehenden Aufruf.
 *
 * @param   {Array} before – Features vor der Änderung
 * @param   {Array} after  – Features nach der Änderung
 * @returns {Array<{ target: string, value: *, previous: * }>}
 */
function diffFeatures(before = [], after = []) {
  const oldMap  = flattenFeatures(before);
  const newMap  = flattenFeatures(after);
  const changes = [];

  for (const [target, value] of newMap) {
    const previous = oldMap.get(target);
    
    if (previous === value) continue;
    changes.push({ target, value, previous });
  }

  return changes;
}

/**
 * Wandelt eine Feature-Liste in eine Zuordnung "featureType.attribute" > Wert.
 * 
 * @param   {Array} features
 * @returns {Map<string, *>}
 */
function flattenFeatures(features = []) {
  const map = new Map();
  for (const feature of features ?? []) {
    if (!feature?.type) continue;
    for (const [attribute, value] of Object.entries(feature)) {
      if (attribute === 'type') continue;
      map.set(`${feature.type}.${attribute}`, value);
    }
  }
  
  return map;
}

/**
 * Bestimmt den Wert, den eine Zeile liefert.
 *
 * Beim Durchreichen ist das der Rohwert des Geräts, sonst der zum aktuellen
 * Wert passende Eintrag aus der Wertetabelle. Passt keiner, bleibt der Wert
 * leer und der Parameter wird dann ohne Inhalt gesendet.
 *
 * @param   {object} row     Zeile eines Aufrufs
 * @param   {Map}    values  aktuelle Werte des Geräts
 * @returns {string}
 */
function valueForRow(row, values) {
  const current = values.get(row.source);
  
  if (current === undefined) return '';
  if (row.passThrough) return String(current);

  const pair = (row.pairs ?? []).find(
    (p) => String(p.from).toLowerCase() === String(current).toLowerCase());

  return pair ? String(pair.to) : '';
}

/**
 * Bestimmt die abzusetzenden Calls für eine Menge von Änderungen.
 *
 * Ein Call wird ausgelöst, sobald sich mindestens eines der in ihm
 * verwendeten Attribute geändert hat. Gesendet werden dann die aktuellen Werte
 * all seiner Zeilen, unabhängig davon, welche sich geändert haben.
 *
 * @param   {Array} calls     ausgehende Aufrufe des Geräts
 * @param   {Array} changes   Ergebnis von diffFeatures()
 * @param   {Array} features  aktueller Zustand des Geräts
 * @returns {Array<{ url: string, callId: string, values: string[], sources: string[] }>}
 */
function evaluateOutbound(calls = [], changes = [], features = []) {
  const changed = new Set(changes.map((c) => c.target));
  const values  = flattenFeatures(features);
  const result  = [];

  for (const call of calls) {
    const rows = call.rows ?? [];
    if (!rows.some((row) => changed.has(row.source))) continue;
    
    result.push(buildCall(call, values));
  }

  return result;
}

/**
 * Baut einen einzelnen Aufruf aus den aktuellen Gerätewerten.
 *
 * @param   {object} call      Aufruf mit Adresse und Zeilen
 * @param   {Map}    values    aktuelle Werte des Geräts
 * @returns {{ url: string, callId: string, values: string[], sources: string[] }}
 */
function buildCall(call, values) {
  const rowValues = (call.rows ?? []).map((row) => valueForRow(row, values));
  
  return {
    callId:  call.id,
    url:     buildUrl(call.url, rowValues),
    values:  rowValues,
    sources: (call.rows ?? []).map((row) => row.source),
  };
}

/**
 * Ersetzt die Platzhalter {value1}, {value2}, usw. in einer Adresse.
 * Die Werte werden URL-kodiert, damit auch Leer- und Sonderzeichen tragen.
 *
 * @param {string}   url
 * @param {string[]} rowValues  Werte in Reihenfolge der Zeilen
 */
function buildUrl(url, rowValues = []) {
  return String(url).replace(PLACEHOLDER_RE, (match, index) => {
    const value = rowValues[parseInt(index, 10) - 1];
    
    return value === undefined ? '' : encodeURIComponent(String(value));
  });
}

module.exports = {
  SCHEMA_VERSION, FILE_PATH,
  PLACEHOLDER_RE,
  getRules, setRules, getOutboundCalls, setOutboundCalls, removeRules, pruneRules,
  validateRules, evaluate, coerce, msg,
  getCalendar, setCalendar, validateCalendar, defaultCalendar,
  validateOutboundCalls, diffFeatures, flattenFeatures,
  evaluateOutbound, buildCall, buildUrl, valueForRow,
  getTargets, getTarget,
};