'use strict';

/**
 * Plugin
 *
 * Kernklasse des Plugins. Verwaltet:
 *   • WebSocket-Verbindung zur HCU (inkl. Exponential-Backoff-Reconnect)
 *   • Authentifizierung per Header (authtoken + plugin-id)
 *   • Protokoll-Handshake gemäß Connect API 1.0.1
 *   • Routing eingehender Nachrichten an Handler-Methoden
 *
 * Verbindungsablauf (aus den offiziellen Node.js-Beispielen):
 *   1. WebSocket-Verbindung aufbauen
 *        Header: authtoken, plugin-id
 *   2. Bei „open": sofort PLUGIN_STATE_RESPONSE { READY } senden
 *   3. Auf PLUGIN_STATE_REQUEST → erneut PLUGIN_STATE_RESPONSE { READY }
 *   4. Auf DISCOVER_REQUEST     → DISCOVER_RESPONSE mit Geräteliste
 *   5. Auf CONTROL_REQUEST      → Gerät steuern + CONTROL_RESPONSE
 */

const WebSocket           = require('ws');
const { v4: uuidv4 }      = require('uuid');
const log                 = require('./logger');
const devices             = require('./devices');
const configStore         = require('./configStore');
const devicesStore        = require('./devicesStore');
const { DEVICE_FEATURES } = require('../constants/device_constants.js');


// Reconnect-Einstellungen
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

class Plugin {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId  – Eindeutige Plugin-ID (z.B. de.example.mein-plugin)
   * @param {string} opts.host      – Hostname/IP der HCU
   * @param {string} opts.authtoken – Aktivierungsschlüssel aus der HCU
   */
  constructor({ pluginId, host, authtoken }) {
    this.pluginId  = pluginId;
    this.host      = host;
    this.authtoken = authtoken;

    // Konfiguration beim Start aus config.json laden
    this._config = configStore.load();
    log.info(`Geraete reinkludieren: ${this._config.reincludeDevices ? 'vorhanden' : '[X] noch nicht gesetzt'}`);

    // Geräte beim Start aus devices.json laden
    this._devices = devices.getAll();
    log.info(`Geraeteliste geladen: ${this._devices.DEVICES_FILE ? 'vorhanden' : '[X] noch nicht gesetzt'}`);

    this._ws             = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._stopping       = false;
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  start() {
    this._stopping = false;
    this._connect();
  }

  stop() {
    log.info('Plugin wird beendet...');
    this._stopping = true;
    this._clearReconnect();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  //  WebSocket-Lifecycle
  // ---------------------------------------------------------------------------

  _connect() {
    const url = `wss://${this.host}:9001`;
    log.info(`Verbinde zu ${url} ...`);

    this._ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 10000,
      headers: {
        'authtoken': this.authtoken,
        'plugin-id': this.pluginId,
      },
    });

    this._ws.on('open',    ()           => this._onOpen());
    this._ws.on('message', (data)       => this._onMessage(data));
    this._ws.on('error',   (err)        => this._onError(err));
    this._ws.on('close',   (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    log.info('WebSocket verbunden.');
    this._reconnectDelay = RECONNECT_BASE_MS; // Reset nach Erfolg

    // Pflicht bei Verbindungsaufbau: Plugin als READY melden
    this._sendPluginReady(uuidv4());
  }

  _onMessage(raw) {
    let message;
    try {
      // raw als Buffer behandeln und explizit als UTF-8 dekodieren
      const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      message = JSON.parse(decoded);
    } catch {
      log.warn('Ungueltige JSON-Nachricht empfangen:', raw.toString());
      return;
    }

    log.debug('< HCU:', JSON.stringify(message, null, 2));

    switch (message.type) {
      case 'PLUGIN_STATE_REQUEST':
        // HCU fragt regelmäßig nach dem Plugin-Status
        this._sendPluginReady(message.id);
        break;

      case 'DISCOVER_REQUEST':
        // HCU möchte wissen, welche Geräte das Plugin verwaltet
        this._handleDiscoverRequest(message);
        break;

      case 'CONTROL_REQUEST':
        // HCU möchte ein Gerät steuern
        this._handleControlRequest(message);
        break;

      case 'STATUS_REQUEST':
        // HCU fragt den aktuellen Gerätestatus ab
        this._handleStatusRequest(message);
        break;

      case 'CONFIG_TEMPLATE_REQUEST':
        // HCU fragt nach konfigurierbaren Einstellungen des Plugins
        this._handleConfigTemplateRequest(message);
        break;

      case 'CONFIG_UPDATE_REQUEST':
        // Benutzer hat Konfiguration in der HCU-Oberfläche gespeichert
        this._handleConfigUpdateRequest(message);
        break;

      default:
        log.debug(`Unbekannter Nachrichtentyp: "${message.type}"`);
    }
  }

  _onError(err) {
    log.error('WebSocket-Fehler:', err.code ?? '', err.message ?? err);
  }

  _onClose(code, reason) {
    const r = reason ? reason.toString() : '>';
    log.warn(`WebSocket getrennt (Code: ${code}, Grund: ${r})`);

    if (!this._stopping) {
      this._scheduleReconnect();
    }
  }

  // ---------------------------------------------------------------------------
  //  Ausgehende Nachrichten
  // ---------------------------------------------------------------------------

  _send(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      log.warn('_send() aufgerufen, aber WebSocket ist nicht offen.');
      return;
    }
    const payload = JSON.stringify(message);
    log.debug('> HCU:', payload);
    this._ws.send(payload);
  }

  /**
   * PLUGIN_STATE_RESPONSE – teilt der HCU mit, dass das Plugin betriebsbereit ist.
   * Muss beim Verbindungsaufbau und auf jeden PLUGIN_STATE_REQUEST gesendet werden.
   */
  _sendPluginReady(messageId) {
    const message = {
      id:       messageId,
      pluginId: this.pluginId,
      type:     'PLUGIN_STATE_RESPONSE',
      body: {
        pluginReadinessStatus: 'READY',
      },
    };
    log.info('Sende PLUGIN_STATE_RESPONSE { READY }');
    this._send(message);
  }

  // ---------------------------------------------------------------------------
  //  Request-Handler
  // ---------------------------------------------------------------------------

  /**
   * DISCOVER_REQUEST → DISCOVER_RESPONSE
   * Die HCU fragt, welche Drittanbieter-Geräte das Plugin kennt.
   */
  _handleDiscoverRequest(message) {
    log.info('DISCOVER_REQUEST empfangen > sende Geraeteliste.');
    this._sendDiscoverResponse(message.id);
  }

  /**
   * CONTROL_REQUEST → Gerät steuern → CONTROL_RESPONSE
   * Die HCU möchte den Zustand eines Geräts ändern.
   */
  _handleControlRequest(message) {
    const { deviceId, features } = message.body ?? {};
    log.info(`CONTROL_REQUEST fuer Geraet: ${deviceId}`, features);

    // Hier eigene Steuerlogik eintragen (HTTP-Call, MQTT, Serial, …)
    const success = devices.control(deviceId, features);

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONTROL_RESPONSE',
      body: {
        deviceId,
        success,
      },
    };
    this._send(response);
  }

  /**
   * STATUS_REQUEST → aktuellen Gerätestatus liefern
   */
  _handleStatusRequest(message) {
    const { deviceId } = message.body ?? {};
    log.info(`STATUS_REQUEST für Geraet: ${deviceId}`);

    const device  = devices.getById(deviceId);
    const success = device != null;

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'STATUS_RESPONSE',
      body: {
        success,
        devices: success ? [device] : [],
      },
    };
    this._send(response);
  }

  /**
   * CONFIG_TEMPLATE_REQUEST → Konfigurationsvorlage liefern
   *
   * Hier werden die Felder definiert, die der Benutzer in der
   * HCU-Oberfläche konfigurieren kann (z.B. IP-Adresse, Port, API-Key).
   * Wenn das Plugin keine Konfiguration benötigt, wird eine leere
   * Parameterliste zurückgegeben.
   */
  _handleConfigTemplateRequest(message) {
    log.info('CONFIG_TEMPLATE_REQUEST empfangen > sende Konfigurationsvorlage.');
    const devicesLength = devices.getDevicesLength();

    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: { 
        groups: this._generateSettingsGroups(devicesLength),
        properties: this._defineVariableFields(devices.getAll()),
      },
    };
    this._send(response);
  }

  /**
   * CONFIG_UPDATE_REQUEST > neue Konfiguration entgegennehmen
   *
   * Wird aufgerufen wenn der Benutzer in der HCU-Oberfläche
   * die Konfiguration gespeichert hat.
   */
  _handleConfigUpdateRequest(message) {
    const { properties } = message.body ?? {};
    const newName = devices.sanitize(properties?.new_variable);
    const newType = properties?.new_variable_type;
    const deviceList = devices.getAll();
    const VALID_TYPES = Object.keys(DEVICE_FEATURES);
    log.info('CONFIG_UPDATE_REQUEST empfangen:', properties);
 
    // Properties kommen als flaches Objekt: { reincludeDevices: 'wert', ... }
    const reincludeDevices = properties?.reincludeDevices;
 
    if (reincludeDevices !== undefined) {
      this._config.reincludeDevices = reincludeDevices;
      configStore.save(this._config);
    }
 
    // Felder aus Einstellungsseite abarbeiten und Geräte speichern, updaten oder löschen
    deviceList.forEach((device, index) => {
      const num    = index + 1;
      const prefix = `variable_${num}`;
 
      const name = devices.sanitize(properties[prefix]);
      const type  = properties[`${prefix}_type`];
      const state = properties[`${prefix}_state`];
      const featureDef = devices.getFeatureDef(device.deviceType);
 
      // Feld nicht in Properties > überspringen
      if (name === undefined) return;
 
      if (name === '') {
        // Gerät löschen wenn friendlyName leer
        devicesStore.remove(device.deviceId);
        log.info(`Geraet "${device.deviceId}" geloescht (friendlyName leer).`);
      } else {
        // Gerät updaten
        const updated = {
          ...device,
          friendlyName: name,
          deviceType:   type ?? device.deviceType,
          features: device.features.map(f => {
            if (!featureDef?.stateKey) return f;

            // Prüfen ob dieses Feature den stateKey enthält
            if (f[featureDef.stateKey] === undefined) return f;

            // Wert korrekt casten, je nach stateType
            let castValue = state;
            if (featureDef.stateType === 'BOOLEAN') {
              castValue = state === true || state === 'true';
            } else if (featureDef.stateType === 'NUMBER') {
              const parsed = parseFloat(state);
              const min = featureDef.stateMin ?? -Infinity;
              const max = featureDef.stateMax ?? Infinity;
              castValue = isNaN(parsed) ? 0 : Math.min(max, Math.max(min, parsed));
            }

            return { ...f, [featureDef.stateKey]: castValue };
          }),
        };
        devicesStore.update(device.deviceId, updated);
        log.info(`Geraet "${device.deviceId}" aktualisiert.`);

        // HCU über Zustandsänderung informieren
        this._send({
          id:       uuidv4(),
          pluginId: this.pluginId,
          type:     'STATUS_EVENT',
          body: {
            deviceId: device.deviceId,
            features: updated.features,
          },
        });
      }
    });
 
    // Neues Gerät erstellen
    if (newName && newType && VALID_TYPES.includes(newType)) {
      const newDevice = devices.createDevice(newName, newType, deviceList);
      devicesStore.update(newDevice.deviceId, newDevice);
      log.info(`Neues Geraet erstellt: ${newDevice.deviceId}`);

      // DISCOVER_RESPONSE senden damit das Gerät sofort in der HCU erscheint
      devices.reload();
      this._sendDiscoverResponse();
    }
 
    // Aktualisierte Geräteliste neu laden
    devices.reload();
 
    const response = {
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_UPDATE_RESPONSE',
      body: {
        status: 'APPLIED',
      },
    };
    this._send(response);
  }

  /**
   * Sendet eine DISCOVER_RESPONSE an die HCU, um neue Geräte zu melden
   */
  _sendDiscoverResponse(messageId = null) {
    const id = messageId ?? uuidv4();
    const allDevices = devices.getAll();
    const devicesToReport = this._config.reincludeDevices
      ? allDevices
      : allDevices.filter(d => !d.alreadyIncluded);

    const message = {
      id:       id,  // neue ID nötig, da kein Request vorausging
      pluginId: this.pluginId,
      type:     'DISCOVER_RESPONSE',
      body: {
        success: true,
        devices: devicesToReport,
      },
    };

    this._send(message);
    devicesStore.markAsIncluded(devicesToReport.map(d => d.deviceId));
    devices.reload();
    log.info(`DISCOVER_RESPONSE gesendet mit ${devicesToReport.length} Geraet(en).`);
  }

  /**
   * Generiert alle Einstellungsgruppen
   * Benötigt für _handleConfigTemplateRequest
   * @param   {Array} varCount Anzahl aller Geräte der Liste aus devices.json
   * @returns {object} Gruppenobjekt { groups: general, ... }
   */
  _generateSettingsGroups(varCount) {
    const groups = {
        // Gruppe für Allgemeine Einstellungen des Plugins
        general: {
          friendlyName: 'Allgemein',
          description:  'Allgemeine Plugin-Einstellungen',
          order:        1,
        },
      };

      // Existierende Geräte durchgehen und Gruppen dafür generieren
      for(let i = 0; i < varCount; i++) {
        let num = i + 1;
        groups[`variable_${num}`] = {
          friendlyName: `Variable ${num}`,
          description:  'Konfiguriere hier die Variable',
          order:        2 + i,
        };
      }

      groups['new_variable'] = {
        friendlyName: 'Neue Variable',
        description:  'Definiere hier deine neuen Variablen',
        order:        varCount + 2,
      };

      return groups;
  }

  /**
   * Liest die devices.json und erstellt für jede ein Menüfeld.
   * Benötigt für _handleConfigTemplateRequest
   * @param   {Array} devices Alle Geräte der Liste aus devices.json
   * @returns {object} Geräteobjekt { deviceId: deviceObject, ... }
   */
  _defineVariableFields(deviceList) {
    const DEVICE_TYPES = [
      "LIGHT", "BATTERY", "CLIMATE_SENSOR", "CONTACT_SENSOR",
      "ENERGY_METER", "EV_CHARGER", "GRID_CONNECTION_POINT", "HEAT_PUMP",
      "HVAC", "INVERTER", "OCCUPANCY_SENSOR", "PARTICULATE_MATTER_SENSOR",
      "SMOKE_ALARM", "SWITCH", "SWITCH_INPUT", "THERMOSTAT",
      "VEHICLE", "WATER_SENSOR", "WINDOW_COVERING"
    ];
    
    const deviceListLength = deviceList.length + 1;

    // Hier werden alle Einstellungen definiert, die nichts mit Variablen zu tun haben
    const properties = {
      reincludeDevices: {
            friendlyName:  'Alte Geräte zwischenspeichern',
            description:   'Aus der HCU gelöschte Geräte bleiben im Plugin erhalten und werden beim nächsten Speichern wieder hinzugefügt.',
            dataType:      'BOOLEAN',
            required:      'false',
            groupId:       'general',
            order:         1,
            defaultValue: 'false',
            currentValue:  this._config.reincludeDevices || 'false',
          },
      };

    // Dynamisch Variablen-Sektionen erstellen
    deviceList.forEach((device, index) => {
      const num      = index + 1;
      const orderBase = index * 3;

      // Gerätename
      properties[`variable_${num}`] = {
        friendlyName:  `Variablenname`,
        description:   `Definiere hier einen Variablennamen für Variable ${num}. Bitte Umlaute und ß vermeiden!`,
        dataType:      'STRING',
        required:      'false',
        groupId:       `variable_${num}`,
        order:         orderBase + 1,
        minimumLength: 0,
        maximumLength: 255,
        currentValue:  device["friendlyName"] || '',
      };

      // Geräte-ID
      properties[`variable_${num}_id`] = {
        friendlyName: `Interne Geräte-ID`,
        description:  'Diese ID wird zur Identifizierung des Geräts verwendet und kann nicht geändert werden.',
        dataType:     'READONLY',
        groupId:      `variable_${num}`,
        order:        orderBase + 2,
        currentValue: device.deviceId,
      };

      // Geräteart
      properties[`variable_${num}_type`] = {
        friendlyName: `Variable ${num}: Geräteart`,
        description:  `Die Geräteart von Variable ${num}. Kann nachträglich nicht geändert werden.`,
        dataType:     'READONLY',
        required:     'true',
        groupId:      `variable_${num}`,
        order:        orderBase + 3,
        defaultValue: 'LIGHT',
        currentValue: device.deviceType || 'LIGHT',
      };

      // Aktueller Status
      const featureDef = devices.getFeatureDef(device.deviceType);

      if (featureDef?.stateType) {
        log.info(`Variable ${num}: stateType=${featureDef.stateType}, stateKey=${featureDef.stateKey}, currentValue=${device.features?.find(f => f[featureDef.stateKey] !== undefined)?.[featureDef.stateKey]}`);
        const featureName = featureDef.stateKey ? featureDef.stateKey : "Status" ;

        const stateProp = {
          friendlyName: `Variable ${num}: Aktueller Status von "${featureName}"`,
          description:  `Definiere hier den  aktuellen Status für Variable ${num}.`,
          dataType:     featureDef.stateType,
          required:     'false',
          groupId:      `variable_${num}`,
          order:        orderBase + 4,
          currentValue: device.features
            ?.find(f => f[featureDef.stateKey] !== undefined)
            ?.[featureDef.stateKey] ?? '',
        };

        if (featureDef.stateValues) stateProp.values   = featureDef.stateValues;
        if (featureDef.stateMin !== null) stateProp.minimum = featureDef.stateMin;
        if (featureDef.stateMax !== null) stateProp.maximum = featureDef.stateMax;

        properties[`variable_${num}_state`] = stateProp;
      }
    });

    // Leeres Feld am Ende ergänzen (Neue Variable)
    let orderBaseLast = deviceListLength * 3;

    // Gerätename
    properties[`new_variable`] = {
        friendlyName:  `Neue Variable: Variablenname`,
        description:   `Definiere hier einen Variablennamen für Variable ${deviceListLength}. Speichern, um weitere hinzuzufügen. Bitte Umlaute und ß vermeiden!`,
        dataType:      'STRING',
        required:      'false',
        groupId:       'new_variable',
        order:         orderBaseLast + 1,
        minimumLength: 0,
        maximumLength: 255,
        currentValue:  '',
      };

      // Geräteart
      properties[`new_variable_type`] = {
        friendlyName: `Neue Variable: Geräteart`,
        description:  `Definiere hier eine Geräteart für Variable ${deviceListLength}.`,
        dataType:     'ENUM',
        required:     'false',
        groupId:      'new_variable',
        order:        orderBaseLast + 2,
        values:       DEVICE_TYPES,
        defaultValue: 'LIGHT',
        currentValue: 'LIGHT',
      };

    return properties;
  }

  // ---------------------------------------------------------------------------
  //  Reconnect mit Exponential Backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    log.info(`Wiederverbindung in ${this._reconnectDelay / 1000}s ...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);

    this._reconnectDelay = Math.min(
      Math.round(this._reconnectDelay * RECONNECT_FACTOR),
      RECONNECT_MAX_MS,
    );
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = Plugin;