'use strict';

/**
 * devicesStore.js
 *
 * Liest und schreibt die Geräte-Konfiguration aus/in eine devices.json.
 * Die Datei liegt im Arbeitsverzeichnis des Plugins: /data
 *
 * Format der devices.json:
 * {
 *   "vardev-light-1": {
 *     "deviceType":      "LIGHT",
 *     "deviceId":        "vardev-light-1",
 *     "firmwareVersion": "1.0.0",
 *     "friendlyName":    "Wohnzimmer Lampe",
 *     "modelType":       "VarDevLight",
 *     "features": [
 *       { "type": "switchState", "on": false }
 *     ],
 *     "alreadyIncluded": true
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');


const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const DEVICES_FILE = DATA_PATH + '/devices.json';


// Standard-Gerät – wird angelegt wenn devices.json noch nicht existiert
const DEFAULT_DEVICES = {
  'vardev-light-1': {
    deviceType:      'LIGHT',
    deviceId:        'vardev-light-1',
    firmwareVersion: '1.0.0',
    friendlyName:    'Wohnzimmer Lampe',
    modelType:       'VarDevLight',
    features: [
      { type: 'switchState', on: false },
    ],
    alreadyIncluded: false
  },
};

/**
 * Liest die devices.json vom Dateisystem.
 * Falls die Datei nicht existiert, wird sie mit den Standard-Geräten angelegt.
 * @returns {object} Geräteobjekt { deviceId: deviceObject, ... }
 */
function load() {
  try {
    const raw     = fs.readFileSync(DEVICES_FILE, { encoding: 'utf8' });
    const devices = JSON.parse(raw);
    log.info('Anzahl geladener Geraete:', Object.keys(devices).length);

    log.info(`Geraete geladen aus: ${DEVICES_FILE}`);
    return devices;
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info('Keine devices.json gefunden – lege Standard-Konfiguration an.');
      save(DEFAULT_DEVICES);
    } else {
      log.warn('Fehler beim Lesen der devices.json:', err.message);
    }
    return { ...DEFAULT_DEVICES };
  }
}

/**
 * Schreibt das Geräteobjekt in die devices.json.
 * @param {object} devices - { deviceId: deviceObject, ... }
 */
function save(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), { encoding: 'utf8' });
    log.info(`Geraetekonfiguration gespeichert in: ${DEVICES_FILE}`);
  } catch (err) {
    log.error('Fehler beim Schreiben der devices.json:', err.message);
  }
}

/**
 * Aktualisiert das Geräteobjekt in die devices.json.
 * @param {object} deviceId - ID des zu verändernden Objekts
 * @param {object} deviceObject - Objekt, das es zu verändernden gilt
 */
function update(deviceId, deviceObject) {
  const current = load();
  current[deviceId] = deviceObject;
  save(current);
}

/**
 * Löscht das Geräteobjekt in die devices.json.
 * @param {object} deviceId - ID des zu löschenden Objekts
 */
function remove(deviceId) {
  const current = load();
  delete current[deviceId];
  save(current);
}

/**
 * Markiert im Speicher, dass das Gerät bereits der HCU übermittelt wurde.
 * @param {object} deviceId - ID des zu bearbeitenden Objekts
 */
function markAsIncluded(deviceIds) {
  const current = load();

  deviceIds.forEach(id => {
    if (current[id]) {
      current[id].alreadyIncluded = true;
    }
  });
  save(current);
}

module.exports = { load, save, update, remove, markAsIncluded };