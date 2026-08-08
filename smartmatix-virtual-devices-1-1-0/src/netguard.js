'use strict';

/**
 * ==================
 * Bewertet Ziele ausgehender Verbindungen.
 *
 * Das Plugin ruft Adressen auf, die ein angemeldeter Nutzer eingetragen hat:
 * ausgehende GET-Aufrufe bei Zustandsänderungen und Kalender-Feeds. Beides
 * richtet sich ausdrücklich auch an Geräte im Heimnetz, private Adressbereiche
 * bleiben deshalb erlaubt.
 *
 * Gesperrt sind:
 *   - Loopback (127.0.0.0/8, ::1)
 *   - Link-Local (169.254.0.0/16, fe80::/10), darunter 169.254.169.254, die Metadaten-Adresse vieler virtueller Umgebungen
 *   - sonstige Sonderbereiche (0.0.0.0/8, Multicast, ::)
 *
 * Zusätzlich gilt für Weiterleitungen: Wer bei einer öffentlichen Adresse
 * beginnt, darf nicht auf eine private umgeleitet werden. Ohne diese Regel
 * könnte eine von außen erreichbare Adresse auf Dienste im Heimnetz zeigen.
 *
 * TLS-Zertifikate werden bei öffentlichen Zielen geprüft. Nur bei privaten
 * Adressen wird darauf verzichtet, weil Geräte im Heimnetz üblicherweise
 * selbstsignierte Zertifikate verwenden.
 *
 * ==================
 */

const dns = require('dns').promises;
const net = require('net');

// Einstufung einer Adresse.
const SCOPE = {
  LOOPBACK:  'loopback',
  LINKLOCAL: 'linklocal',
  SPECIAL:   'special',
  PRIVATE:   'private',
  PUBLIC:    'public',
};

const BLOCKED = new Set([SCOPE.LOOPBACK, SCOPE.LINKLOCAL, SCOPE.SPECIAL]);

/**
 * Stuft eine IP-Adresse ein.
 *
 * @param   {string} ip  IPv4- oder IPv6-Adresse
 * @returns {string} einer der SCOPE-Werte
 */
function classifyIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return SCOPE.PUBLIC;
}

function classifyIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return SCOPE.SPECIAL;
  }

  const [a, b] = p;

  if (a === 127) return SCOPE.LOOPBACK;
  if (a === 169 && b === 254) return SCOPE.LINKLOCAL;
  if (a === 0) return SCOPE.SPECIAL;
  if (a >= 224) return SCOPE.SPECIAL;                       // Multicast und reserviert

  if (a === 10) return SCOPE.PRIVATE;
  if (a === 172 && b >= 16 && b <= 31) return SCOPE.PRIVATE;
  if (a === 192 && b === 168) return SCOPE.PRIVATE;
  if (a === 100 && b >= 64 && b <= 127) return SCOPE.PRIVATE; // Carrier-Grade NAT

  return SCOPE.PUBLIC;
}

function classifyIpv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];

  if (addr === '::1') return SCOPE.LOOPBACK;
  if (addr === '::' || addr === '') return SCOPE.SPECIAL;
  if (addr.startsWith('fe8') || addr.startsWith('fe9')
   || addr.startsWith('fea') || addr.startsWith('feb')) return SCOPE.LINKLOCAL;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return SCOPE.PRIVATE;
  if (addr.startsWith('ff')) return SCOPE.SPECIAL;

  // IPv4 in IPv6-Schreibweise
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIpv4(mapped[1]);

  return SCOPE.PUBLIC;
}

/**
 * Löst einen Hostnamen auf und stuft alle Ergebnisse ein.
 *
 * Ist der Name bereits eine IP-Adresse, entfällt die Auflösung. Liefert die
 * Auflösung mehrere Adressen, gilt die restriktivste Einstufung, sonst ließe
 * sich die Sperre über einen Namen mit gemischten Einträgen umgehen.
 *
 * @param   {string} hostname
 * @returns {Promise<{ scope: string, addresses: string[] }>}
 */
async function classifyHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '');

  if (net.isIP(host)) return { scope: classifyIp(host), addresses: [host] };

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (err) {
    return { scope: SCOPE.SPECIAL, addresses: [], error: err.message };
  }

  const addresses = records.map((r) => r.address);
  const scopes    = addresses.map(classifyIp);

  // Reihenfolge der Strenge: gesperrte Bereiche zuerst
  for (const s of [SCOPE.SPECIAL, SCOPE.LOOPBACK, SCOPE.LINKLOCAL, SCOPE.PRIVATE]) {
    if (scopes.includes(s)) return { scope: s, addresses };
  }
  return { scope: SCOPE.PUBLIC, addresses };
}

/**
 * Prüft, ob eine Adresse angesteuert werden darf.
 *
 * @param   {string} url
 * @param   {string} [fromScope]  Einstufung der ursprünglichen Adresse bei Weiterleitungen; verhindert den Wechsel
 *                                von öffentlich nach privat
 * @returns {Promise<{ ok: boolean, scope?: string, reason?: string }>}
 */
async function checkTarget(url, fromScope = null) {
  let target;
  
  try {
    target = new URL(url);
  } catch {
    return { ok: false, reason: 'Ungueltige Adresse' };
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return { ok: false, reason: `Protokoll ${target.protocol} nicht erlaubt` };
  }

  const { scope, error } = await classifyHost(target.hostname);

  if (error) return { ok: false, scope, reason: `Name nicht aufloesbar: ${error}` };

  if (BLOCKED.has(scope)) {
    return { ok: false, scope, reason: `Zieladresse gesperrt (${scope})` };
  }

  if (fromScope === SCOPE.PUBLIC && scope === SCOPE.PRIVATE) {
    return { ok: false, scope,
      reason: 'Weiterleitung von einer oeffentlichen auf eine private Adresse' };
  }

  return { ok: true, scope };
}

/**
 * Liefert die TLS-Einstellungen für ein Ziel.
 *
 * Bei öffentlichen Adressen wird das Zertifikat geprüft. Im privaten
 * Adressbereich wird darauf verzichtet.
 *
 * @param   {string} scope  Einstufung aus checkTarget()
 * @returns {object} Zusatzoptionen für https.request
 */
function tlsOptions(scope) {
  return { rejectUnauthorized: scope !== SCOPE.PRIVATE };
}

module.exports = { SCOPE, checkTarget, classifyHost, classifyIp, tlsOptions };
