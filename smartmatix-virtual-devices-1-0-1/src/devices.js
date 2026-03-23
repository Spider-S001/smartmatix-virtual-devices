'use strict';

/**
 * devices.js – Geräteverwaltung
 *
 * Hier werden die Geräte definiert, die dieses Plugin
 * gegenüber der HCU verwaltet.
 *
 * Gerätestruktur (Connect API 1.0.1):
 * {
 *   deviceType:      'LIGHT' | 'SENSOR' | 'THERMOSTAT' | …
 *   deviceId:        'eigene-eindeutige-id'
 *   firmwareVersion: '1.0.0'
 *   friendlyName:    'Anzeigename in der HCU'
 *   modelType:       'Modellbezeichnung'
 *   features: [
 *     { type: 'switchState', on: false },
 *     { type: 'dimmerState', level: 0 },
 *     …
 *   ]
 * }
 */

const log = require('./logger');
const devicesStore = require('./devicesStore');
const { v4: uuidv4 } = require('uuid');

const { DEVICE_FEATURES } = require('../constants/device_constants.js');

// ---------------------------------------------------------------------------
//  Gerätedefinitionen – hier eigene Geräte eintragen
// ---------------------------------------------------------------------------

let deviceRegistry = loadStoredDevices();

// const deviceRegistry = new Map([
  // Weiteres Gerät als Beispiel:
  // [
  //   'mein-sensor-1',
  //   {
  //     deviceType:      'SENSOR',
  //     deviceId:        'mein-sensor-1',
  //     firmwareVersion: '1.0.0',
  //     friendlyName:    'Temperatursensor Keller',
  //     modelType:       'MeinPluginSensor',
  //     features: [
  //       { type: 'temperatureState', temperature: 20.5 },
  //     ],
  //      alreadyIncluded: false,
  //   },
  // ],
//]);

// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------

/** Lädt Geräte aus der devices.json und gibt sie als Array zurück (für deviceRegistry) */
function loadStoredDevices() {
  // devicesStore.load() gibt { deviceId: deviceObject, ... } zurück
  const stored = devicesStore.load();
  const map    = new Map(Object.entries(stored));
  log.info(`${map.size} Geraet(e) aus devices.json geladen.`);
  return map;
}
 
// ---------------------------------------------------------------------------
//  Öffentliche API
// ---------------------------------------------------------------------------
 
/** Gibt alle registrierten Geräte als Array zurück (für DISCOVER_RESPONSE). */
function getAll() {
  return Array.from(deviceRegistry.values());
}
 
/** Gibt ein einzelnes Gerät nach ID zurück (für STATUS_RESPONSE). */
function getById(deviceId) {
  return deviceRegistry.get(deviceId) ?? null;
}

/** Gibt die Anzahl der Geräte in der devices.json zurück (für CONFIG_TEMPLATE_REQUEST). */
function getDevicesLength() {
  return deviceRegistry.size;
}

/** Gibt die Gerätedefinitionen DEVICE_FEATURES zurück. */
function getFeatureDef(deviceType) {
  return DEVICE_FEATURES[deviceType] ?? null;
}
 
/**
 * Verarbeitet den Steuerbefehl der HCU (CONTROL_REQUEST).
 * @param {string}   deviceId - Ziel-Geräte-ID
 * @param {object[]} features - Array von Feature-Objekten mit neuem Zustand
 * @returns {boolean} true = Befehl erfolgreich ausgeführt
 */
function control(deviceId, features) {
  const device = deviceRegistry.get(deviceId);
  if (!device) {
    log.warn(`control(): Geraet nicht gefunden: ${deviceId}`);
    return false;
  }
 
  if (!Array.isArray(features) || features.length === 0) {
    log.warn(`control(): Keine Features im CONTROL_REQUEST fuer ${deviceId}`);
    return false;
  }
 
  for (const incoming of features) {
    const existing = device.features.find(f => f.type === incoming.type);
    if (existing) {
      Object.assign(existing, incoming);
      log.info(`${deviceId} | Feature "${incoming.type}" aktualisiert:`, incoming);
    } else {
      log.warn(`${deviceId}: Unbekannter Feature-Typ "${incoming.type}" – wird ignoriert.`);
    }
  }
 
  return true;
}

/** Aktualisiert alle registrierten Geräte (für CONFIG_UPDATE_REQUEST). */
function reload() {
  deviceRegistry = loadStoredDevices();
  log.info('Geraeteliste neu geladen.');
}

/**
 * Erstellt ein neues Gerät und speichert es in der devices.json.
 * @param {string}  friendlyName - Name des Geräts in der App
 * @param {string}  deviceType - Typ des zu erstellenden Geräts
 * @param {array}   allDevices - Aktuelle Liste aller Geräte aus devices.json
 * @returns {object} Objekt des neuen Geräts
 */
function createDevice(friendlyName, deviceType, allDevices) {
  // Anzahl der Geräte dieses Typs zählen > für die Gerätenummer
  const sameTypeCount = allDevices.filter(d => d.deviceType === deviceType).length;

  // vardev-occupancy-sensor-1 (Unterstriche zu Bindestrichen ändern)
  const deviceId = `vardev-${deviceType.toLowerCase().replace(/_/g, '-')}-${uuidv4().substring(0, 8)}`;

  // VarDevOccupancySensor (CamelCase)
  const modelType = 'VarDev' + deviceType.charAt(0) +
    deviceType.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  return {
    deviceType,
    deviceId,
    firmwareVersion: '1.0.0',
    friendlyName,
    modelType,
    features: [...(DEVICE_FEATURES[deviceType]?.features ?? [])],
    alreadyIncluded: false,
  };
}

/**
 * Bereinigt einen String von kaputten Encoding-Zeichen (HCU-Bug Workaround).
 * @param {*} value - Eingabewert
 * @returns {*} Bereinigter String oder unveränderter Wert wenn kein String
 */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\uFFFD/g, '?');
}
 
module.exports = { getAll, getById, getDevicesLength, getFeatureDef, control, reload, createDevice, sanitize };