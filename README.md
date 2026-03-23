# SmartMatix Virtual Devices

Ein Plugin für die **Homematic IP Home Control Unit (HCU)**, das es ermöglicht, virtuelle Geräte als Variablen direkt in der HCU zu erstellen, zu konfigurieren und zu verwalten – ohne Cloud, vollständig lokal über die [Connect API 1.0.1](https://github.com/homematicip/connect-api).

> Entwickelt von **Kevin Schipper** · Plugin-ID: `de.smartmatix.plugin.virtual-devices`

---

## Features

- **Virtuelle Geräte anlegen** – direkt aus den Plugin-Einstellungen in der HCUWeb, ohne Konfigurationsdateien manuell zu bearbeiten
- **19 Gerätetypen** – LIGHT, SWITCH, THERMOSTAT, INVERTER, WINDOW_COVERING und viele mehr
- **Dynamisches Einstellungsmenü** – jede Variable erhält eine eigene Gruppe in der HCU-Konfigurationsmaske
- **Standard-Statuswerte** – je nach Gerätetyp als Toggle, Zahlenwert oder Dropdown konfigurierbar
- **Geräte löschen** – durch Leeren des Namensfeldes in den Plugin-Einstellungen
- **Persistenz** – alle Geräte und Einstellungen werden in `/data` gespeichert und überleben Plugin-Updates
- **Automatische Wiederverbindung** – Exponential Backoff bei Verbindungsabbruch
- **Gerät neu einbinden** – verlorene Geräte können über die `reincludeDevices`-Einstellung erneut an die HCU gemeldet werden

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.5.16 |
| Entwicklermodus | aktiviert (HCUWeb) |

---

## Projektstruktur

```
smartmatix-virtual-devices/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── LICENSE
├── constants/
│   └── device_constants.js           ← Gerätetypen & Feature-Definitionen
├── data/
│   ├── config.json                   ← Plugin-Konfiguration (lokal)
│   └── devices.json                  ← Gerätedefinitionen (lokal)
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Einstellungsmenü
    ├── devices.js                    ← Geräteverwaltung & Steuerlogik
    ├── devicesStore.js               ← Persistenz für Geräte
    ├── configStore.js                ← Persistenz für Konfiguration
    └── logger.js                     ← Konsolenlogger
```
---

### Plugin auf der HCU installieren (Für Endnutzer)

HCUWeb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

> Der Entwicklermodus muss aktiviert sein.

---

## Lokale Entwicklung

### 1. Repository klonen & Abhängigkeiten installieren

```bash
git clone https://github.com/Spider-S001/smartmatix-virtual-devices.git
cd smartmatix-virtual-devices
npm install
```

### 2. Aktivierungsschlüssel erzeugen

In der **HCUWeb** (`https://hcu-XXXX.local`) unter  
`Einstellungen → Entwicklermodus → Aktivierungsschlüssel generieren`

Anschließend über Postman oder curl den Auth-Token generieren (siehe HCU-Dokumentation) und in eine Datei speichern:

```bash
echo "DEIN-AUTHTOKEN" > authtoken.txt
```

### 3. Plugin starten

```bash
node src/index.js de.smartmatix.plugin.virtual-devices hcu1-XXXX.local authtoken.txt
```

Mit Debug-Logging:

```bash
LOG_LEVEL=debug node src/index.js de.smartmatix.plugin.virtual-devices hcu1-XXXX.local authtoken.txt
```

### Log-Level

| Wert | Beschreibung |
|---|---|
| `debug` | Alle Nachrichten inkl. Roh-JSON |
| `info` | Standard (Default) |
| `warn` | Nur Warnungen und Fehler |
| `error` | Nur Fehler |

---

## Deployment auf der HCU

### 1. Docker-Image bauen

Das Plugin läuft auf der HCU in einem ARM64-Container. Zum Bauen auf einem x86-Rechner wird Docker Buildx benötigt:

```bash
docker buildx build --platform linux/arm64 -t smartmatix-virtual-devices:1.0.0 .
```

### 2. Image exportieren

```bash
docker save smartmatix-virtual-devices:1.0.0 | gzip > smartmatix-virtual-devices-1.0.0.tar.gz
```
### Unter Windows (anschließend mit 7zip zu .tar.gz konvertieren)
```bash
docker save smartmatix-virtual-devices:1.0.0 -o smartmatix-virtual-devices-1.0.0.tar
```

---

## Protokollablauf

```
Plugin                                  HCU
  │                                      │
  │── WebSocket (wss://<host>:9001) ────►│
  │   Header: authtoken, plugin-id       │
  │                                      │
  │── PLUGIN_STATE_RESPONSE { READY } ──►│  (sofort beim Verbindungsaufbau)
  │                                      │
  │◄── PLUGIN_STATE_REQUEST ─────────────│  (periodisch)
  │── PLUGIN_STATE_RESPONSE { READY } ──►│
  │                                      │
  │◄── DISCOVER_REQUEST ─────────────────│  (HCU sucht Geräte)
  │── DISCOVER_RESPONSE ────────────────►│  (Geräteliste)
  │                                      │
  │◄── CONFIG_TEMPLATE_REQUEST ──────────│  (HCU öffnet Einstellungen)
  │── CONFIG_TEMPLATE_RESPONSE ─────────►│  (Einstellungsfelder)
  │                                      │
  │◄── CONFIG_UPDATE_REQUEST ────────────│  (Nutzer speichert)
  │── CONFIG_UPDATE_RESPONSE ───────────►│
  │                                      │
  │◄── CONTROL_REQUEST ──────────────────│  (HCU steuert Gerät)
  │── CONTROL_RESPONSE ─────────────────►│
  │                                      │
  │── STATUS_EVENT ─────────────────────►│  (proaktive Statusmeldung)
```

---

## Unterstützte Gerätetypen

| Gerätetyp | Feature | Status-Eingabe |
|---|---|---|
| `LIGHT` | `switchState` | Toggle (ein/aus) |
| `SWITCH` | `switchState` | Toggle (ein/aus) |
| `THERMOSTAT` | `setPointTemperature` | Zahl (5–30 °C) |
| `WINDOW_COVERING` | `shutterLevel` | Zahl (0–1) |
| `INVERTER` | `currentPower` | Zahl (0–100.000 W) |
| `ENERGY_METER` | `currentPower` | Zahl (0–100.000 W) |
| `EV_CHARGER` | `currentPower` | Zahl (0–22.000 W) |
| `GRID_CONNECTION_POINT` | `currentPower` | Zahl (−100.000–100.000 W) |
| `HVAC` | `currentPower` | Zahl (0–10.000 W) |
| `HEAT_PUMP` | `climateOperationMode` | Dropdown (AUTO / COOLING / HEATING) |
| `BATTERY` | `batteryState` | Zahl (0–1) |
| `VEHICLE` | `batteryState` | Zahl (0–1) |
| `CONTACT_SENSOR` | `contactSensorState` | Toggle |
| `OCCUPANCY_SENSOR` | `presenceDetected` | Toggle |
| `SMOKE_ALARM` | `smokeAlarm` | Toggle |
| `WATER_SENSOR` | `waterlevelDetected` | Toggle |
| `CLIMATE_SENSOR` | – | – |
| `PARTICULATE_MATTER_SENSOR` | – | – |
| `SWITCH_INPUT` | – | – |

---

## Einstellungen in der HCUWeb

| Einstellung | Beschreibung |
|---|---|
| **Geräte neu einbinden** | Wenn aktiv, werden beim nächsten Discover alle Geräte erneut an die HCU gemeldet – auch bereits eingebundene |
| **Variable N** | Name des virtuellen Geräts |
| **Variable N: Geräteart** | Typ des Geräts (Dropdown) |
| **Variable N: Standard-Status** | Initialwert des Geräts |
| **Neue Variable** | Name + Typ für ein neues Gerät – nach dem Speichern erscheint es sofort in der HCU |

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2025 Kevin Schipper
