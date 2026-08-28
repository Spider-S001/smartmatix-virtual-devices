'use strict';

/**
 * feature_catalog.js
 * ---------------------------------------------------------------------------
 * Vollstaendiger Katalog der Features aus der Connect API 1.0.1.
 * ---------------------------------------------------------------------------
 */

const ENUM_VALUES = {
  'ClimateOperationType': [
    'AUTO',
    'COOLING',
    'HEATING'
  ],
  'PresenceType': [
    'AWAY',
    'DEFAULT',
    'HOME',
    'NORMAL',
    'VACATION'
  ],
  'ShadingDirection': [
    'DARKER',
    'LIGHTER'
  ]
};

const FEATURE_CATALOG = {
  actualTemperature: {
    title: 'ActualTemperature',
    attributes: {
      actualTemperature: { valueType: 'NUMBER', min: -50, max: 60 },
    },
  },
  batteryState: {
    title: 'BatteryState',
    attributes: {
      batteryCapacity: { valueType: 'NUMBER', min: 0 },
      batteryLevel: { valueType: 'NUMBER', min: 0, max: 1 },
    },
  },
  climateOperationMode: {
    title: 'ClimateOperationMode',
    attributes: {
      climateOperationMode: { valueType: 'ENUM', enumType: 'ClimateOperationType' },
    },
  },
  co2: {
    title: 'CO2Concentration',
    attributes: {
      co2: { valueType: 'NUMBER', min: 0 },
    },
  },
  color: {
    title: 'Color',
    attributes: {
      hue: { valueType: 'NUMBER', integer: true, min: 0, max: 361 },
      saturationLevel: { valueType: 'NUMBER', min: 0, max: 1 },
    },
  },
  colorTemperature: {
    title: 'ColorTemperature',
    attributes: {
      colorTemperature: { valueType: 'NUMBER', integer: true, min: 0 },
      maximumColorTemperature: { valueType: 'NUMBER', integer: true, min: 0 },
      minimalColorTemperature: { valueType: 'NUMBER', integer: true, min: 0 },
    },
  },
  contactSensorState: {
    title: 'ContactSensorState',
    attributes: {
      triggered: { valueType: 'BOOLEAN' },
    },
  },
  coolingTemperatureOffset: {
    title: 'CoolingTemperatureOffset',
    attributes: {
      coolingTemperatureOffset: { valueType: 'NUMBER', min: -50, max: 50 },
    },
  },
  currentPower: {
    title: 'CurrentPower',
    attributes: {
      currentPower: { valueType: 'NUMBER' },
    },
  },
  dimming: {
    title: 'Dimming',
    attributes: {
      dimLevel: { valueType: 'NUMBER', min: 0, max: 1 },
    },
  },
  energyCounter: {
    title: 'EnergyCounter',
    attributes: {
      in: { valueType: 'NUMBER', min: 0 },
      out: { valueType: 'NUMBER', min: 0 },
    },
  },
  heatingTemperatureOffset: {
    title: 'HeatingTemperatureOffset',
    attributes: {
      heatingTemperatureOffset: { valueType: 'NUMBER', min: -50, max: 50 },
    },
  },
  hotWaterBoost: {
    title: 'HotWaterBoost',
    attributes: {
      on: { valueType: 'BOOLEAN' },
    },
  },
  humidity: {
    title: 'Humidity',
    attributes: {
      humidity: { valueType: 'NUMBER', integer: true, min: 0, max: 100 },
    },
  },
  illumination: {
    title: 'Illumination',
    attributes: {
      illumination: { valueType: 'NUMBER', min: 0, max: 20000 },
    },
  },
  maintenance: {
    title: 'Maintenance',
    attributes: {
      lowBat: { valueType: 'BOOLEAN' },
      sabotage: { valueType: 'BOOLEAN' },
      unreach: { valueType: 'BOOLEAN' },
    },
  },
  moistureDetected: {
    title: 'MoistureDetected',
    attributes: {
      moistureDetected: { valueType: 'BOOLEAN' },
    },
  },
  onTime: {
    title: 'OnTime',
    attributes: {
      onTime: { valueType: 'NUMBER', min: 0 },
    },
  },
  particulateMassOne: {
    title: 'ParticulateMassOne',
    attributes: {
      particulateMassConcentrationOne: { valueType: 'NUMBER', min: 0 },
      particulateMassConcentrationOneAverage: { valueType: 'NUMBER', min: 0 },
      particulateNumberConcentrationOne: { valueType: 'NUMBER', min: 0 },
    },
  },
  particulateMassTen: {
    title: 'ParticulateMassTen',
    attributes: {
      airQualityIndexTen: { valueType: 'NUMBER', min: 0 },
      particulateMassConcentrationTen: { valueType: 'NUMBER', min: 0 },
      particulateMassConcentrationTenAverage: { valueType: 'NUMBER', min: 0 },
      particulateNumberConcentrationTen: { valueType: 'NUMBER', min: 0 },
      particulateNumberConcentrationTenAverage: { valueType: 'NUMBER', min: 0 },
    },
  },
  particulateMassTwoPointFive: {
    title: 'ParticulateMassTwoPointFive',
    attributes: {
      airQualityIndexTwoPointFive: { valueType: 'NUMBER', min: 0 },
      particulateMassConcentrationTwoPointFive: { valueType: 'NUMBER', min: 0 },
      particulateMassConcentrationTwoPointFiveAverage: { valueType: 'NUMBER', min: 0 },
      particulateNumberConcentrationTwoPointFive: { valueType: 'NUMBER', min: 0 },
      particulateNumberConcentrationTwoPointFiveAverage: { valueType: 'NUMBER', min: 0 },
    },
  },
  particulateTypicalSize: {
    title: 'ParticulateTypicalSize',
    attributes: {
      particulateTypicalSize: { valueType: 'NUMBER', min: 0 },
    },
  },
  presenceDetected: {
    title: 'PresenceDetected',
    attributes: {
      presenceDetected: { valueType: 'BOOLEAN' },
    },
  },
  presenceMode: {
    title: 'PresenceMode',
    attributes: {
      presenceMode: { valueType: 'ENUM', enumType: 'PresenceType' },
    },
  },
  rainCount: {
    title: 'RainCount',
    attributes: {
      rainCounter: { valueType: 'NUMBER', min: 0 },
      todayRainCounter: { valueType: 'NUMBER', min: 0 },
      yesterdayRainCounter: { valueType: 'NUMBER', min: 0 },
    },
  },
  raining: {
    title: 'Raining',
    attributes: {
      raining: { valueType: 'BOOLEAN' },
    },
  },
  setPointTemperature: {
    title: 'SetPointTemperature',
    attributes: {
      setPointTemperature: { valueType: 'NUMBER', min: 5, max: 30 },
    },
  },
  shutterDirection: {
    title: 'ShutterDirection',
    attributes: {
      shutterDirection: { valueType: 'ENUM', enumType: 'ShadingDirection' },
    },
  },
  shutterLevel: {
    title: 'ShutterLevel',
    attributes: {
      shutterLevel: { valueType: 'NUMBER', min: 0, max: 1 },
    },
  },
  slatsLevel: {
    title: 'SlatsLevel',
    attributes: {
      slatsLevel: { valueType: 'NUMBER', min: 0, max: 1 },
    },
  },
  smokeAlarm: {
    title: 'SmokeAlarm',
    attributes: {
      smokeAlarm: { valueType: 'BOOLEAN' },
    },
  },
  storm: {
    title: 'Storm',
    attributes: {
      storm: { valueType: 'BOOLEAN' },
    },
  },
  sunshine: {
    title: 'Sunshine',
    attributes: {
      sunshine: { valueType: 'BOOLEAN' },
    },
  },
  sunshineDuration: {
    title: 'SunshineDuration',
    attributes: {
      sunshineDuration: { valueType: 'NUMBER', integer: true, min: 0 },
      todaySunshineDuration: { valueType: 'NUMBER', integer: true, min: 0 },
      yesterdaySunshineDuration: { valueType: 'NUMBER', integer: true, min: 0 },
    },
  },
  supplyTemperature: {
    title: 'SupplyTemperature',
    attributes: {
      supplyTemperature: { valueType: 'NUMBER', min: -50, max: 60 },
    },
  },
  switchState: {
    title: 'SwitchState',
    attributes: {
      on: { valueType: 'BOOLEAN' },
    },
  },
  vehicleRange: {
    title: 'VehicleRange',
    attributes: {
      travelRange: { valueType: 'NUMBER', min: 0 },
    },
  },
  waterlevelDetected: {
    title: 'WaterlevelDetected',
    attributes: {
      waterlevelDetected: { valueType: 'BOOLEAN' },
    },
  },
  windDirection: {
    title: 'WindDirection',
    attributes: {
      windDirection: { valueType: 'NUMBER', min: 0, max: 359 },
    },
  },
  windSpeed: {
    title: 'WindSpeed',
    attributes: {
      windSpeed: { valueType: 'NUMBER', min: 0, max: 400 },
    },
  },
};

const DEVICE_TYPE_FEATURES = {
  BATTERY: {
    required: ['batteryState'],
    optional: ['currentPower', 'energyCounter', 'maintenance'],
  },
  CLIMATE_SENSOR: {
    required: [],
    optional: ['actualTemperature', 'co2', 'humidity', 'illumination', 'maintenance', 'rainCount', 'raining', 'storm', 'sunshine', 'sunshineDuration', 'windDirection', 'windSpeed'],
  },
  CONTACT_SENSOR: {
    required: ['contactSensorState'],
    optional: ['maintenance'],
  },
  ENERGY_METER: {
    required: ['currentPower'],
    optional: ['energyCounter', 'maintenance'],
  },
  EV_CHARGER: {
    required: ['currentPower'],
    optional: ['energyCounter', 'maintenance'],
  },
  GRID_CONNECTION_POINT: {
    required: ['currentPower'],
    optional: ['energyCounter', 'maintenance'],
  },
  HEAT_PUMP: {
    required: ['climateOperationMode'],
    optional: ['coolingTemperatureOffset', 'heatingTemperatureOffset', 'hotWaterBoost', 'maintenance', 'presenceMode', 'supplyTemperature'],
  },
  HVAC: {
    required: ['currentPower'],
    optional: ['energyCounter', 'maintenance'],
  },
  INVERTER: {
    required: ['currentPower'],
    optional: ['energyCounter', 'maintenance'],
  },
  LIGHT: {
    required: ['switchState'],
    optional: ['color', 'colorTemperature', 'dimming', 'maintenance', 'onTime'],
  },
  OCCUPANCY_SENSOR: {
    required: ['presenceDetected'],
    optional: ['maintenance'],
  },
  PARTICULATE_MATTER_SENSOR: {
    required: [],
    optional: ['actualTemperature', 'humidity', 'maintenance', 'particulateMassOne', 'particulateMassTen', 'particulateMassTwoPointFive', 'particulateTypicalSize'],
  },
  SMOKE_ALARM: {
    required: ['smokeAlarm'],
    optional: ['maintenance'],
  },
  SWITCH: {
    required: ['switchState'],
    optional: ['maintenance', 'onTime'],
  },
  SWITCH_INPUT: {
    required: [],
    optional: ['maintenance'],
  },
  THERMOSTAT: {
    required: ['setPointTemperature'],
    optional: ['actualTemperature', 'co2', 'humidity', 'maintenance'],
  },
  VEHICLE: {
    required: ['batteryState'],
    optional: ['maintenance', 'vehicleRange'],
  },
  WATER_SENSOR: {
    required: ['waterlevelDetected'],
    optional: ['maintenance', 'moistureDetected'],
  },
  WINDOW_COVERING: {
    required: ['shutterLevel'],
    optional: ['maintenance', 'shutterDirection', 'slatsLevel'],
  },
};

/**
 * Liefert alle wählbaren Ziel-Attribute eines Gerätetyps als flache Liste.
 * Jeder Eintrag ist ein Zuordnungsziel für die Endpunkt-Oberfläche.
 *
 * @param   {string} deviceType – z.B. 'LIGHT'
 * @returns {Array<{id:string, featureType:string, attribute:string, valueType:string,
 *                  required:boolean, min?:number, max?:number, integer?:boolean,
 *                  values?:string[]}>}
 */
function getTargets(deviceType) {
  const spec = DEVICE_TYPE_FEATURES[deviceType];
  if (!spec) return [];

  const targets = [];
  const collect = (featureType, required) => {
    const feature = FEATURE_CATALOG[featureType];
    if (!feature) return;
    for (const [attribute, def] of Object.entries(feature.attributes)) {
      targets.push({
        id:          `${featureType}.${attribute}`,
        featureType,
        attribute,
        valueType:   def.valueType,
        required,
        ...(def.min     !== undefined ? { min: def.min }         : {}),
        ...(def.max     !== undefined ? { max: def.max }         : {}),
        ...(def.integer                ? { integer: true }        : {}),
        ...(def.enumType               ? { values: ENUM_VALUES[def.enumType] } : {}),
      });
    }
  };

  spec.required.forEach((f) => collect(f, true));
  spec.optional.forEach((f) => collect(f, false));
  return targets;
}

/**
 * Sucht ein einzelnes Ziel anhand seiner ID ("featureType.attribute").
 * @param {string} deviceType
 * @param {string} targetId
 */
function getTarget(deviceType, targetId) {
  return getTargets(deviceType).find((t) => t.id === targetId) ?? null;
}

module.exports = { FEATURE_CATALOG, DEVICE_TYPE_FEATURES, ENUM_VALUES, getTargets, getTarget };
