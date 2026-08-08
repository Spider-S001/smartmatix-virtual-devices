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

const WebSocket            = require('ws');
const fs                   = require('fs');
const { v4: uuidv4 }       = require('uuid');
const log                  = require('./logger');
const devices              = require('./devices');
const configStore          = require('./configStore');
const devicesStore         = require('./devicesStore');
const { DEVICE_FEATURES }  = require('../constants/device_constants.js');
const { HcuPluginUpdater } = require('./hcu-plugin-updater');
const backup               = require('./backup-plugin-data');
const dataEndpoint         = require('./dataEndpoint');
const mappings             = require('./mappings');
const outbound             = require('./outbound');
const calendarScheduler    = require('./calendarScheduler');
const { t, availableLanguages } = require('./localization');


// Reconnect-Einstellungen
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

// Update-Check (hcu-plugin-updater)
const REPO_URL    = 'https://github.com/Spider-S001/smartmatix-virtual-devices';
const PLUGIN_NAME = 'SmartMatix Virtual Devices';

// Port des temporären Backup-/Restore-Webservers.
const BACKUP_PORT = 8744;

// Port des dauerhaften Endpunkt-Webservers (dataEndpoint.js).
const ENDPOINT_PORT = 8745;

// Sortierposition der Backup-Gruppe im Einstellungsmenü
const BACKUP_GROUP_ORDER = 997;

// Abstand der Sortiernummern zwischen zwei Variablen-Gruppen.
const VARIABLE_ORDER_STEP = 10;



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

    // Sprache der HCU-Oberfläche; wird aus CONFIG_TEMPLATE_REQUEST /
    // CONFIG_UPDATE_REQUEST aktualisiert (body.languageCode).
    this._lang = 'de';

    // Update-Checker
    this._updater = null;

    // Backup-/Restore-Manager (backup-plugin-data).
    this._backupManager = backup.create({
      pluginId: this.pluginId,
      port:     BACKUP_PORT,
    });

    // Hostname der HCU für die in den Backup-/Restore-Links verwendeten URLs.
    // Auf der HCU steht die SGTIN unter /SGTIN bereit > hcu1-XXXX.local,
    // ansonsten (lokale Entwicklung) Fallback auf localhost.
    try {
      const sgtin = fs.readFileSync('/SGTIN', 'utf8').trim();
      this._backupHost = `hcu1-${sgtin.slice(-4)}.local`;
    } catch {
      this._backupHost = 'localhost';
    }
    log.info(`Backup-/Restore-Host: ${this._backupHost}:${BACKUP_PORT}`);

    // Daten-Endpunkte der virtuellen Geraete (dataEndpoint.js).
    // Der Webserver startet erst, sobald mindestens ein Geraet einen
    // aktiven Endpunkt besitzt.
    this._endpointManager = dataEndpoint.create({
      pluginId:      this.pluginId,
      hostname:      this._backupHost,
      port:          ENDPOINT_PORT,
      getDeviceById: (deviceId) => devices.getById(deviceId),
      getTargets:    (deviceType) => mappings.getTargets(deviceType),
      getRules:      (deviceId) => mappings.getRules(deviceId),
      saveRules:     (deviceId, rules, lang) => this._saveMappingRules(deviceId, rules, lang),
      getOutbound:   (deviceId) => mappings.getOutboundCalls(deviceId),
      saveOutbound:  (deviceId, rules, lang) => this._saveOutboundRules(deviceId, rules, lang),
      testOutbound:  (deviceId, rules, lang) => this._testOutboundRules(deviceId, rules, lang),
      getCalendar:    (deviceId) => mappings.getCalendar(deviceId),
      saveCalendar:   (deviceId, config, lang) => this._saveCalendar(deviceId, config, lang),
      fetchCalendar:  (deviceId, lang) => this._fetchCalendar(deviceId, lang),
      calendarStatus: (deviceId) => this._calendar.status(deviceId),
      rotatePassword: (deviceId, lang) => this._rotateEndpointPassword(deviceId, lang),
      applyData:     (deviceId, incoming) => this._applyIncomingData(deviceId, incoming),
      logger:        log,
    });

    // Kalendersteuerung. Liest und schreibt Werte ueber dieselben Wege wie die
    // uebrige Logik, damit Persistenz und STATUS_EVENT einheitlich bleiben.
    this._calendar = calendarScheduler.create({
      getDevices: () => devices.getAll(),
      getConfig:  (deviceId) => mappings.getCalendar(deviceId),
      readValue:  (deviceId, target) => this._readAttribute(deviceId, target),
      writeValue: (deviceId, target, value) => this._writeAttribute(deviceId, target, value),
      logger:     log,
    });

    this._syncEndpoints();
    this._calendar.start();
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
    // Automatischen Update-Check beenden
    this._updater?.stopSchedule();
    // Endpunkt-Webserver schliessen
    this._endpointManager?.stop('Plugin beendet');
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

    // Update-Checker starten
    if (!this._updater) {
      this._updater = new HcuPluginUpdater(this._ws, this.pluginId, { language: this._lang });
      this._updater.startSchedule(REPO_URL, PLUGIN_NAME);
    }

    // Pflicht bei Verbindungsaufbau: Plugin als READY melden
    this._sendPluginReady(uuidv4());

    // Zustände aller Geräte an HCU übertragen
    this._sendAllStatusEvents();
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

    // Zustand vor der Aenderung sichern; devices.control() aendert die
    // Feature-Objekte an Ort und Stelle, daher eine echte Kopie anlegen.
    const before = JSON.parse(JSON.stringify(devices.getById(deviceId)?.features ?? []));

    const success = devices.control(deviceId, features);

    if (success) {
      // Aktualisierten Zustand in devices.json speichern
      const updatedDevice = devices.getById(deviceId);
      if (updatedDevice) {
        devicesStore.update(deviceId, updatedDevice);
        log.info(`Zustand von "${deviceId}" in devices.json gespeichert.`);
        // Aenderung kam von der HCU > ausgehende Aufrufe ausloesen
        this._fireOutbound(deviceId, before, updatedDevice.features);
      }
    }

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
        // Interne Felder (u.a. Endpunkt-Zugangsdaten) entfernen
        devices: success ? [devices.toHcuDevice(device)] : [],
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

    // Sprache der HCU-Oberflaeche uebernehmen (ISO 639-1)
    this._readLanguage(message);

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
    log.info('CONFIG_UPDATE_REQUEST empfangen:', properties);

    // Sprache der HCU-Oberflaeche uebernehmen (ISO 639-1)
    this._readLanguage(message);

    // --- Backup / Restore ---
    if (this._handleBackupRestoreUpdate(message, properties)) return;

    const newName = devices.sanitize(properties?.new_variable);
    const newType = properties?.new_variable_type;
    const deviceList = devices.getAll();
    const VALID_TYPES = Object.keys(DEVICE_FEATURES);
 
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
      const endpoint = properties[`${prefix}_endpoint`];
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
          ...this._resolveEndpointFields(device, endpoint),
          friendlyName: name,
          deviceType:   type ?? device.deviceType,
          features: device.features.map(f => {
            if (!featureDef?.stateKey) return f;

            // Prüfen ob dieses Feature den stateKey enthält
            if (f[featureDef.stateKey] === undefined) return f;

            // Feld nicht im Request > Wert unveraendert lassen.
            // Ohne diese Pruefung wuerde parseFloat(undefined) zu NaN und der
            // Wert auf 0 fallen, bei BOOLEAN auf false – ein per Kalender oder
            // Endpunkt gesetzter Wert ginge beim Speichern verloren.
            if (state === undefined) return f;

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

        // Aenderung kam aus dem Einstellungsmenue > ausgehende Aufrufe ausloesen
        this._fireOutbound(device.deviceId, device.features, updated.features);

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

    // Endpunkte an den geänderten Gerätebestand angleichen (startet bzw.
    // stoppt den Webserver) und die Einstellungsseite neu pushen, damit
    // Passwort und Link ohne manuelles Neuladen erscheinen.
    this._syncEndpoints();
    this._pushConfigTemplate();

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
        // Interne Felder (u.a. Endpunkt-Zugangsdaten) entfernen
        devices: devices.toHcuDevices(devicesToReport),
      },
    };

    this._send(message);
    devicesStore.markAsIncluded(devicesToReport.map(d => d.deviceId));
    devices.reload();
    log.info(`DISCOVER_RESPONSE gesendet mit ${devicesToReport.length} Geraet(en).`);
  }

  // ---------------------------------------------------------------------------
  //  Backup / Restore
  // ---------------------------------------------------------------------------

  /**
   * Übersetzt einen Schlüssel und ersetzt Platzhalter der Form {name}.
   * @param {string} key    – Schlüssel aus lang/localization.json
   * @param {object} [vars] – Werte für die Platzhalter
   */
  _t(key, vars = {}) {
    return Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      t(this._lang, key));
  }

  /**
   * Übernimmt den von der HCU gelieferten Sprachcode (ISO 639-1).
   * Die Connect API 1.0.1 sendet ihn als body.languageCode; ältere
   * Firmware-Stände verwenden teilweise body.language.
   * @param {object} message – eingegangene HCU-Nachricht
   */
  _readLanguage(message) {
    const lang = message?.body?.languageCode ?? message?.body?.language;
    if (lang && typeof lang === 'string') {
      this._lang = lang.toLowerCase().slice(0, 2);
      log.debug(`Sprache aus Request uebernommen: ${this._lang}`);
    }
  }

  /**
   * Wertet das Dropdown "backup_restore_action" aus einem CONFIG_UPDATE_REQUEST
   * aus und startet bei Bedarf eine Backup- oder Restore-Sitzung.
   *
   * Damit die Auswahl unabhängig von der eingestellten Sprache funktioniert,
   * wird der übermittelte Anzeigetext gegen alle bekannten Übersetzungen
   * geprüft.
   *
   * @param   {object}  message    – eingegangene HCU-Nachricht
   * @param   {object}  properties – body.properties des Requests
   * @returns {boolean} true wenn eine Sitzung gestartet und bereits geantwortet wurde
   */
  _handleBackupRestoreUpdate(message, properties) {
    const actionValue = properties?.backup_restore_action;
    if (actionValue === undefined || actionValue === null) return false;

    // Anzeigetext in allen verfuegbaren Sprachen gegen die Aktionen pruefen,
    // damit die Auswahl unabhaengig von der eingestellten Sprache funktioniert.
    const matches = (key) =>
      availableLanguages().some((lang) => t(lang, key) === actionValue);

    const fields = {};
    if (matches('settings.backup_restore.action.backup')) {
      fields.backupMode = true;
    } else if (matches('settings.backup_restore.action.restore')) {
      fields.restoreMode = true;
    }

    if (!this._backupManager.handleConfigUpdate(fields)) return false;

    log.info(`Backup-/Restore-Sitzung gestartet (${fields.backupMode ? 'Backup' : 'Restore'}).`);

    // Einstellungsseite neu pushen, damit Token bzw. Download-Link erscheinen,
    // und die Antwort sofort senden.
    this._pushConfigTemplate();
    this._send({
      id:       message.id,
      pluginId: this.pluginId,
      type:     'CONFIG_UPDATE_RESPONSE',
      body:     { status: 'APPLIED' },
    });
    return true;
  }

  /**
   * Sendet eine unaufgeforderte CONFIG_TEMPLATE_RESPONSE an die HCU.
   *
   * Wird aufgerufen nachdem eine Backup- oder Restore-Sitzung gestartet wurde,
   * damit der Download-Link bzw. der Sicherheits-Token in der Einstellungsseite
   * erscheint, ohne dass der Benutzer sie manuell neu laden muss.
   *
   * Schlägt lautlos fehl wenn die Verbindung nicht offen ist.
   */
  _pushConfigTemplate() {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    log.info('Sende proaktive CONFIG_TEMPLATE_RESPONSE (Backup/Restore).');
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'CONFIG_TEMPLATE_RESPONSE',
      body: {
        groups:     this._generateSettingsGroups(devices.getDevicesLength()),
        properties: this._defineVariableFields(devices.getAll()),
      },
    });
  }

  /**
   * Ermittelt den aktuellen Zustand des Backup-Managers.
   *
   * getConfigGroups() liefert für einen laufenden Modus andere Felder als die
   * Standard-Checkbox (BOOLEAN) – daran lässt sich erkennen, welcher Modus
   * gerade aktiv ist.
   *
   * @returns {{ backupGroup: object, restoreGroup: object, backupActive: boolean, restoreActive: boolean }}
   */
  _getBackupState() {
    const [backupGroup, restoreGroup] = this._backupManager.getConfigGroups();
    return {
      backupGroup,
      restoreGroup,
      backupActive:  backupGroup.fields.some(f => f.type !== 'BOOLEAN'),
      restoreActive: restoreGroup.fields.some(f => f.type !== 'BOOLEAN'),
    };
  }

  /**
   * Ersetzt die Platzhalter {{hostname}} und {{lang}} in Texten und URLs
   * der Backup-Bibliothek.
   * @param   {string|object} value – String oder { de, en }-Objekt
   * @returns {string}
   */
  _resolveBackupText(value) {
    const raw = (typeof value === 'object' ? value?.[this._lang] ?? value?.de ?? value?.en : value) ?? '';
    return String(raw)
      .replace(/\{\{hostname\}\}/g, this._backupHost)
      .replace(/\{\{lang\}\}/g,     this._lang);
  }

  /**
   * Ergänzt das übergebene Properties-Objekt um die Felder der Gruppe
   * "backup_restore":
   *   • kein Modus aktiv > Dropdown zur Auswahl der Aktion
   *   • Modus aktiv      > Token (readOnly) und/oder Link-Button
   *
   * @param {object} properties – Properties-Objekt für CONFIG_TEMPLATE_RESPONSE
   */
  _addBackupRestoreFields(properties) {
    const { backupGroup, restoreGroup, backupActive, restoreActive } = this._getBackupState();

    if (!backupActive && !restoreActive) {
      // Kein Modus aktiv: Dropdown zur Auswahl der Aktion.
      properties.backup_restore_action = {
        friendlyName: this._t('settings.backup_restore.action.label'),
        description:  this._t('settings.backup_restore.action.description'),
        dataType:     'ENUM',
        required:     'false',
        groupId:      'backup_restore',
        order:        1,
        defaultValue: this._t('settings.backup_restore.action.disabled'),
        currentValue: this._t('settings.backup_restore.action.disabled'),
        values: [
          this._t('settings.backup_restore.action.disabled'),
          this._t('settings.backup_restore.action.backup'),
          this._t('settings.backup_restore.action.restore'),
        ],
      };
      return;
    }

    // Ein Modus laeuft: die aktiven Felder (Token, Link) dieser Gruppe anzeigen.
    const activeFields = backupActive ? backupGroup.fields : restoreGroup.fields;

    activeFields.forEach((field, i) => {
      if (field.type === 'LABEL') return;

      if (field.type === 'LINK') {
        const label = this._resolveBackupText(field.buttonLabel) || this._resolveBackupText(field.label);
        properties[`backup_restore_${field.id}`] = {
          friendlyName: label,
          description:  this._resolveBackupText(field.label),
          dataType:     'WEBLINK',
          groupId:      'backup_restore',
          order:        i + 2,
          // Bei WEBLINK enthaelt currentValue den Link und defaultValue den Infotext
          defaultValue: label,
          currentValue: this._resolveBackupText(field.url),
        };
        return;
      }

      // STRING-Feld
      const value = this._resolveBackupText(field.value);
      properties[`backup_restore_${field.id}`] = {
        friendlyName: this._resolveBackupText(field.label),
        description:  '',
        dataType:     field.readOnly ? 'READONLY' : 'STRING',
        groupId:      'backup_restore',
        order:        i + 2,
        defaultValue: value,
        currentValue: value,
      };
    });
  }

  // ---------------------------------------------------------------------------
  //  Daten-Endpunkte
  // ---------------------------------------------------------------------------

  /**
   * Übergibt die aktuelle Geräteliste an den Endpunkt-Manager.
   * Startet oder stoppt dadurch den Webserver.
   */
  _syncEndpoints() {
    try {
      const all    = devices.getAll();
      const active = this._endpointManager.sync(all);
      // Regeln gelöschter Geräte mitentfernen
      mappings.pruneRules(all.map((d) => d.deviceId));
      this._calendar?.prune(all.map((d) => d.deviceId));
      log.info(`Aktive Daten-Endpunkte: ${active}`);
    } catch (err) {
      log.error('Endpunkte konnten nicht synchronisiert werden:', err.message);
    }
  }

  /**
   * Prüft und speichert die Zuordnungsregeln eines Geräts.
   *
   * Zeigt eine Regel auf ein optionales Attribut, das das Gerät noch nicht
   * besitzt, wird das zugehörige Feature dauerhaft in das Gerät übernommen und
   * der HCU neu gemeldet.
   *
   * @param   {string} deviceId
   * @param   {Array}  rules  – Regeln aus der Oberfläche
   * @param   {string} [lang] – Sprache der Fehlermeldungen
   * @returns {{ ok: boolean, rules?: Array, errors?: string[] }}
   */
  _saveMappingRules(deviceId, rules, lang = this._lang) {
    const device = devices.getById(deviceId);
    if (!device) return { ok: false, errors: [t(lang, 'mapping.error.deviceGone')] };

    const { rules: clean, errors } = mappings.validateRules(rules, device.deviceType, lang);
    if (errors.length > 0) return { ok: false, errors };

    if (!mappings.setRules(deviceId, clean)) {
      return { ok: false, errors: [t(lang, 'mapping.error.saveFailed')] };
    }

    // Fehlende Features anlegen, damit die Ziele der Regeln tatsächlich existieren
    const needed = new Set(clean.map((r) => r.target.split('.')[0]));
    this._ensureFeatures(deviceId, needed);

    return { ok: true, rules: clean };
  }

  /**
   * Stellt sicher, dass ein Gerät die angegebenen Features besitzt.
   * Neu angelegte Features erhalten die Standardwerte aus dem Katalog
   * (false bei BOOLEAN, Minimum bzw. 0 bei NUMBER, erster Wert bei ENUM).
   *
   * @param {string}      deviceId
   * @param {Set<string>} featureTypes
   */
  _ensureFeatures(deviceId, featureTypes) {
    const device = devices.getById(deviceId);
    if (!device) return;

    const existing = new Set((device.features ?? []).map((f) => f.type));
    const missing  = [...featureTypes].filter((t) => !existing.has(t));
    if (missing.length === 0) return;

    const targets = mappings.getTargets(device.deviceType);
    const added   = [];

    for (const featureType of missing) {
      const attrs = targets.filter((t) => t.featureType === featureType);
      if (attrs.length === 0) continue;

      const feature = { type: featureType };
      for (const attr of attrs) {
        if (attr.valueType === 'BOOLEAN')      feature[attr.attribute] = false;
        else if (attr.valueType === 'ENUM')    feature[attr.attribute] = attr.values?.[0] ?? null;
        else                                   feature[attr.attribute] = attr.min ?? 0;
      }
      added.push(feature);
    }

    if (added.length === 0) return;

    const updated = { ...device, features: [...(device.features ?? []), ...added] };
    devicesStore.update(deviceId, updated);
    devices.reload();
    log.info(`Feature(s) ${added.map((f) => f.type).join(', ')} zu "${deviceId}" hinzugefuegt.`);

    // Der HCU den erweiterten Funktionsumfang mitteilen
    this._sendDiscoverResponse();
    this._sendStatusEvent(devices.getById(deviceId));
  }

  /**
   * Liest den aktuellen Wert eines Attributs.
   *
   * @param   {string} deviceId
   * @param   {string} targetId – "featureType.attribute"
   * @returns {*} Wert, ersatzweise der Vorgabewert aus dem Katalog
   */
  _readAttribute(deviceId, targetId) {
    const device = devices.getById(deviceId);
    if (!device) return null;

    const [featureType, attribute] = String(targetId).split('.');
    const feature = (device.features ?? []).find((f) => f.type === featureType);
    if (feature && feature[attribute] !== undefined) return feature[attribute];

    return this._defaultValueOf(device.deviceType, targetId);
  }

  /**
   * Schreibt ein Attribut, speichert das Gerät und meldet den neuen Zustand
   * an die HCU.
   *
   * Ausgehende Aufrufe werden hier bewusst nicht ausgeloest: die Aenderung
   * kommt vom Kalender, nicht von der HCU-Seite.
   *
   * @param {string} deviceId
   * @param {string} targetId
   * @param {*}      value
   */
  _writeAttribute(deviceId, targetId, value) {
    const device = devices.getById(deviceId);
    if (!device) return;

    const [featureType, attribute] = String(targetId).split('.');
    const features = (device.features ?? []).map((f) => ({ ...f }));

    let feature = features.find((f) => f.type === featureType);
    if (!feature) {
      feature = { type: featureType };
      features.push(feature);
    }
    feature[attribute] = value;

    devicesStore.update(deviceId, { ...device, features });
    devices.reload();
    this._sendStatusEvent(devices.getById(deviceId));
  }

  /**
   * Erzeugt ein neues Passwort für den Daten-Endpunkt eines Geräts.
   *
   * Die Endpunkt-Kennung bleibt unverändert, damit die Adresse stabil bleibt.
   * Nur das Passwort wird ersetzt; die Anlieferungsadresse ändert sich damit
   * ebenfalls, weil sie das Passwort enthält.
   *
   * @param   {string} deviceId
   * @param   {string} [lang]
   * @returns {{ ok: boolean, password?: string, errors?: string[] }}
   */
  _rotateEndpointPassword(deviceId, lang = this._lang) {
    const device = devices.getById(deviceId);
    if (!device) return { ok: false, errors: [t(lang, 'mapping.error.deviceGone')] };

    const password = dataEndpoint.generatePassword();
    devicesStore.update(deviceId, { ...device, endpointPassword: password });
    devices.reload();

    // Registrierung auffrischen, damit sofort das neue Passwort gilt
    this._syncEndpoints();

    // Einstellungsseite der HCU neu senden, damit dort das neue Passwort steht
    this._pushConfigTemplate();

    log.info(`Neues Endpunkt-Passwort fuer "${deviceId}" erzeugt.`);
    return { ok: true, password };
  }

  /**
   * Prüft und speichert die Kalendereinstellungen eines Geräts.
   *
   * @param   {string} deviceId
   * @param   {object} config
   * @param   {string} [lang]
   * @returns {{ ok: boolean, calendar?: object, errors?: string[] }}
   */
  _saveCalendar(deviceId, config, lang = this._lang) {
    const device = devices.getById(deviceId);
    if (!device) return { ok: false, errors: [t(lang, 'mapping.error.deviceGone')] };

    const { config: clean, errors } = mappings.validateCalendar(config, device.deviceType, lang);
    if (errors.length > 0) return { ok: false, errors };

    if (!mappings.setCalendar(deviceId, clean)) {
      return { ok: false, errors: [t(lang, 'mapping.error.saveFailed')] };
    }

    // Zielattribut anlegen, falls das Geraet es noch nicht besitzt
    if (clean.enabled && clean.target) {
      this._ensureFeatures(deviceId, new Set([clean.target.split('.')[0]]));
    }

    log.info(`Kalendereinstellungen fuer "${deviceId}" gespeichert `
      + `(${clean.enabled ? 'aktiv' : 'inaktiv'}).`);
    return { ok: true, calendar: clean };
  }

  /**
   * Ruft den Kalender eines Geräts sofort ab und wendet ihn an.
   *
   * @param   {string} deviceId
   * @param   {string} [lang]
   * @returns {Promise<{ ok: boolean, count?: number, status?: object, errors?: string[] }>}
   */
  async _fetchCalendar(deviceId, lang = this._lang) {
    const result = await this._calendar.refreshDevice(deviceId);

    if (!result.ok) {
      return { ok: false, errors: [mappings.msg(lang, 'calendar.error.fetchFailed',
        { error: result.error })] };
    }

    // Direkt anwenden, damit ein bereits laufender Termin sofort greift
    await this._calendar.tick();

    return { ok: true, count: result.count, status: this._calendar.status(deviceId) };
  }

  /**
   * Prüft und speichert die ausgehenden Regeln eines Geräts.
   *
   * @param   {string} deviceId
   * @param   {Array}  rules  – Regeln aus der Oberfläche
   * @param   {string} [lang] – Sprache der Fehlermeldungen
   * @returns {{ ok: boolean, rules?: Array, errors?: string[] }}
   */
  _saveOutboundRules(deviceId, calls, lang = this._lang) {
    const device = devices.getById(deviceId);
    if (!device) return { ok: false, errors: [t(lang, 'mapping.error.deviceGone')] };

    const { calls: clean, errors } = mappings.validateOutboundCalls(calls, device.deviceType, lang);
    if (errors.length > 0) return { ok: false, errors };

    if (!mappings.setOutboundCalls(deviceId, clean)) {
      return { ok: false, errors: [t(lang, 'mapping.error.saveFailed')] };
    }

    // Fehlende Features anlegen. Ohne sie kann die HCU das Attribut gar nicht
    // ansteuern, devices.control() verwirft unbekannte Feature-Typen – der
    // Aufruf wuerde also nie ausloesen.
    this._ensureFeatures(deviceId, new Set(
      clean.flatMap((call) => call.rows.map((row) => row.source.split('.')[0]))));

    const rowCount = clean.reduce((sum, call) => sum + call.rows.length, 0);
    log.info(`${clean.length} ausgehende(r) Aufruf(e) mit ${rowCount} Attribut(en) `
      + `fuer "${deviceId}" gespeichert.`);
    return { ok: true, rules: clean };
  }

  /**
   * Ruft alle ausgehenden Adressen einmal probeweise auf.
   *
   * Geprüft werden die übergebenen Regeln, nicht die gespeicherten – so lässt
   * sich eine Adresse ausprobieren, bevor sie festgeschrieben wird. Bei
   * Durchreich-Regeln wird der aktuelle Wert des Geräts gesendet; besitzt das
   * Gerät das Attribut noch nicht, dient der Vorgabewert aus dem Katalog.
   *
   * @param   {string} deviceId
   * @param   {Array}  rules  – Regeln aus der Oberfläche
   * @param   {string} [lang] – Sprache der Fehlermeldungen
   * @returns {Promise<{ ok: boolean, results?: Array, errors?: string[] }>}
   */
  async _testOutboundRules(deviceId, calls, lang = this._lang) {
    const device = devices.getById(deviceId);
    if (!device) return { ok: false, errors: [t(lang, 'mapping.error.deviceGone')] };

    const { calls: clean, errors } = mappings.validateOutboundCalls(calls, device.deviceType, lang);
    if (errors.length > 0) return { ok: false, errors };

    // Werte des Geräts, ergänzt um Vorgaben für noch nicht vorhandene Attribute
    const values = mappings.flattenFeatures(device.features);
    for (const call of clean) {
      for (const row of call.rows) {
        if (values.has(row.source)) continue;
        values.set(row.source, this._defaultValueOf(device.deviceType, row.source));
      }
    }

    const probes = clean.map((call) => mappings.buildCall(call, values));

    log.info(`Teste ${probes.length} ausgehende(n) Aufruf(e) fuer "${deviceId}".`);
    const results = await outbound.probe(probes);

    return { ok: true, results };
  }

  /**
   * Vorgabewert eines Attributs, wenn das Gerät es noch nicht besitzt.
   *
   * @param {string} deviceType
   * @param {string} targetId – "featureType.attribute"
   */
  _defaultValueOf(deviceType, targetId) {
    const target = mappings.getTarget(deviceType, targetId);
    if (!target) return '';
    if (target.valueType === 'BOOLEAN') return false;
    if (target.valueType === 'ENUM')    return target.values?.[0] ?? '';
    return target.min ?? 0;
  }

  /**
   * Löst die ausgehenden Aufrufe eines Geräts aus, sofern sich tatsächlich
   * ein Wert geändert hat.
   *
   * Wird bewusst nur bei Änderungen von der HCU-Seite aufgerufen – ein über
   * den Daten-Endpunkt hereingekommener Wert darf keinen Rückruf erzeugen,
   * sonst schaukelt sich das mit der Gegenstelle auf.
   *
   * @param   {string} deviceId
   * @param   {Array}  before – Features vor der Änderung
   * @param   {Array}  after  – Features nach der Änderung
   * @returns {number} Anzahl der eingereihten Aufrufe
   */
  _fireOutbound(deviceId, before, after) {
    try {
      const changes = mappings.diffFeatures(before, after);
      if (changes.length === 0) return 0;

      const configured = mappings.getOutboundCalls(deviceId);
      if (configured.length === 0) return 0;

      // Ein Aufruf sendet immer alle seine Attribute, daher braucht die
      // Auswertung den vollstaendigen Zustand nach der Aenderung.
      const calls = mappings.evaluateOutbound(configured, changes, after);
      if (calls.length === 0) return 0;

      return outbound.dispatch(calls, deviceId);
    } catch (err) {
      log.error(`Ausgehende Aufrufe fuer "${deviceId}" fehlgeschlagen:`, err.message);
      return 0;
    }
  }

  /**
   * Wendet einen angelieferten Datensatz auf ein Gerät an.
   *
   * @param   {string} deviceId
   * @param   {object} incoming – { name: wert, … }
   * @returns {{ applied: Array, ignored: Array }}
   */
  _applyIncomingData(deviceId, incoming) {
    const lang   = this._lang;
    const device = devices.getById(deviceId);
    if (!device) return { applied: [], ignored: [{ reason: t(lang, 'mapping.ignored.deviceGone') }] };

    const rules = mappings.getRules(deviceId);
    if (rules.length === 0) {
      return { applied: [], ignored: [{ reason: t(lang, 'mapping.ignored.noRules') }] };
    }

    const { updates, applied, ignored } = mappings.evaluate(rules, incoming, device.deviceType, lang);
    if (updates.length === 0) {
      log.info(`Endpunkt-Daten fuer "${deviceId}" ohne Treffer:`, JSON.stringify(ignored));
      return { applied, ignored };
    }

    // Features des Geräts mit den neuen Werten überschreiben
    const features = (device.features ?? []).map((f) => ({ ...f }));

    for (const update of updates) {
      let feature = features.find((f) => f.type === update.featureType);
      if (!feature) {
        feature = { type: update.featureType };
        features.push(feature);
      }
      feature[update.attribute] = update.value;
    }

    devicesStore.update(deviceId, { ...device, features });
    devices.reload();

    const fresh = devices.getById(deviceId);
    this._sendStatusEvent(fresh);
    log.info(`Endpunkt-Daten uebernommen fuer "${deviceId}":`,
             updates.map((u) => `${u.target}=${u.value}`).join(', '));

    return { applied, ignored };
  }

  /**
   * Ergänzt die Endpunkt-Felder einer Variablen-Gruppe:
   *   • Checkbox zum Aktivieren
   *   • bei aktivem Endpunkt zusätzlich Passwort (READONLY) und Link
   *
   * @param {object} properties – Properties-Objekt für CONFIG_TEMPLATE_RESPONSE
   * @param {object} device     – Geräteobjekt aus der devices.json
   * @param {number} num        – laufende Nummer der Variablen (1-basiert)
   * @param {number} orderBase  – Basis-Sortiernummer dieser Gruppe
   */
  _addEndpointFields(properties, device, num, orderBase) {
    const lang    = this._lang;
    const enabled = device.endpointEnabled === true;

    properties[`variable_${num}_endpoint`] = {
      friendlyName: this._t('settings.endpoint.label'),
      description:  this._t('settings.endpoint.description'),
      dataType:     'BOOLEAN',
      required:     'false',
      groupId:      `variable_${num}`,
      order:        orderBase + 5,
      defaultValue: 'false',
      currentValue: enabled ? 'true' : 'false',
    };

    // Zugangsdaten erst anzeigen, wenn der Endpunkt aktiv ist
    if (!enabled || !device.endpointId || !device.endpointPassword) return;

    // Betriebsart: Daten-Endpunkt oder Kalender
    const calendarActive = mappings.getCalendar(device.deviceId)?.enabled === true;
    properties[`variable_${num}_mode`] = {
      friendlyName: this._t('settings.mode.label'),
      description:  this._t('settings.mode.description'),
      dataType:     'READONLY',
      groupId:      `variable_${num}`,
      order:        orderBase + 6,
      currentValue: calendarActive
        ? this._t('settings.mode.calendar')
        : this._t('settings.mode.endpoint'),
    };

    properties[`variable_${num}_endpoint_password`] = {
      friendlyName: this._t('settings.endpoint.password.label'),
      description:  this._t('settings.endpoint.password.description'),
      dataType:     'READONLY',
      groupId:      `variable_${num}`,
      order:        orderBase + 7,
      currentValue: device.endpointPassword,
    };

    properties[`variable_${num}_endpoint_link`] = {
      friendlyName: this._t('settings.endpoint.link.label'),
      description:  this._t('settings.endpoint.link.description'),
      dataType:     'WEBLINK',
      groupId:      `variable_${num}`,
      order:        orderBase + 8,
      // Bei WEBLINK enthaelt currentValue den Link und defaultValue den Infotext
      defaultValue: this._t('settings.endpoint.link.label'),
      currentValue: this._endpointManager.getPublicUrl(device.endpointId, lang),
    };
  }

  /**
   * Ermittelt die zu speichernden Endpunkt-Felder eines Geräts anhand der
   * Checkbox aus dem CONFIG_UPDATE_REQUEST.
   *
   * Beim Deaktivieren bleiben Endpunkt-ID und Passwort erhalten, damit die
   * Adresse beim erneuten Aktivieren stabil bleibt.
   *
   * @param   {object} device – bisheriges Geräteobjekt
   * @param   {*}      value  – Wert der Checkbox aus den Properties
   * @returns {object} zu übernehmende Felder (leer, wenn nichts zu tun ist)
   */
  _resolveEndpointFields(device, value) {
    if (value === undefined) return {};

    const enabled = value === true || value === 'true';

    if (!enabled) {
      if (device.endpointEnabled) {
        log.info(`Daten-Endpunkt fuer "${device.deviceId}" deaktiviert (Zugangsdaten bleiben erhalten).`);
      }
      return { endpointEnabled: false };
    }

    const credentials = this._endpointManager.ensureCredentials(device);
    if (!device.endpointId) {
      log.info(`Daten-Endpunkt fuer "${device.deviceId}" angelegt: ${credentials.endpointId}`);
    }
    return { endpointEnabled: true, ...credentials };
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
          friendlyName: this._t('group.general.name'),
          description:  this._t('group.general.description'),
          order:        1,
        },
      };

      // Existierende Geräte durchgehen und Gruppen dafür generieren
      for(let i = 0; i < varCount; i++) {
        let num = i + 1;
        groups[`variable_${num}`] = {
          friendlyName: this._t('group.variable.name', { num }),
          description:  this._t('group.variable.description'),
          order:        2 + i,
        };
      }

      groups['new_variable'] = {
        friendlyName: this._t('group.new_variable.name'),
        description:  this._t('group.new_variable.description'),
        order:        varCount + 2,
      };

      // --- Backup & Wiederherstellung ---
      const { backupGroup, restoreGroup, backupActive, restoreActive } = this._getBackupState();

      let backupDescription;
      if (backupActive) {
        backupDescription = this._resolveBackupText(backupGroup.description);
      } else if (restoreActive) {
        backupDescription = this._resolveBackupText(restoreGroup.description);
      } else {
        backupDescription = this._t('group.backup_restore.description');
      }

      groups['backup_restore'] = {
        friendlyName: this._t('group.backup_restore.name'),
        description:  backupDescription,
        order:        BACKUP_GROUP_ORDER,
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
            friendlyName:  this._t('settings.reinclude.label'),
            description:   this._t('settings.reinclude.description'),
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
      const orderBase = index * VARIABLE_ORDER_STEP;

      // Gerätename
      properties[`variable_${num}`] = {
        friendlyName:  this._t('settings.variable.name.label'),
        description:   this._t('settings.variable.name.description', { num }),
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
        friendlyName: this._t('settings.variable.id.label'),
        description:  this._t('settings.variable.id.description'),
        dataType:     'READONLY',
        groupId:      `variable_${num}`,
        order:        orderBase + 2,
        currentValue: device.deviceId,
      };

      // Geräteart
      properties[`variable_${num}_type`] = {
        friendlyName: this._t('settings.variable.type.label', { num }),
        description:  this._t('settings.variable.type.description', { num }),
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
          friendlyName: this._t('settings.variable.state.label', { num, feature: featureName }),
          description:  this._t('settings.variable.state.description', { num }),
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

      // --- Daten-Endpunkt ---
      this._addEndpointFields(properties, device, num, orderBase);
    });

    // Leeres Feld am Ende ergänzen (Neue Variable)
    let orderBaseLast = deviceListLength * VARIABLE_ORDER_STEP;

    // Gerätename
    properties[`new_variable`] = {
        friendlyName:  this._t('settings.new_variable.name.label'),
        description:   this._t('settings.new_variable.name.description', { num: deviceListLength }),
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
        friendlyName: this._t('settings.new_variable.type.label'),
        description:  this._t('settings.new_variable.type.description', { num: deviceListLength }),
        dataType:     'ENUM',
        required:     'false',
        groupId:      'new_variable',
        order:        orderBaseLast + 2,
        values:       DEVICE_TYPES,
        defaultValue: 'LIGHT',
        currentValue: 'LIGHT',
      };

    // --- Backup & Wiederherstellung (Dropdown bzw. Token/Link) ---
    this._addBackupRestoreFields(properties);

    return properties;
  }

  /**
   * Übermittelt alle im Plugin gespeicherten Status-Zustände an die HCU.
   * Benötigt für _onOpen(), da Werte beim HCU-Neustart zurückgesetzt werden.
   */
  /**
   * Sendet den Zustand eines einzelnen Geräts als STATUS_EVENT an die HCU.
   * @param {object} device – Geräteobjekt aus der devices.json
   */
  _sendStatusEvent(device) {
    if (!device) return;
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'STATUS_EVENT',
      body: {
        deviceId: device.deviceId,
        features: device.features,
      },
    });
  }

  _sendAllStatusEvents() {
    const allDevices = devices.getAll();
    allDevices.forEach(device => {
      this._send({
        id:       uuidv4(),
        pluginId: this.pluginId,
        type:     'STATUS_EVENT',
        body: {
          deviceId: device.deviceId,
          features: device.features,
        },
      });
    });
    log.info(`${allDevices.length} Geraetezustand(e) an HCU uebertragen.`);
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