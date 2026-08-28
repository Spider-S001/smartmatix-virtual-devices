'use strict';

/**
 * ==================
 * Versendet die ausgehenden GET-Aufrufe bei Zustandsänderungen eines Geräts.
 *
 * Aufgerufen wird nur bei Änderungen, die von der HCU-Seite kommen:
 * einem CONTROL_REQUEST oder dem Statusfeld im Einstellungsmenü.
 *
 * Eigenschaften der Zustellung:
 *   - asynchron
 *   - Zeitlimit je Aufruf, danach Abbruch
 *   - kein Wiederholungsversuch, Fehler landen im Log
 *   - gleichzeitige Aufrufe sind begrenzt, damit eine hängende Gegenstelle
 *     das Plugin nicht mit offenen Verbindungen flutet
 *
 * Bei https-Zielen werden selbstsignierte Zertifikate akzeptiert.
 *
 * ==================
 */

const http  = require('http');
const https = require('https');

const log      = require('./logger');
const netguard = require('./netguard');

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT     = 8;
const MAX_QUEUE          = 200;
const USER_AGENT         = 'SmartMatix-Virtual-Devices';

let active = 0;
const queue = [];

/**
 * Führt einen einzelnen GET-Aufruf aus.
 *
 * @param   {string} url
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
async function request(url) {
  const verdict = await netguard.checkTarget(url);
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  return new Promise((resolve) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const options = {
      method:  'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      ...(target.protocol === 'https:' ? netguard.tlsOptions(verdict.scope) : {}),
    };

    const req = client.request(target, options, (res) => {
      // Antwort-Body verwerfen, aber lesen, damit die Verbindung frei wird
      res.resume();
      res.on('end', () => resolve({
        ok:     res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode,
      }));
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve({ ok: false, error: `Zeitlimit nach ${REQUEST_TIMEOUT_MS} ms` });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

/** Arbeitet die Warteschlange ab, ohne MAX_CONCURRENT zu überschreiten. */
function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    active++;

    request(job.url).then((result) => {
      active--;
      if (result.ok) {
        log.info(`Ausgehend > ${job.label}: HTTP ${result.status}`);
      } else {
        log.warn(`Ausgehend > ${job.label} fehlgeschlagen:`,
                 result.error ?? `HTTP ${result.status}`);
      }
      pump();
    });
  }
}

/**
 * Stellt Aufrufe in die Warteschlange
 *
 * @param   {Array<{url: string, target: string, value: *}>} calls
 * @param   {string} [deviceId]  nur für die Logausgabe
 * @returns {number} Anzahl der eingereihten Aufrufe
 */
function dispatch(calls = [], deviceId = '') {
  let queued = 0;

  for (const call of calls) {
    if (queue.length >= MAX_QUEUE) {
      log.warn(`Ausgehende Warteschlange voll (${MAX_QUEUE}) – Aufruf verworfen.`);
      break;
    }
    queue.push({
      url:   call.url,
      label: `${deviceId} ${(call.sources ?? []).join('+')}`.trim(),
    });
    queued++;
  }

  if (queued > 0) pump();
  
  return queued;
}

/** Anzahl der wartenden und laufenden Aufrufe, für Tests und Diagnose. */
function pending() {
  return { queued: queue.length, active };
}

/**
 * Ruft mehrere Adressen zu Testzwecken auf und liefert die Ergebnisse zurück.
 *
 * Anders als dispatch() wird hier gewartet, damit die Oberfläche je Zeile
 * anzeigen kann, ob das Ziel erreichbar war. Die Nebenläufigkeit ist auf
 * denselben Wert begrenzt wie beim regulären Versand.
 *
 * Achtung: Es werden echte Aufrufe abgesetzt.
 *
 * @param   {Array<{url: string}>} items
 * @returns {Promise<Array>} Eingaben, ergänzt um { ok, status?, error? }
 */
async function probe(items = []) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = { ...items[i], ...(await request(items[i].url)) };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, worker));

  return results;
}

module.exports = { dispatch, request, probe, pending, REQUEST_TIMEOUT_MS };
