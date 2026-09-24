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
const timezones            = require('../constants/timezones.js');
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

// Feste Kennung der taeglichen Terminuebersicht. Nutzt eine statische ID,
// damit sich die Benachrichtigung selbst ersetzt (siehe Connect-API: eine
// bereits vorhandene userMessageId wird ersetzt statt dupliziert) und sich
// gezielt wieder entfernen laesst.
const DAILY_DIGEST_MSG_ID = 'daily-digest';

// Prüfintervall für die taegliche Terminuebersicht.
const DAILY_DIGEST_CHECK_MS = 60_000;

// Hoechstzahl an Terminzeilen in der taeglichen Terminuebersicht, bevor der
// Rest zu "+N weitere" zusammengefasst wird (Benachrichtigungen sollen auf
// einem Telefon lesbar bleiben).
const DAILY_DIGEST_MAX_LINES = 15;

// Hoechstzahl der Abschnitte zum gleichzeitigen Anlegen neuer Geraete.
const MAX_NEW_SLOTS = 10;

/**
 * Vergleicht zwei Attributwerte so, wie sie in den Features stehen.
 * Zahlen mit kleiner Toleranz, um Rundungsfehler nicht als Änderung zu werten.
 */
function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}



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

    // Merker: nach dem Speichern alle Geraete erneut melden
    this._reincludePending = false;

    // Kennung der laufenden Systemzustandsabfrage
    this._systemStateRequestId = null;

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
      deviceTypeName: (deviceType) => this._deviceTypeName(deviceType),
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

    // Zeitzone setzen, bevor der Kalender startet. Die HCU führt ihre
    // Container in UTC; ohne diese Angabe legte das Plugin die Ortszeiten
    // eines Kalenders als UTC aus.
    this._applyTimezone();

    this._syncEndpoints();
    this._calendar.start();

    // Taegliche Terminuebersicht: minuetliche Pruefung, ob die eingestellte
    // Uhrzeit erreicht ist. Laeuft unabhaengig vom Kalender-Zeitgeber, liest
    // aber dessen bereits geladene Termine (kein eigener Abruf).
    this._lastDigestDay = null;
    this._digestTimer = setInterval(() => {
      try { this._checkDailyDigest(); }
      catch (err) { log.error('Terminuebersicht: Fehler bei der Pruefung:', err.message); }
    }, DAILY_DIGEST_CHECK_MS);
    if (typeof this._digestTimer.unref === 'function') this._digestTimer.unref();
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
    // Taegliche Terminuebersicht beenden
    if (this._digestTimer) {
      clearInterval(this._digestTimer);
      this._digestTimer = null;
    }
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
        // Ohne diesen Header sendet die HCU keine Systemereignisse. Sie
        // werden gebraucht, um Umbenennungen aus der Homematic IP App
        // zu erfahren.
        'hmip-system-events': 'true',
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

    // Systemzustand anfordern, um die Kennungen der HCU den eigenen Geraeten
    // zuzuordnen. Erst danach lassen sich Umbenennungen aus der App zuordnen.
    this._requestSystemState();

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

      case 'HMIP_SYSTEM_EVENT':
        this._handleSystemEvent(message);
        break;

      case 'HMIP_SYSTEM_RESPONSE':
        this._handleSystemResponse(message);
        break;

      case 'INCLUSION_EVENT':
        // HCU meldet, welche Geraete tatsaechlich in Homematic IP aufgenommen wurden
        this._handleInclusionEvent(message);
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
      const updatedDevice = devices.getById(deviceId);

      if (updatedDevice) {
        // Nur schreiben, wenn sich tatsächlich etwas geändert hat
        const changes = mappings.diffFeatures(before, updatedDevice.features);

        if (changes.length === 0) {
          log.debug(`CONTROL_REQUEST fuer "${deviceId}" ohne Wertaenderung, nicht gespeichert.`);
        } else {
          devicesStore.update(deviceId, updatedDevice);
          log.info(`Zustand von "${deviceId}" in devices.json gespeichert.`);
          // Aenderung kam von der HCU > ausgehende Aufrufe ausloesen
          this._fireOutbound(deviceId, before, updatedDevice.features);
        }
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

    const deviceList = devices.getAll();
    const VALID_TYPES = Object.keys(DEVICE_FEATURES);

    // Anzahl der Abschnitte zum Anlegen neuer Geraete
    const wantedSlots = parseInt(properties?.new_variable_count, 10);
    if (Number.isFinite(wantedSlots) && wantedSlots >= 1 && wantedSlots <= MAX_NEW_SLOTS
        && wantedSlots !== this._newSlotCount()) {
      this._config.newDeviceSlots = wantedSlots;
      configStore.save(this._config);
      log.info(`Abschnitte fuer neue Geraete: ${wantedSlots}`);
    }
 
    // Properties kommen als flaches Objekt: { reincludeDevices: 'wert', ... }
    const reincludeDevices = properties?.reincludeDevices;
 
    if (reincludeDevices !== undefined) {
      const wanted  = reincludeDevices === true || reincludeDevices === 'true';
      const changed = wanted !== (this._config.reincludeDevices === true);

      this._config.reincludeDevices = wanted;
      configStore.save(this._config);

      // Beim Einschalten alle Geräte erneut melden
      if (changed && wanted) {
        log.info('Reinkludieren eingeschaltet, melde alle Geraete erneut an die HCU.');
        this._reincludePending = true;
      }
    }

    // Zeitzone: das Dropdown liefert die Beschriftung zurück
    const zone = timezones.fromLabel(properties?.timezone);
    if (zone && zone !== this._config.timezone) {
      this._config.timezone = zone;
      configStore.save(this._config);
      this._applyTimezone();
      // Termine neu berechnen, die Ortszeiten verschieben sich
      this._calendar?.refreshAll().catch((err) =>
        log.error('Kalender nach Zeitzonenwechsel nicht abrufbar:', err.message));
    }

    // Taegliche Terminuebersicht
    const dailyDigestEnabled = properties?.dailyDigestEnabled;
    if (dailyDigestEnabled !== undefined) {
      const wanted = dailyDigestEnabled === true || dailyDigestEnabled === 'true';
      if (wanted !== (this._config.dailyDigestEnabled === true)) {
        this._config.dailyDigestEnabled = wanted;
        configStore.save(this._config);
        // Neu eingeschaltet oder Uhrzeit geaendert > heute erneut pruefen
        // (auch wenn die Uhrzeit fuer heute schon vorbei ist).
        this._lastDigestDay = null;
      }
    }

    const dailyDigestTime = properties?.dailyDigestTime;
    if (dailyDigestTime !== undefined && this._isValidDigestTime(dailyDigestTime)
        && dailyDigestTime !== this._config.dailyDigestTime) {
      this._config.dailyDigestTime = dailyDigestTime;
      configStore.save(this._config);
      this._lastDigestDay = null;
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
 
    // Alle Abschnitte durchgehen. Leer gelassene werden uebergangen, so
    // lassen sich auch weniger Geraete anlegen als Abschnitte angezeigt werden.
    const slotCount = this._newSlotCount();
    const known     = [...deviceList];
    let created     = 0;

    for (let i = 1; i <= slotCount; i++) {
      const name = devices.sanitize(properties?.[`new_variable_${i}`]);
      if (!name) continue;

      const type = this._deviceTypeFromName(properties?.[`new_variable_${i}_type`], VALID_TYPES);
      if (!type || !VALID_TYPES.includes(type)) continue;

      // known mitfuehren, damit createDevice fortlaufende Kennungen vergibt
      const newDevice = devices.createDevice(name, type, known);
      devicesStore.update(newDevice.deviceId, newDevice);
      known.push(newDevice);
      created++;

      log.info(`Neues Geraet erstellt: ${newDevice.deviceId} (${name})`);
    }

    if (created > 0) {
      // Nach dem Anlegen auf einen Abschnitt zuruecksetzen
      if (slotCount !== 1) {
        this._config.newDeviceSlots = 1;
        configStore.save(this._config);
      }

      devices.reload();
      this._sendDiscoverResponse();
      log.info(`${created} Geraet(e) angelegt.`);
    }
 
    // Aktualisierte Geräteliste neu laden
    devices.reload();

    // Endpunkte an den geänderten Gerätebestand angleichen (startet bzw. stoppt den Webserver)
    this._syncEndpoints();

    // Umbenennungen aus demselben Speichervorgang gehen mit
    if (this._reincludePending) {
      this._reincludePending = false;
      this._sendDiscoverResponse();
    }

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

  /**
   * INCLUSION_EVENT > wertet aus, welche Geraete die HCU tatsaechlich in
   * Homematic IP aufgenommen hat.
   *
   * markAsIncluded() nach der DISCOVER_RESPONSE ist optimistisch: Es geht
   * davon aus, dass die HCU alle gemeldeten Geraete auch aufnimmt. Bei sehr
   * vielen virtuellen Geraeten kann die HCU jedoch ein Limit erreichen
   * (z.B. Fehlercode 4006 MAXIMUM_GLOBAL_DEVICE_LIMIT_REACHED) und einzelne
   * Geraete verwerfen, ohne das dem Plugin separat mitzuteilen. Ohne diesen
   * Abgleich blieben solche Geraete faelschlich als "bereits aufgenommen"
   * markiert und wuerden bei einem erneuten Reinkludieren nie wieder
   * gemeldet.
   *
   * Als Reaktion auf dieses Ereignis ist laut Connect-API-Dokumentation ein
   * (unaufgefordertes) STATUS_RESPONSE mit dem Status aller tatsaechlich
   * aufgenommenen Geraete Pflicht.
   */
  _handleInclusionEvent(message) {
    const includedIds = new Set(message?.body?.deviceIds ?? []);
    log.info(`INCLUSION_EVENT: ${includedIds.size} Geraet(e) laut HCU tatsaechlich aufgenommen.`);

    const all = devices.getAll();
    const missing = all.filter((d) => d.alreadyIncluded && !includedIds.has(d.deviceId));

    for (const device of missing) {
      devicesStore.update(device.deviceId, { ...device, alreadyIncluded: false });
      log.warn(`Geraet "${device.deviceId}" (${device.friendlyName}) laut HCU NICHT aufgenommen `
        + '- wird beim naechsten Reinkludieren erneut gemeldet.');
    }

    if (missing.length > 0) devices.reload();

    const includedDevices = devices.getAll().filter((d) => includedIds.has(d.deviceId));
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'STATUS_RESPONSE',
      body: {
        success: true,
        devices: devices.toHcuDevices(includedDevices),
      },
    });
  }

  // ---------------------------------------------------------------------------
  //  Backup / Restore
  // ---------------------------------------------------------------------------

  /**
   * Übersetzt einen Schlüssel und ersetzt Platzhalter der Form {name}.
   * @param {string} key    – Schlüssel aus lang/localization.json
   * @param {object} [vars] – Werte für die Platzhalter
   */
  /**
   * Lesbarer Name einer Geräteart, wie sie in der Homematic IP App heißt.
   * Fehlt eine Übersetzung, bleibt der technische Name stehen.
   */
  _deviceTypeName(deviceType) {
    const key  = `devicetype.${deviceType}`;
    const name = t(this._lang, key);
    return name === key ? deviceType : name;
  }

  /**
   * Ordnet einen im Dropdown gewählten Anzeigenamen der technischen Geräteart zu.
   * Geprüft werden alle Sprachen, damit die Zuordnung unabhängig von der
   * eingestellten Sprache funktioniert. Ein technischer Name bleibt gültig.
   */
  _deviceTypeFromName(value, known) {
    if (!value) return null;
    if (known.includes(value)) return value;
    for (const type of known) {
      const key = `devicetype.${type}`;
      if (availableLanguages().some((lang) => t(lang, key) === value)) return type;
    }
    return null;
  }

  /**
   * Lesbarer Name eines Attributs, z.B. "Solltemperatur" statt
   * "setPointTemperature".
   */
  _attributeName(featureType, attribute) {
    if (!featureType) return attribute;
    const key  = `attribute.${featureType}.${attribute}`;
    const name = t(this._lang, key);
    return name === key ? attribute : name;
  }

  /**
   * Ziel-Attribute eines Gerätetyps, ergänzt um einen lesbaren Namen.
   */
  _namedTargets(deviceType) {
    return mappings.getTargets(deviceType).map((target) => ({
      ...target,
      label: this._attributeName(target.featureType, target.attribute),
    }));
  }

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
  /**
   * Zugangsdaten der Sammelseite. Werden beim ersten aktiven Endpunkt erzeugt
   * und in der config.json abgelegt, damit die Adresse dauerhaft gleich bleibt.
   */
  _hubAccess(anyActive) {
    if (!anyActive) return null;

    let changed = false;
    if (!this._config.hubId) {
      this._config.hubId = uuidv4();
      changed = true;
    }
    if (!this._config.hubPassword) {
      this._config.hubPassword = dataEndpoint.generatePassword();
      changed = true;
    }
    if (changed) {
      configStore.save(this._config);
      log.info('Zugangsdaten fuer die zentrale Konfigurationsseite erzeugt.');
    }

    return { endpointId: this._config.hubId, password: this._config.hubPassword };
  }

  /**
   * Übernimmt die eingestellte Zeitzone in den Prozess.
   * Node wertet process.env.TZ bei jeder Datumsoperation neu aus.
   */
  /**
   * Anzahl der Abschnitte, die zum Anlegen neuer Geräte angezeigt werden.
   * @returns {number} 1 bis MAX_NEW_SLOTS
   */
  _newSlotCount() {
    const n = parseInt(this._config.newDeviceSlots, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(Math.max(n, 1), MAX_NEW_SLOTS);
  }

  _applyTimezone() {
    const zone = timezones.isKnown(this._config.timezone)
      ? this._config.timezone
      : timezones.DEFAULT_TIMEZONE;

    timezones.apply(zone);
    log.info(`Zeitzone: ${zone} (aktuell ${-new Date().getTimezoneOffset() / 60} h zu UTC)`);
  }

  /**
   * Prüft, ob ein Wert dem Format "HH:MM" (00–23:00–59) entspricht.
   * @param   {*} value
   * @returns {boolean}
   */
  _isValidDigestTime(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  /**
   * Minütliche Prüfung für die tägliche Terminübersicht: ist die
   * eingeschaltete Funktion aktiv, die eingestellte Uhrzeit (lokal, gemäß
   * Zeitzoneneinstellung – process.env.TZ ist bereits über _applyTimezone()
   * gesetzt) erreicht und wurde heute noch keine Übersicht gesendet?
   *
   * Bewusst mit "Aufholen" wie beim Kalenderabruf: Ist die Uhrzeit beim
   * Start bzw. nach einer Änderung der Einstellung schon vorbei, wird beim
   * nächsten Durchlauf trotzdem sofort gesendet, statt einen Tag zu warten.
   */
  _checkDailyDigest(now = new Date()) {
    if (this._config.dailyDigestEnabled !== true) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const dayKey = now.toDateString();
    if (this._lastDigestDay === dayKey) return;

    const time = this._isValidDigestTime(this._config.dailyDigestTime)
      ? this._config.dailyDigestTime
      : '08:00';
    const [targetHour, targetMinute] = time.split(':').map(Number);
    const targetMinutes = targetHour * 60 + targetMinute;
    const nowMinutes    = now.getHours() * 60 + now.getMinutes();

    if (nowMinutes < targetMinutes) return;

    this._lastDigestDay = dayKey;
    this._sendDailyDigest(now);
  }

  /**
   * Stellt die heutigen Termine aller Kalender-Geräte zusammen und sendet
   * bei Bedarf eine DISMISSIBLE-Benachrichtigung. Ohne anstehende Termine
   * wird nichts gesendet (und eine evtl. vorherige Übersicht – sollte sie
   * aus einem fruehereren Aufruf noch offen sein – bleibt unberuehrt, da sie
   * ohnehin dismissable ist und sich am naechsten Tag durch die gleiche
   * userMessageId selbst ersetzt).
   */
  _sendDailyDigest(now = new Date()) {
    const groups = this._calendar?.todaysEvents(now) ?? [];
    if (groups.length === 0) {
      log.info('Terminuebersicht: heute keine Termine, keine Benachrichtigung gesendet.');
      return;
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    const formatTime = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

    // Termine ueber alle Geraete hinweg chronologisch zusammenfassen.
    const allEvents = [];
    for (const group of groups) {
      const device = devices.getById(group.deviceId);
      const name   = device?.friendlyName ?? group.deviceId;
      for (const ev of group.events) allEvents.push({ ...ev, deviceName: name });
    }
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    const shown    = allEvents.slice(0, DAILY_DIGEST_MAX_LINES);
    const overflow = allEvents.length - shown.length;

    const buildText = (lang) => {
      const allDayLabel = t(lang, 'dailydigest.allday');
      const lines = shown.map((ev) => {
        const when = ev.allDay ? allDayLabel : `${formatTime(ev.start)}–${formatTime(ev.end)}`;
        return `${ev.deviceName}: ${ev.summary || '–'} (${when})`;
      });
      if (overflow > 0) {
        lines.push(t(lang, 'dailydigest.more').replace('{count}', String(overflow)));
      }
      return lines.join('\n');
    };

    const title = {
      de: t('de', 'dailydigest.title'),
      en: t('en', 'dailydigest.title'),
    };
    const message = {
      de: buildText('de'),
      en: buildText('en'),
    };

    // Fallback fuer eine dritte, in der HCU eingestellte Sprache (zeigt den
    // englischen Text), analog zu den anderen Benachrichtigungen im Plugin.
    if (this._lang && this._lang !== 'de' && this._lang !== 'en') {
      title[this._lang]   = title.en;
      message[this._lang] = message.en;
    }

    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'CREATE_USER_MESSAGE_REQUEST',
      body: {
        userMessageId:   DAILY_DIGEST_MSG_ID,
        behaviorType:    'DISMISSIBLE',
        messageCategory: 'INFO',
        timestamp:       Date.now(),
        title,
        message,
      },
    });

    log.info(`Terminuebersicht gesendet: ${allEvents.length} Termin(e) `
      + `bei ${groups.length} Geraet(en).`);
  }

  _syncEndpoints() {
    try {
      const all       = devices.getAll();
      const anyActive = all.some((d) => d.endpointEnabled === true
        && d.endpointId && d.endpointPassword);
      const active    = this._endpointManager.sync(all, this._hubAccess(anyActive));
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

    // Unveränderte Werte nicht erneut schreiben und melden
    if (sameValue(feature[attribute], value)) return;
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

    // Fehlende Features anlegen
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

      // Ein Aufruf sendet immer alle seine Attribute
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
  /**
   * Fordert den Zustand des Homematic IP Systems an.
   *
   * Aus der Antwort wird die Zuordnung zwischen den Kennungen der HCU und den
   * eigenen Geräten aufgebaut. Ohne sie ließe sich eine Umbenennung nicht
   * zuordnen: Das Ereignis enthält nur den **neuen** Namen, ein Abgleich über
   * den bisherigen Namen ginge also gerade dann ins Leere, wenn er gebraucht
   * wird.
   */
  _requestSystemState() {
    this._systemStateRequestId = uuidv4();

    this._send({
      id:       this._systemStateRequestId,
      pluginId: this.pluginId,
      type:     'HMIP_SYSTEM_REQUEST',
      body: {
        path: '/hmip/home/getSystemState',
        body: {},
      },
    });
  }

  /**
   * Wertet die Antwort auf die Systemzustandsabfrage aus.
   *
   * Zugeordnet wird über den Namen: Zu diesem Zeitpunkt stimmen die Namen auf
   * beiden Seiten noch überein, weil das Plugin sie selbst vergeben hat.
   * Mehrdeutige Namen werden übergangen und protokolliert.
   */
  _handleSystemResponse(message) {
    if (message?.id !== this._systemStateRequestId) return;

    const code = message?.body?.code;
    if (code !== 200) {
      log.warn(`Systemzustand nicht abrufbar (Code ${code}). `
        + 'Umbenennungen aus der App koennen nicht zugeordnet werden.');
      return;
    }

    const remote = message?.body?.body?.devices;
    if (!remote || typeof remote !== 'object') return;

    const own = devices.getAll().filter((d) => !d.hcuDeviceId);
    let mapped = 0;

    for (const entry of Object.values(remote)) {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
      if (!label || !entry?.id) continue;

      const hits = own.filter((d) => d.friendlyName === label);
      if (hits.length !== 1) continue;

      const device = devices.getById(hits[0].deviceId);
      if (!device || device.hcuDeviceId === entry.id) continue;

      devicesStore.update(device.deviceId, { ...device, hcuDeviceId: entry.id });
      mapped++;
    }

    if (mapped > 0) {
      devices.reload();
      log.info(`${mapped} Geraet(e) der HCU-Kennung zugeordnet.`);
    }

    const offen = devices.getAll().filter((d) => !d.hcuDeviceId).length;
    if (offen > 0) {
      log.info(`${offen} Geraet(e) ohne HCU-Kennung. Umbenennungen in der App `
        + 'werden fuer sie erst nach einer eindeutigen Zuordnung uebernommen.');
    }
  }

  /**
   * Wertet ein Systemereignis der HCU aus.
   *
   * Interessant ist allein DEVICE_CHANGED: Wird ein Gerät in der Homematic IP
   * App umbenannt, steht der neue Name im Feld label. Die HCU ist dabei
   * führend – der Name wird in die devices.json übernommen.
   *
   * Ein Ereignis kann mehrere Änderungen in einer Transaktion bündeln,
   * deshalb wird die gesamte events-Map durchgegangen.
   */
  _handleSystemEvent(message) {
    const events = message?.body?.eventTransaction?.events;
    if (!events || typeof events !== 'object') return;

    let renamed = 0;

    for (const key of Object.keys(events).sort((a, b) => Number(a) - Number(b))) {
      const event = events[key];

      // DEVICE_ADDED liefert das Geraet mit dem Namen, den das Plugin vergeben hat
      if (event?.pushEventType === 'DEVICE_ADDED') {
        this._linkRemoteDevice(event.device);
        continue;
      }

      if (event?.pushEventType !== 'DEVICE_CHANGED') continue;
      if (this._applyRemoteName(event.device)) renamed++;
    }

    if (renamed > 0) {
      this._pushConfigTemplate();
    }
  }

  /**
   * Hält die HCU-Kennung eines neu aufgenommenen Geräts fest.
   */
  _linkRemoteDevice(remote) {
    const label = typeof remote?.label === 'string' ? remote.label.trim() : '';
    if (!label || !remote?.id) return;

    const hits = devices.getAll().filter((d) => !d.hcuDeviceId && d.friendlyName === label);
    if (hits.length !== 1) return;

    devicesStore.update(hits[0].deviceId, { ...hits[0], hcuDeviceId: remote.id });
    devices.reload();
    log.info(`Geraet "${hits[0].deviceId}" der HCU-Kennung ${remote.id} zugeordnet.`);
  }

  /**
   * Übernimmt den Namen eines Geräts aus einem DEVICE_CHANGED-Ereignis.
   *
   * @returns {boolean} true, wenn ein Name übernommen wurde
   */
  _applyRemoteName(remote) {
    const label = typeof remote?.label === 'string' ? remote.label.trim() : '';
    if (!label || !remote?.id) return false;

    const device = this._matchRemoteDevice(remote);
    if (!device) {
      log.debug(`Systemereignis fuer unbekanntes Geraet "${remote.id}" (${label}) uebergangen.`);
      return false;
    }

    if (device.hcuDeviceId !== remote.id) {
      devicesStore.update(device.deviceId, { ...device, hcuDeviceId: remote.id });
      devices.reload();
    }

    const current = devices.getById(device.deviceId);
    const clean   = devices.sanitize(label);
    if (current.friendlyName === clean) return false;

    devicesStore.update(device.deviceId, { ...current, friendlyName: clean });
    devices.reload();

    log.info(`Geraet in der Homematic IP App umbenannt: "${current.friendlyName}" heisst jetzt "${clean}".`);
    return true;
  }

  /**
   * Sucht das Gerät, auf das sich ein Ereignis der HCU bezieht.
   * Ein Abgleich über den Namen hilft hier nicht: das Ereignis enthält
   * bereits den neuen Namen.
   */
  _matchRemoteDevice(remote) {
    const all = devices.getAll();

    const known = all.find((d) => d.hcuDeviceId && d.hcuDeviceId === remote.id);
    if (known) return known;

    const direct = all.find((d) => d.deviceId === remote.id);
    if (direct) return direct;

    return null;
  }

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
    const changed  = [];

    for (const update of updates) {
      let feature = features.find((f) => f.type === update.featureType);
      if (!feature) {
        feature = { type: update.featureType };
        features.push(feature);
      }
      if (sameValue(feature[update.attribute], update.value)) continue;
      feature[update.attribute] = update.value;
      changed.push(update);
    }

    // Liefert ein externes System denselben Wert erneut, ändert sich nichts.
    // Dann wird weder geschrieben noch ein STATUS_EVENT gesendet.
    if (changed.length === 0) {
      log.debug(`Endpunkt-Daten fuer "${deviceId}" ohne Wertaenderung, kein Ereignis gesendet.`);
      return { applied, ignored };
    }

    devicesStore.update(deviceId, { ...device, features });
    devices.reload();

    const fresh = devices.getById(deviceId);
    this._sendStatusEvent(fresh);
    log.info(`Endpunkt-Daten uebernommen fuer "${deviceId}":`,
             changed.map((u) => `${u.target}=${u.value}`).join(', '));

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
  /**
   * Ergänzt Passwort und Link der zentralen Konfigurationsseite in der
   * allgemeinen Gruppe. Ohne aktiven Endpunkt entfallen beide Felder.
   */
  _addHubFields(properties) {
    const url = this._endpointManager.getHubUrl(this._lang);
    if (!url || !this._config.hubPassword) return;

    properties.hub_password = {
      friendlyName: this._t('settings.hub.password.label'),
      description:  this._t('settings.hub.password.description'),
      dataType:     'READONLY',
      groupId:      'general',
      order:        3,
      currentValue: this._config.hubPassword,
    };

    properties.hub_link = {
      friendlyName: this._t('settings.hub.link.label'),
      description:  this._t('settings.hub.description'),
      dataType:     'WEBLINK',
      groupId:      'general',
      order:        4,
      defaultValue: this._t('settings.hub.link.label'),
      currentValue: url,
    };
  }

  _addEndpointFields(properties, device, num, orderBase) {
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
      const deviceListForNames = devices.getAll();

      for(let i = 0; i < varCount; i++) {
        let num  = i + 1;
        const dev = deviceListForNames[i];
        const nm  = dev?.friendlyName;
        groups[`variable_${num}`] = {
          friendlyName: nm
            ? this._t('group.variable.name', { num, name: nm, type: this._deviceTypeName(dev.deviceType) })
            : this._t('group.variable.unnamed', { num }),
          description:  this._t('group.variable.description', { name: nm ?? '' }),
          order:        2 + i,
        };
      }

      const newSlots = this._newSlotCount();
      for (let i = 1; i <= newSlots; i++) {
        groups[`new_variable_${i}`] = {
          friendlyName: newSlots === 1
            ? this._t('group.new_variable.name')
            : this._t('group.new_variable.numbered', { n: i, total: newSlots }),
          description:  this._t('group.new_variable.description'),
          order:        varCount + 1 + i,
        };
      }

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
            currentValue:  this._config.reincludeDevices === true ? 'true' : 'false',
          },
      };

    // --- Zeitzone ---
    properties.timezone = {
      friendlyName: this._t('settings.timezone.label'),
      description:  this._t('settings.timezone.description'),
      dataType:     'ENUM',
      required:     'false',
      groupId:      'general',
      order:        2,
      values:       timezones.TIMEZONES.map((z) => z.label),
      defaultValue: timezones.toLabel(timezones.DEFAULT_TIMEZONE),
      currentValue: timezones.toLabel(
        timezones.isKnown(this._config.timezone) ? this._config.timezone : timezones.DEFAULT_TIMEZONE),
    };

    // --- Taegliche Terminuebersicht ---
    properties.dailyDigestEnabled = {
      friendlyName: this._t('settings.dailydigest.enabled.label'),
      description:  this._t('settings.dailydigest.enabled.description'),
      dataType:     'BOOLEAN',
      required:     'false',
      groupId:      'general',
      order:        5,
      defaultValue: 'false',
      currentValue: this._config.dailyDigestEnabled === true ? 'true' : 'false',
    };

    properties.dailyDigestTime = {
      friendlyName:  this._t('settings.dailydigest.time.label'),
      description:   this._t('settings.dailydigest.time.description'),
      dataType:      'STRING',
      required:      'false',
      groupId:       'general',
      order:         6,
      pattern:       '^([01]\\d|2[0-3]):[0-5]\\d$',
      minimumLength: 5,
      maximumLength: 5,
      defaultValue:  '08:00',
      currentValue:  this._isValidDigestTime(this._config.dailyDigestTime) ? this._config.dailyDigestTime : '08:00',
    };

    // --- Zentrale Konfigurationsseite ---
    // Erscheint, sobald mindestens ein Gerät einen aktiven Endpunkt hat.
    this._addHubFields(properties);

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
        defaultValue: this._deviceTypeName('LIGHT'),
        currentValue: this._deviceTypeName(device.deviceType || 'LIGHT'),
      };

      // Aktueller Status
      const featureDef = devices.getFeatureDef(device.deviceType);

      if (featureDef?.stateType) {
        log.info(`Variable ${num}: stateType=${featureDef.stateType}, stateKey=${featureDef.stateKey}, currentValue=${device.features?.find(f => f[featureDef.stateKey] !== undefined)?.[featureDef.stateKey]}`);
        // Lesbaren Namen des Attributs verwenden, nicht die technische Kennung
        const featureType = device.features?.[0]?.type;
        const featureName = featureDef.stateKey
          ? this._attributeName(featureType, featureDef.stateKey)
          : 'Status';

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

    const slots = this._newSlotCount();

    for (let i = 1; i <= slots; i++) {
      const slotBase = orderBaseLast + (i - 1) * 3;

      properties[`new_variable_${i}`] = {
        friendlyName:  slots === 1
          ? this._t('settings.new_variable.name.label')
          : this._t('settings.new_variable.name.slot'),
        description:   this._t('settings.new_variable.name.description',
          { num: deviceListLength + i - 1 }),
        dataType:      'STRING',
        required:      'false',
        groupId:       `new_variable_${i}`,
        order:         slotBase + 1,
        minimumLength: 0,
        maximumLength: 255,
        currentValue:  '',
      };

      properties[`new_variable_${i}_type`] = {
        friendlyName: slots === 1
          ? this._t('settings.new_variable.type.label')
          : this._t('settings.new_variable.type.slot'),
        description:  this._t('settings.new_variable.type.description',
          { num: deviceListLength + i - 1 }),
        dataType:     'ENUM',
        required:     'false',
        groupId:      `new_variable_${i}`,
        order:        slotBase + 2,
        values:       DEVICE_TYPES.map((type) => this._deviceTypeName(type)),
        defaultValue: this._deviceTypeName('LIGHT'),
        currentValue: this._deviceTypeName('LIGHT'),
      };
    }

    // Anzahl der Abschnitte, im letzten Abschnitt platziert
    properties.new_variable_count = {
      friendlyName: this._t('settings.new_variable.count.label'),
      description:  this._t('settings.new_variable.count.description'),
      dataType:     'ENUM',
      required:     'false',
      groupId:      `new_variable_${slots}`,
      order:        orderBaseLast + (slots - 1) * 3 + 3,
      values:       Array.from({ length: MAX_NEW_SLOTS }, (_, i) => String(i + 1)),
      defaultValue: '1',
      currentValue: String(slots),
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