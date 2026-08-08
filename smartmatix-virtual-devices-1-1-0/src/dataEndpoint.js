'use strict';

/**
 * ==================
 * Verwaltet die Daten-Endpunkte der virtuellen Geräte.
 *
 * Jedes Gerät kann in den Plugin-Einstellungen einen eigenen Endpunkt erhalten.
 * Dabei werden zwei Zugangsdaten dauerhaft im Geräteobjekt (devices.json)
 * abgelegt:
 *
 *   endpointId       UUID v4 – dient als Adresse des Endpunkts
 *   endpointPassword Zufallspasswort – muss auf der Zielseite eingegeben werden
 *
 * Der Webserver läuft nur, solange mindestens ein Gerät einen aktiven Endpunkt
 * besitzt, und lauscht auf einem festen Port (Standard 8745). Dieser Port muss
 * im Dockerfile per EXPOSE freigegeben sein.
 *
 * Ablauf der Authentifizierung (analog zur Backup-Wiederherstellung):
 *   1. GET  /<endpointId>            > Seite mit Passwortfeld
 *   2. POST /<endpointId>/session    > Passwortprüfung, liefert Session-Token
 *   3. GET  /<endpointId>/device     > Gerätedaten (Header X-Endpoint-Token)
 *
 * ==================
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { t } = require('./localization');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------

const DEFAULT_PORT   = 8745;
const SESSION_TTL_MS = 30 * 60 * 1000;  // Gültigkeit eines Session-Tokens
const MAX_BODY_BYTES = 64 * 1024;       // Obergrenze für Request-Bodies

// Brute-Force-Schutz
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS          = 5 * 60 * 1000;

// HCU-TLS-Zertifikat: das selbstsignierte Zertifikat der HCU liegt im Container unter /etc/ssl/.
const TLS_CERT_PATHS = [
  { key: '/etc/ssl/private/ssl-cert-snakeoil.key', cert: '/etc/ssl/certs/ssl-cert-snakeoil.pem' },
  { key: '/etc/ssl/private/server.key',            cert: '/etc/ssl/certs/server.crt'            },
  { key: '/etc/ssl/server.key',                    cert: '/etc/ssl/server.crt'                  },
];

function getTlsCredentials() {
  for (const { key, cert } of TLS_CERT_PATHS) {
    try {
      return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
    } catch { /* Pfad nicht vorhanden, weiter */ }
  }

  return null; // Kein Zertifikat gefunden, HTTP als Fallback
}

/**
 * Kurzname > Uebersetzungsschluessel in lang/localization.json.
 */
const PAGE_KEYS = {
  'pageTitle': 'endpoint.page.title',
  'lockHint': 'endpoint.lock.hint',
  'passwordLabel': 'endpoint.lock.password.label',
  'passwordHint': 'endpoint.lock.password.hint',
  'submitBtn': 'endpoint.lock.submit',
  'errInvalid': 'endpoint.error.invalid',
  'errLocked': 'endpoint.error.locked',
  'errNetwork': 'endpoint.error.network',
  'errUnknown': 'endpoint.error.unknown',
  'errExpired': 'endpoint.error.expired',
  'deviceHeadline': 'endpoint.device.headline',
  'labelName': 'endpoint.device.name',
  'labelType': 'endpoint.device.type',
  'labelModel': 'endpoint.device.model',
  'labelFirmware': 'endpoint.device.firmware',
  'labelDeviceId': 'endpoint.device.deviceId',
  'labelEndpointId': 'endpoint.device.endpointId',
  'stateHeadline': 'endpoint.state.headline',
  'mapHeadline': 'endpoint.map.headline',
  'mapIntro': 'endpoint.map.intro',
  'mapExternal': 'endpoint.map.external',
  'mapInternal': 'endpoint.map.internal',
  'mapName': 'endpoint.map.name',
  'mapValue': 'endpoint.map.value',
  'mapAttribute': 'endpoint.map.attribute',
  'mapPass': 'endpoint.map.passthrough',
  'mapAdd': 'endpoint.map.add',
  'mapSave': 'endpoint.map.save',
  'mapRemove': 'endpoint.map.remove',
  'mapEmpty': 'endpoint.map.empty',
  'mapNoTargets': 'endpoint.map.noTargets',
  'mapSaved': 'endpoint.map.saved',
  'mapRequired': 'endpoint.map.required',
  'urlHeadline': 'endpoint.delivery.headline',
  'deliveryRotate': 'endpoint.delivery.rotate',
  'deliveryRotating': 'endpoint.delivery.rotating',
  'deliveryRotated': 'endpoint.delivery.rotated',
  'deliveryRotateAsk': 'endpoint.delivery.rotateAsk',
  'urlIntro': 'endpoint.delivery.intro',
  'logout': 'endpoint.logout',
  'outHeadline': 'endpoint.out.headline',
  'outIntro': 'endpoint.out.intro',
  'outSource': 'endpoint.out.source',
  'outExternal': 'endpoint.out.external',
  'outUrl': 'endpoint.out.url',
  'outUrlHint': 'endpoint.out.urlHint',
  'outPass': 'endpoint.out.pass',
  'outAdd': 'endpoint.out.add',
  'outSave': 'endpoint.out.save',
  'outEmpty': 'endpoint.out.empty',
  'outSaved': 'endpoint.out.saved',
  'outCall': 'endpoint.out.call',
  'outAddCall': 'endpoint.out.addCall',
  'outRemoveCall': 'endpoint.out.removeCall',
  'outAddRow': 'endpoint.out.addRow',
  'outRemoveRow': 'endpoint.out.removeRow',
  'outAddPair': 'endpoint.out.addPair',
  'outNoRows': 'endpoint.out.noRows',
  'outNoCalls': 'endpoint.out.noCalls',
  'outSent': 'endpoint.out.sent',
  'outUrlHintNum': 'endpoint.out.urlHintNum',
  'calHeadline': 'endpoint.cal.headline',
  'calIntro': 'endpoint.cal.intro',
  'calProvider': 'endpoint.cal.provider',
  'calProviderGoogle': 'endpoint.cal.providerGoogle',
  'calProviderOutlook': 'endpoint.cal.providerOutlook',
  'calProviderIcal': 'endpoint.cal.providerIcal',
  'calUrl': 'endpoint.cal.url',
  'calUrlHint': 'endpoint.cal.urlHint',
  'calKeyword': 'endpoint.cal.keyword',
  'calKeywordHint': 'endpoint.cal.keywordHint',
  'calTarget': 'endpoint.cal.target',
  'calValue': 'endpoint.cal.value',
  'calHour': 'endpoint.cal.hour',
  'calHourHint': 'endpoint.cal.hourHint',
  'calSave': 'endpoint.cal.save',
  'calFetchNow': 'endpoint.cal.fetchNow',
  'calFetching': 'endpoint.cal.fetching',
  'calSaved': 'endpoint.cal.saved',
  'calFetched': 'endpoint.cal.fetched',
  'calUpcoming': 'endpoint.cal.upcoming',
  'calNone': 'endpoint.cal.none',
  'calActive': 'endpoint.cal.active',
  'calNeverFetched': 'endpoint.cal.neverFetched',
  'calHelp': 'endpoint.cal.help',
  'calHelpGoogle': 'endpoint.cal.helpGoogle',
  'calHelpOutlook': 'endpoint.cal.helpOutlook',
  'calHelpIcal': 'endpoint.cal.helpIcal',
  'modeLabel': 'settings.mode.label',
  'modeEndpoint': 'settings.mode.endpoint',
  'modeCalendar': 'settings.mode.calendar',
  'outTestAll': 'endpoint.out.testAll',
  'outTestRun': 'endpoint.out.testRun',
  'outTestEmpty': 'endpoint.out.testEmpty',
  'outTestHint': 'endpoint.out.testHint',
  'outTestResult': 'endpoint.out.testResult',
  'outTestOk': 'endpoint.out.testOk',
  'outTestFail': 'endpoint.out.testFail',
  'deliveryAddress': 'endpoint.delivery.address',
  'deliveryCopy': 'endpoint.delivery.copy',
  'deliveryCopied': 'endpoint.delivery.copied',
  'deliveryHint': 'endpoint.delivery.hint'
};

/**
 * Baut alle Texte der Konfigurationsseite in der gewuenschten Sprache.
 * @param {string} lang – ISO-639-1-Code
 */
function strings(lang) {
  const out = {};
  for (const [name, key] of Object.entries(PAGE_KEYS)) out[name] = t(lang, key);
  return out;
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Erzeugt ein gut ablesbares Zufallspasswort.
 *
 * @returns {string} z.B. "K7M2Q-9XR4T-B3HF8-PD6WZ"
 */
function generatePassword(groups = 4, groupLength = 5) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const parts    = [];

  for (let g = 0; g < groups; g++) {
    const bytes = crypto.randomBytes(groupLength);
    let part = '';

    for (let i = 0; i < groupLength; i++) part += alphabet[bytes[i] % alphabet.length];
    
    parts.push(part);
  }

  return parts.join('-');
}

/**
 * Zeitkonstanter Vergleich zweier Zeichenketten.
 * Der Umweg über SHA-256 sorgt für gleich lange Puffer, sodass auch die
 * Länge der Eingabe nicht über die Laufzeit verraten wird.
 * 
 * Wenn Claude das sagt ... :-)
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  
  return crypto.timingSafeEqual(ha, hb);
}

/** Maskiert HTML-Sonderzeichen für die sichere Ausgabe im Browser. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('too large')); }
      body += chunk.toString('utf8');
    });

    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);

  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  
  res.end(body);
}

/** Prüft, ob die Zeichenkette value wie eine UUID aussieht. */
function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/* Konfigurationsseite
 *
 * In der HTML-Datei stehen folgende Platzhalter zur Verfuegung:
 *
 *   {{styles}}       Inhalt der CSS-Datei
 *   {{script}}       Inhalt der JS-Datei
 *   {{textJson}}     alle Texte der Seite als JSON-Objekt
 *   {{pluginId}}     Plugin-Identifier, HTML-maskiert
 *   {{lang}}         Sprachcode, HTML-maskiert
 *   {{langJson}}     Sprachcode als JSON-Zeichenkette
 *   {{t:name}}       einzelne Uebersetzung, HTML-maskiert
 *   {{nonce}}        Kennung fuer die Inhaltsrichtlinie; gehoert an jedes
 *                    script- und style-Element, sonst blockiert der Browser es
 *
 * "name" ist dabei ein Kurzname aus PAGE_KEYS, nicht der volle Uebersetzungsschluessel.
*/

// Frontend-Seiten
const HTML_FILE = path.join(__dirname, '..', 'html',   'webconfig.html');
const JS_FILE   = path.join(__dirname, '..', 'js',     'webconfig.js');
const CSS_FILE  = path.join(__dirname, '..', 'styles', 'webconfig.css');

let templateCache = null;

/**
 * Liest Vorlage und Gestaltung.
 * Fehlt eine Datei, bleibt der Wert null und buildPage() liefert eine einfache Ersatzseite.
 *
 * @returns {{ html: string|null, css: string }}
 */
function loadTemplate() {
  if (templateCache) return templateCache;

  const read = (file, required) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`[dataEndpoint] ${file} nicht lesbar:`, err.message);
      return required ? null : '';
    }
  };

  templateCache = {
    html: read(HTML_FILE, true),
    js:   read(JS_FILE,   false),
    css:  read(CSS_FILE,  false),
  };

  return templateCache;
}

/**
 * Setzt die Platzhalter der Vorlage.
 *
 * @param   {string} pluginId
 * @param   {string} lang
 * @returns {string} vollstaendige HTML-Seite
 */
function buildPage(pluginId, lang, nonce) {
  const { html, js, css } = loadTemplate();
  const s = strings(lang);

  if (!html) {
    // Ersatzseite, falls die Vorlage fehlt
    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + `<title>${escapeHtml(s.pageTitle)}</title></head>`
      + `<body><p>${escapeHtml(s.pageTitle)}</p>`
      + '<p>html/webconfig.html konnte nicht geladen werden.</p></body></html>';
  }

  // </script> im eingebetteten Code wuerde den Block vorzeitig beenden
  const safeJs   = js.split('</script>').join('<\\/script>');
  const safeText = JSON.stringify(s).split('</script>').join('<\\/script>');

  return html
    .split('{{styles}}').join(
      `  <style nonce="${nonce}">\n` + css.replace(/^(?=.)/gm, '    ') + '  </style>')
    .split('{{nonce}}').join(nonce)
    .split('{{script}}').join(safeJs)
    .split('{{textJson}}').join(safeText)
    .split('{{pluginId}}').join(escapeHtml(pluginId))
    .split('{{langJson}}').join(JSON.stringify(lang))
    .split('{{lang}}').join(escapeHtml(lang))
    .replace(/\{\{t:(\w+)\}\}/g, (_, name) => escapeHtml(s[name] ?? ''));
}

// ---------------------------------------------------------------------------
//  Hauptfunktion
// ---------------------------------------------------------------------------

/**
 * Erstellt einen Endpunkt-Manager.
 *
 * @param {object}   options
 * @param {string}   options.pluginId        Plugin-Identifier (nur zur Anzeige auf der Seite)
 * @param {string}   [options.hostname]      Hostname für die erzeugten Links
 * @param {number}   [options.port]          Port des Webservers (Standard 8745)
 * @param {function} options.getDeviceById   (deviceId) => Geräteobjekt | null
 * @param {function} options.getTargets      (deviceType) => Liste der Ziel-Attribute
 * @param {function} options.getRules        (deviceId) => Regelliste
 * @param {function} options.saveRules       (deviceId, rules, lang) => { ok, rules?, errors? }
 * @param {function} options.getOutbound     (deviceId) => ausgehende Regeln
 * @param {function} options.saveOutbound    (deviceId, rules, lang) => { ok, rules?, errors? }
 * @param {function} options.testOutbound    (deviceId, rules, lang) => Promise<{ ok, results?, errors? }>
 * @param {function} options.getCalendar     (deviceId) => Kalendereinstellungen
 * @param {function} options.saveCalendar    (deviceId, config, lang) => { ok, calendar?, errors? }
 * @param {function} options.fetchCalendar   (deviceId, lang) => Promise<{ ok, count?, status?, errors? }>
 * @param {function} options.calendarStatus  (deviceId) => Zustand des Kalenders
 * @param {function} options.rotatePassword   (deviceId) => { ok, password?, errors? }
 * @param {function} options.applyData       (deviceId, incoming) => { applied, ignored }
 * @param {object}   [options.logger]        { info, warn, error, debug }
 */
function create({
  pluginId,
  hostname = 'localhost',
  port     = DEFAULT_PORT,
  getDeviceById,
  getTargets,
  getRules,
  saveRules,
  getOutbound,
  saveOutbound,
  testOutbound,
  getCalendar,
  saveCalendar,
  fetchCalendar,
  calendarStatus,
  rotatePassword,
  applyData,
  logger,
} = {}) {
  for (const [name, fn] of Object.entries({
    getDeviceById, getTargets, getRules, saveRules,
    getOutbound, saveOutbound, testOutbound,
    getCalendar, saveCalendar, fetchCalendar, calendarStatus,
    rotatePassword, applyData })) {
    if (typeof fn !== 'function') throw new Error(`[dataEndpoint] ${name} ist erforderlich.`);
  }

  const log = logger ?? {
    info:  (...a) => console.log('[dataEndpoint]', ...a),
    warn:  (...a) => console.warn('[dataEndpoint]', ...a),
    error: (...a) => console.error('[dataEndpoint]', ...a),
    debug: () => {},
  };

  // endpointId > { deviceId, password }
  const registry = new Map();
  // token > { endpointId, expiresAt }
  const sessions = new Map();
  // "ip|endpointId" > { count, until }
  const attempts = new Map();

  let server    = null;
  let tlsCreds  = null;
  let protocol  = 'http';
  let sweeper   = null;

  // Helfer

  function clientKey(req, endpointId) {
    const ip = req.socket?.remoteAddress ?? 'unknown';
    return `${ip}|${endpointId}`;
  }

  function isLocked(key) {
    const entry = attempts.get(key);

    if (!entry) return false;
    if (Date.now() > entry.until) { attempts.delete(key); return false; }

    return entry.count >= MAX_FAILED_ATTEMPTS;
  }

  function noteFailure(key) {
    const entry = attempts.get(key) ?? { count: 0, until: 0 };

    entry.count += 1;
    entry.until  = Date.now() + LOCKOUT_MS;
    attempts.set(key, entry);
  }

  function createSession(endpointId) {
    const token = crypto.randomBytes(32).toString('hex');

    sessions.set(token, { endpointId, expiresAt: Date.now() + SESSION_TTL_MS });
    
    return token;
  }

  function resolveSession(req, endpointId) {
    const token = req.headers['x-endpoint-token'];

    if (typeof token !== 'string') return null;
    
    const sess = sessions.get(token);
    
    if (!sess) return null;
    if (Date.now() > sess.expiresAt) { sessions.delete(token); return null; }
    if (sess.endpointId !== endpointId) return null;
    
    return sess;
  }

  /** Entfernt abgelaufene Sessions und sperrt die Seite. */
  function sweep() {
    const now = Date.now();
    
    for (const [token, sess] of sessions) if (now > sess.expiresAt) sessions.delete(token);
    
    for (const [key, entry] of attempts) if (now > entry.until) attempts.delete(key);
  }

  // ---------------------------------------------------------------------------
  //  Request-Handling
  // ---------------------------------------------------------------------------

  async function handle(req, res) {
    const [rawPath, rawQuery] = (req.url ?? '/').split('?');
    const segments = rawPath.split('/').filter(Boolean);
    const endpointId = segments[0];
    const action     = segments[1];

    if (!endpointId || !isUuid(endpointId) || segments.length > 2) {
      return sendJSON(res, 404, { error: 'Not found' });
    }

    const entry = registry.get(endpointId);
    
    if (!entry) return sendJSON(res, 404, { error: 'Unknown endpoint' });

    // Sprache der Oberflaeche; die Seite haengt sie an die Anfragen an
    const query = new URLSearchParams(rawQuery ?? '');
    const lang  = ['de', 'en'].includes(query.get('hl')) ? query.get('hl') : 'en';

    // Konfigurationsseite
    if (req.method === 'GET' && action === undefined) {
      const nonce = crypto.randomBytes(16).toString('base64');

      res.writeHead(200, {
        'Content-Type':           'text/html; charset=utf-8',
        'Cache-Control':          'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy':        'no-referrer',
        'X-Frame-Options':        'DENY',
        'Content-Security-Policy': [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "img-src 'self' data:",
          "connect-src 'self'",     // nur Anfragen an den eigenen Endpunkt
          "form-action 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      });
      return res.end(buildPage(pluginId, lang, nonce));
    }

    // Anmeldung > Session-Token
    if (req.method === 'POST' && action === 'session') {
      const key = clientKey(req, endpointId);
      
      if (isLocked(key)) return sendJSON(res, 429, { error: 'Too many attempts' });

      let body;

      try   { 
        body = JSON.parse(await readBody(req)); 
      } catch { 
        return sendJSON(res, 400, { error: 'Invalid JSON' }); 
      }

      if (!safeEqual(body?.password, entry.password)) {
        noteFailure(key);
        log.warn(`Endpunkt ${endpointId}: fehlgeschlagene Anmeldung.`);
        
        return sendJSON(res, 401, { error: 'Invalid password' });
      }

      attempts.delete(key);
      const token = createSession(endpointId);
      log.info(`Endpunkt ${endpointId}: Anmeldung erfolgreich.`);
      
      return sendJSON(res, 200, { token, expiresIn: SESSION_TTL_MS });
    }

    // Abmelden, Sitzung serverseitig verwerfen
    if (req.method === 'DELETE' && action === 'session') {
      const token = req.headers['x-endpoint-token'];
      
      if (typeof token === 'string' && sessions.has(token)) {
        sessions.delete(token);
        log.info(`Endpunkt ${endpointId}: Sitzung beendet.`);
      }

      return sendJSON(res, 200, { ok: true });
    }

    // Gerätedaten
    if (req.method === 'GET' && action === 'device') {
      if (!resolveSession(req, endpointId)) {
        return sendJSON(res, 401, { error: 'Unauthorized' });
      }
      
      const device = getDeviceById(entry.deviceId);
      
      if (!device) return sendJSON(res, 404, { error: 'Device no longer exists' });

      return sendJSON(res, 200, {
        deviceId:        device.deviceId,
        deviceType:      device.deviceType,
        friendlyName:    device.friendlyName,
        modelType:       device.modelType,
        firmwareVersion: device.firmwareVersion,
        features:        device.features ?? [],
        endpointId,
      });
    }

    // Zuordnungsregeln lesen
    if (req.method === 'GET' && action === 'mapping') {
      if (!resolveSession(req, endpointId)) return sendJSON(res, 401, { error: 'Unauthorized' });

      const device = getDeviceById(entry.deviceId);
      
      if (!device) return sendJSON(res, 404, { error: 'Device no longer exists' });

      return sendJSON(res, 200, {
        deviceType: device.deviceType,
        targets:    getTargets(device.deviceType),
        rules:      getRules(entry.deviceId),
        outbound:   getOutbound(entry.deviceId),
        calendar:   getCalendar(entry.deviceId),
        calendarStatus: calendarStatus(entry.deviceId),
        dataUrl:    `${protocol}://${hostname}:${port}/${endpointId}/data` + `?password=${encodeURIComponent(entry.password)}`,
      });
    }

    // Zuordnungsregeln speichern
    if (req.method === 'PUT' && action === 'mapping') {
      if (!resolveSession(req, endpointId)) return sendJSON(res, 401, { error: 'Unauthorized' });

      const device = getDeviceById(entry.deviceId);
      
      if (!device) return sendJSON(res, 404, { error: 'Device no longer exists' });

      let body;
      
      try   { 
        body = JSON.parse(await readBody(req)); 
      } catch { 
        return sendJSON(res, 400, { error: 'Invalid JSON' }); 
      }

      const response = { ok: true };

      if (body?.rules !== undefined) {
        const result = saveRules(entry.deviceId, body.rules, lang);
        
        if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });
        
        response.rules = result.rules;
      }

      if (body?.outbound !== undefined) {
        const result = saveOutbound(entry.deviceId, body.outbound, lang);
        
        if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });
        
        response.outbound = result.rules;
      }

      if (body?.calendar !== undefined) {
        const result = saveCalendar(entry.deviceId, body.calendar, lang);
        
        if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });
        
        response.calendar = result.calendar;
      }

      log.info(`Endpunkt ${endpointId}: Regeln gespeichert `
        + `(eingehend ${response.rules?.length ?? '-'}, ausgehend ${response.outbound?.length ?? '-'}).`);
      return sendJSON(res, 200, response);
    }

    // Ausgehende Aufrufe probeweise absetzen
    if (req.method === 'POST' && action === 'outbound-test') {
      if (!resolveSession(req, endpointId)) return sendJSON(res, 401, { error: 'Unauthorized' });

      let body;
      
      try   { 
        body = JSON.parse(await readBody(req)); 
      } catch { 
        return sendJSON(res, 400, { error: 'Invalid JSON' }); 
      }

      const result = await testOutbound(entry.deviceId, body?.outbound, lang);
      if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });

      return sendJSON(res, 200, { ok: true, results: result.results });
    }

    // Kalender direkt abrufen
    if (req.method === 'POST' && action === 'calendar-fetch') {
      if (!resolveSession(req, endpointId)) return sendJSON(res, 401, { error: 'Unauthorized' });

      const result = await fetchCalendar(entry.deviceId, lang);
      
      if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });

      return sendJSON(res, 200, { ok: true, count: result.count, status: result.status });
    }

    // Passwort neu erzeugen
    if (req.method === 'POST' && action === 'rotate-password') {
      const session = resolveSession(req, endpointId);
      
      if (!session) return sendJSON(res, 401, { error: 'Unauthorized' });

      const result = rotatePassword(entry.deviceId, lang);
      
      if (!result.ok) return sendJSON(res, 400, { ok: false, errors: result.errors ?? [] });

      // Alle uebrigen Sitzungen dieses Endpunkts verwerfen
      const own = req.headers['x-endpoint-token'];
      let dropped = 0;
      
      for (const [tok, sess] of sessions) {
        if (sess.endpointId !== endpointId || tok === own) continue;
        sessions.delete(tok);
        dropped++;
      }

      // Sperrzaehler zuruecksetzen
      for (const key of [...attempts.keys()]) {
        if (key.endsWith(`|${endpointId}`)) attempts.delete(key);
      }

      log.info(`Endpunkt ${endpointId}: Passwort erneuert, ${dropped} Sitzung(en) beendet.`);

      return sendJSON(res, 200, {
        ok:       true,
        password: result.password,
        dataUrl:  `${protocol}://${hostname}:${port}/${endpointId}/data`
                  + `?password=${encodeURIComponent(result.password)}`,
      });
    }

    // Datenanlieferung (GET mit Parametern oder POST mit JSON-Body)
    if (action === 'data' && (req.method === 'GET' || req.method === 'POST')) {
      const key = clientKey(req, endpointId);
      
      if (isLocked(key)) return sendJSON(res, 429, { error: 'Too many attempts' });

      // Nutzdaten sammeln: bei GET aus der Query, bei POST aus dem JSON-Body
      let incoming = {};
      let bodyPassword = null;

      if (req.method === 'POST') {
        let body;
        
        try   { 
          body = JSON.parse(await readBody(req) || '{}'); 
        } catch { 
          return sendJSON(res, 400, { error: 'Invalid JSON' }); 
        }
        
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          incoming = { ...body };
          
          if (typeof incoming.password === 'string') {
            bodyPassword = incoming.password;
            delete incoming.password;
          }
        }
      } else {
        for (const [k, v] of query) {
          if (k === 'password' || k === 'hl') continue;
          incoming[k] = v;
        }
      }

      const password = query.get('password') ?? bodyPassword;
      
      if (!safeEqual(password, entry.password)) {
        noteFailure(key);
        log.warn(`Endpunkt ${endpointId}: Datenanlieferung mit falschem Passwort.`);
        
        return sendJSON(res, 401, { error: 'Invalid password' });
      }
      
      attempts.delete(key);

      if (Object.keys(incoming).length === 0) {
        return sendJSON(res, 400, { error: 'No values supplied' });
      }

      const result = applyData(entry.deviceId, incoming);
      const status = result.applied.length > 0 ? 200 : 422;
      
      return sendJSON(res, status, {
        applied: result.applied,
        ignored: result.ignored,
      });
    }

    sendJSON(res, 404, { error: 'Not found' });
  }

  // Server-Lebenszyklus

  function start() {
    if (server) return;

    tlsCreds = getTlsCredentials();
    protocol = tlsCreds ? 'https' : 'http';

    const factory = tlsCreds
      ? (h) => https.createServer(tlsCreds, h)
      : (h) => http.createServer(h);

    server = factory((req, res) => {
      handle(req, res).catch((err) => {
        log.error('Endpunkt-Fehler:', err.message);
        try { sendJSON(res, 500, { error: 'Internal error' }); } catch { /* Response evtl. schon beendet */ }
      });
    });

    server.on('error', (err) => {
      log.error(`Endpunkt-Server-Fehler auf Port ${port}:`, err.message);
      
      if (err.code === 'EADDRINUSE') {
        log.error('Port bereits belegt – Endpunkte sind nicht erreichbar.');
      }
      
      server = null;
    });

    server.listen(port, '0.0.0.0', () =>
      log.info(`Endpunkt-Server bereit (${protocol}, Port ${port}).`));

    sweeper = setInterval(sweep, 60_000);
    
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  function stop(reason = 'gestoppt') {
    sessions.clear();
    
    if (sweeper) { clearInterval(sweeper); sweeper = null; }
    
    if (!server) return;
    
    const s = server;
    
    server = null;
    s.close(() => log.info(`Endpunkt-Server geschlossen (${reason}).`));
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  /**
   * Liefert Zugangsdaten für ein Gerät und erzeugt sie, falls noch nicht
   * vorhanden. Das übergebene Objekt wird nicht verändert.
   *
   * @param   {object} device Geräteobjekt aus der devices.json
   * @returns {{ endpointId: string, endpointPassword: string }}
   */
  function ensureCredentials(device) {
    return {
      endpointId:       isUuid(device?.endpointId) ? device.endpointId : crypto.randomUUID(),
      endpointPassword: device?.endpointPassword || generatePassword(),
    };
  }

  /**
   * Übernimmt die aktuelle Geräteliste. Der Server wird gestartet, sobald
   * mindestens ein Gerät einen aktiven Endpunkt besitzt, und gestoppt, sobald
   * keiner mehr aktiv ist.
   *
   * @param   {Array} devices alle Geräte aus der devices.json
   * @returns {number} Anzahl der aktiven Endpunkte
   */
  function sync(devices = []) {
    registry.clear();

    for (const device of devices) {
      if (!device?.endpointEnabled) continue;
      if (!isUuid(device.endpointId) || !device.endpointPassword) continue;
      registry.set(device.endpointId, {
        deviceId: device.deviceId,
        password: device.endpointPassword,
      });
    }

    // Sessions verwaister Endpunkte loeschen
    for (const [token, sess] of sessions) {
      if (!registry.has(sess.endpointId)) sessions.delete(token);
    }

    if (registry.size > 0) start();
    else                   stop('keine aktiven Endpunkte');

    return registry.size;
  }

  /**
   * Baut die öffentliche URL eines Endpunkts.
   * 
   * @param {string} endpointId
   * @param {string} [lang] Sprachcode für die Zielseite
   */
  function getPublicUrl(endpointId, lang) {
    const proto = tlsCreds || getTlsCredentials() ? 'https' : 'http';
    const query = lang ? `?hl=${encodeURIComponent(lang)}` : '';
    return `${proto}://${hostname}:${port}/${endpointId}${query}`;
  }

  // Gibt zurück, ob der Webserver gerade läuft.
  function isRunning() {
    return server !== null;
  }

  // Anzahl der aktuell registrierten Endpunkte.
  function count() {
    return registry.size;
  }

  return { ensureCredentials, sync, getPublicUrl, isRunning, count, stop };
}

module.exports = { create, generatePassword };
