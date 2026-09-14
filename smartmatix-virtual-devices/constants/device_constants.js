'use strict';

// Mapping: Gerätetypen mit Default-Werten
const DEVICE_FEATURES = {
  BATTERY: {
    features:    [{ type: 'batteryState', batteryLevel: 0.4 }],
    stateType:   'NUMBER',
    stateKey:    'batteryLevel',
    stateValues: null,
    stateMin:    0,
    stateMax:    1,
  },
  CONTACT_SENSOR: {
    // Attribut heisst laut Connect API 1.0.1 (Kap. 6.7.7) 'triggered'
    features:    [{ type: 'contactSensorState', triggered: false }],
    stateType:   'BOOLEAN',
    stateKey:    'triggered',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  ENERGY_METER: {
    features:    [{ type: 'currentPower', currentPower: 0 }],
    stateType:   'NUMBER',
    stateKey:    'currentPower',
    stateValues: null,
    stateMin:    0,
    stateMax:    100000,
  },
  EV_CHARGER: {
    features:    [{ type: 'currentPower', currentPower: 0 }],
    stateType:   'NUMBER',
    stateKey:    'currentPower',
    stateValues: null,
    stateMin:    0,
    stateMax:    22000,
  },
  GRID_CONNECTION_POINT: {
    features:    [{ type: 'currentPower', currentPower: 0 }],
    stateType:   'NUMBER',
    stateKey:    'currentPower',
    stateValues: null,
    stateMin:    -100000,
    stateMax:    100000,
  },
  HVAC: {
    features:    [{ type: 'currentPower', currentPower: 0 }],
    stateType:   'NUMBER',
    stateKey:    'currentPower',
    stateValues: null,
    stateMin:    0,
    stateMax:    10000,
  },
  INVERTER: {
    features:    [{ type: 'currentPower', currentPower: 0 }],
    stateType:   'NUMBER',
    stateKey:    'currentPower',
    stateValues: null,
    stateMin:    0,
    stateMax:    100000,
  },
  LIGHT: {
    features:    [{ type: 'switchState', on: false }],
    stateType:   'BOOLEAN',
    stateKey:    'on',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  OCCUPANCY_SENSOR: {
    features:    [{ type: 'presenceDetected', presenceDetected: false }],
    stateType:   'BOOLEAN',
    stateKey:    'presenceDetected',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  SMOKE_ALARM: {
    features:    [{ type: 'smokeAlarm', smokeAlarm: false }],
    stateType:   'BOOLEAN',
    stateKey:    'smokeAlarm',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  SWITCH: {
    features:    [{ type: 'switchState', on: false }],
    stateType:   'BOOLEAN',
    stateKey:    'on',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  THERMOSTAT: {
    features:    [{ type: 'setPointTemperature', setPointTemperature: 20.0 }],
    stateType:   'NUMBER',
    stateKey:    'setPointTemperature',
    stateValues: null,
    stateMin:    5,
    stateMax:    30,
  },
  VEHICLE: {
    features:    [{ type: 'batteryState', batteryLevel: 0.4 }],
    stateType:   'NUMBER',
    stateKey:    'batteryLevel',
    stateValues: null,
    stateMin:    0,
    stateMax:    1,
  },
  WATER_SENSOR: {
    features:    [{ type: 'waterlevelDetected', waterlevelDetected: false }],
    stateType:   'BOOLEAN',
    stateKey:    'waterlevelDetected',
    stateValues: null,
    stateMin:    null,
    stateMax:    null,
  },
  WINDOW_COVERING: {
    features:    [{ type: 'shutterLevel', shutterLevel: 0.5 }],
    stateType:   'NUMBER',
    stateKey:    'shutterLevel',
    stateValues: null,
    stateMin:    0,
    stateMax:    1,
  },
  HEAT_PUMP: {
    features:    [{ type: 'climateOperationMode', climateOperationMode: 'HEATING' }],
    stateType:   'ENUM',
    stateKey:    'climateOperationMode',
    stateValues: ['AUTO', 'COOLING', 'HEATING'],
    stateMin:    null,
    stateMax:    null,
  },
  CLIMATE_SENSOR:           { features: [], stateType: null, stateKey: null, stateValues: null, stateMin: null, stateMax: null },
  PARTICULATE_MATTER_SENSOR:{ features: [], stateType: null, stateKey: null, stateValues: null, stateMin: null, stateMax: null },
  SWITCH_INPUT:             { features: [], stateType: null, stateKey: null, stateValues: null, stateMin: null, stateMax: null },
};

/**
 * Umbenennungen von Attributen, die in aelteren Plugin-Versionen andere
 * Bezeichnungen hatten. Wird beim Laden der devices.json angewendet.
 *   Feature-Typ > { alterName: neuerName }
 */
const LEGACY_ATTRIBUTE_RENAMES = {
  contactSensorState:   { contactSensorState: 'triggered' },
  climateOperationMode: { mode: 'climateOperationMode' },
};

module.exports = { DEVICE_FEATURES, LEGACY_ATTRIBUTE_RENAMES };