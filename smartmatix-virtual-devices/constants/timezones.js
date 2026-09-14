'use strict';

/**
 * timezones.js
 * ---------------------------------------------------------------------------
 * Auswahlliste der europäischen Zeitzonen.
 *
 * Die HCU führt ihre Container in UTC. Ohne passende Einstellung legt das
 * Plugin die Ortszeiten eines Kalenders als UTC aus, wodurch Termine um die
 * Zeitverschiebung versetzt eintreten.
 *
 * Gesetzt wird die Zone über process.env.TZ. Damit rechnet Node sämtliche
 * Datumsoperationen in dieser Zone, einschließlich der Sommerzeit – eine
 * eigene Umrechnung ist nicht nötig.
 *
 * Die Kennungen stammen aus der IANA-Zeitzonendatenbank; die Beschriftung
 * nennt zusätzlich die Verschiebung zur Normalzeit.
 * ---------------------------------------------------------------------------
 */

const TIMEZONES = [
  { id: 'Europe/Berlin',    label: 'Mitteleuropa – Berlin, Wien, Zürich (UTC+1)' },
  { id: 'Europe/Amsterdam', label: 'Mitteleuropa – Amsterdam, Brüssel (UTC+1)' },
  { id: 'Europe/Paris',     label: 'Mitteleuropa – Paris, Madrid (UTC+1)' },
  { id: 'Europe/Rome',      label: 'Mitteleuropa – Rom (UTC+1)' },
  { id: 'Europe/Prague',    label: 'Mitteleuropa – Prag, Warschau (UTC+1)' },
  { id: 'Europe/Stockholm', label: 'Mitteleuropa – Stockholm, Oslo, Kopenhagen (UTC+1)' },
  { id: 'Europe/Budapest',  label: 'Mitteleuropa – Budapest, Zagreb (UTC+1)' },
  { id: 'Europe/London',    label: 'Westeuropa – London, Dublin (UTC+0)' },
  { id: 'Europe/Lisbon',    label: 'Westeuropa – Lissabon (UTC+0)' },
  { id: 'Europe/Helsinki',  label: 'Osteuropa – Helsinki, Riga, Tallinn (UTC+2)' },
  { id: 'Europe/Athens',    label: 'Osteuropa – Athen, Bukarest, Sofia (UTC+2)' },
  { id: 'Europe/Kyiv',      label: 'Osteuropa – Kiew (UTC+2)' },
  { id: 'Europe/Istanbul',  label: 'Türkei – Istanbul (UTC+3)' },
  { id: 'Europe/Moscow',    label: 'Russland – Moskau (UTC+3)' },
  { id: 'UTC',              label: 'UTC – keine Verschiebung' },
];

const DEFAULT_TIMEZONE = 'Europe/Berlin';

/** Gibt zurück, ob eine Kennung in der Liste steht. */
function isKnown(id) {
  return TIMEZONES.some((z) => z.id === id);
}

/** Ordnet einen Anzeigenamen aus dem Dropdown der Kennung zu. */
function fromLabel(value) {
  if (!value) return null;
  if (isKnown(value)) return value;
  return TIMEZONES.find((z) => z.label === value)?.id ?? null;
}

/** Beschriftung zu einer Kennung. */
function toLabel(id) {
  return TIMEZONES.find((z) => z.id === id)?.label ?? id;
}

/**
 * Setzt die Zeitzone des Prozesses.
 *
 * Node wertet process.env.TZ bei jeder Datumsoperation neu aus, die Umstellung
 * greift also sofort und ohne Neustart.
 *
 * @param   {string} id
 * @returns {boolean} true, wenn die Zone übernommen wurde
 */
function apply(id) {
  if (!isKnown(id)) return false;
  process.env.TZ = id;
  return true;
}

module.exports = { TIMEZONES, DEFAULT_TIMEZONE, isKnown, fromLabel, toLabel, apply };
