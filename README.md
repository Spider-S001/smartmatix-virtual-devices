# SmartMatix Virtual Devices

![Das Plugin-Icon von SmartMatix Virtual Devices](/Screenshots/virtual-devices-plugin-icon.png "Plugin-Icon")

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
- **Backup & Wiederherstellung** – Variablen und Einstellungen direkt aus der HCUWeb als JSON sichern und wieder einspielen
- **Automatischer Update-Check** – prüft täglich auf neue Releases und meldet sie als Benachrichtigung in der Homematic IP App
- **Daten-Endpunkt je Gerät** – pro virtuellem Gerät eine eigene, passwortgeschützte Schnittstelle mit fester Adresse
- **Datenzuordnung** – externe Werte per Regel auf Homematic IP Attribute abbilden, mit vollständigem Feature-Katalog der Connect API
- **Ausgehende Aufrufe** – bei Zustandsänderungen eines Geräts eine frei wählbare Adresse per GET aufrufen
- **Kalendersteuerung** – Geräte alternativ über einen Google-, Outlook- oder iCal-Kalender schalten
- **Zweisprachig** – Einstellungsmenü und Konfigurationsseite auf Deutsch und Englisch, gesteuert über den Sprachcode der HCU

![Die Auswahl der Gerätetypen im Plugin](/Screenshots/Geraeteauswahl.png "Die Auswahl der Gerätetypen im Plugin")

![Die Konfiguration der API für ein Gerät](/Screenshots/API-Konfiguration-Smartmatix-Virtual-Devices.jpg "Die Konfiguration der API für ein Gerät")

![Kalender-Verknüpfung eines Geräts](/Screenshots/Kalender-Konfiguration-Smartmatix-Virtual-Devices.jpg "Kalender-Verknüpfung eines Geräts")

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.5.16 |
| Entwicklermodus | aktiviert (HCUWeb) |
| Freigegebener Port | 8744/tcp (Backup & Wiederherstellung) |
| Freigegebener Port | 8745/tcp (Daten-Endpunkte) |

---

## Projektstruktur

```
smartmatix-virtual-devices/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── LICENSE
├── constants/
│   ├── device_constants.js           ← Gerätetypen & Pflicht-Attribute
│   └── feature_catalog.js           ← vollständiger Feature-Katalog der Connect API
├── lang/
│   └── localization.json             ← alle Übersetzungen (de / en)
├── html/
│   └── webconfig.html                ← Aufbau der Konfigurationsseite (nur Markup)
├── js/
│   └── webconfig.js                  ← Verhalten der Konfigurationsseite
├── styles/
│   └── webconfig.css                 ← Gestaltung der Konfigurationsseite
├── data/
│   ├── config.json                   ← Plugin-Konfiguration (lokal)
│   └── devices.json                  ← Gerätedefinitionen (lokal)
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Einstellungsmenü
    ├── devices.js                    ← Geräteverwaltung & Steuerlogik
    ├── devicesStore.js               ← Persistenz für Geräte
    ├── configStore.js                ← Persistenz für Konfiguration
    ├── backup-plugin-data.js         ← Backup & Wiederherstellung von /data
    ├── hcu-plugin-updater.js         ← Update-Check gegen das Git-Repository
    ├── dataEndpoint.js               ← Daten-Endpunkte der virtuellen Geräte
    ├── mappings.js                   ← Zuordnungsregeln: Speicherung und Auswertung
    ├── outbound.js                   ← Versand der ausgehenden GET-Aufrufe
    ├── netguard.js                   ← Bewertung der Ziele ausgehender Verbindungen
    ├── calendar.js                   ← iCalendar-Format lesen und auswerten
    ├── calendarScheduler.js          ← Schalten nach Kalenderterminen
    ├── localization.js               ← Übersetzungen aus lang/localization.json
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
docker buildx build --platform linux/arm64 -t smartmatix-virtual-devices:1.1.0.11 .
```

### 2. Image exportieren

```bash
docker save smartmatix-virtual-devices:1.1.0.11 | gzip > smartmatix-virtual-devices-1.1.0.11.tar.gz
```
### Unter Windows (anschließend mit 7zip zu .tar.gz konvertieren)
```bash
docker save smartmatix-virtual-devices:1.1.0.11 -o smartmatix-virtual-devices-1.1.0.11.tar
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
| **Variable N: Daten-Endpunkt aktivieren** | Legt beim Speichern Endpunkt-ID und Passwort an; danach erscheinen Passwort und Konfigurationslink in derselben Gruppe |
| **Backup & Wiederherstellung → Aktion** | `Backup starten` erzeugt einen einmaligen Download-Link, `Wiederherstellung starten` einen Token samt Upload-Seite |

---

## Daten-Endpunkte

Jedes virtuelle Gerät kann eine eigene, passwortgeschützte Schnittstelle erhalten.
Der Webserver dafür läuft auf **Port 8745** und startet automatisch, sobald mindestens
ein Gerät einen aktiven Endpunkt besitzt – und stoppt wieder, wenn keiner mehr aktiv ist.

### Einrichten

1. HCUWeb → Plugin-Einstellungen → gewünschte Variable
2. **Daten-Endpunkt aktivieren** ankreuzen und speichern
3. Es werden eine Endpunkt-ID (UUID v4) und ein Zufallspasswort erzeugt und in der
   `devices.json` gespeichert
4. In derselben Gruppe erscheinen anschließend das Passwort und der Link
   **Zur Schnittstellen-Konfiguration**
5. Link öffnen, Passwort aus den Einstellungen kopieren und auf der Seite eingeben

Die Adresse lautet `https://hcu1-XXXX.local:8745/<endpointId>`.

### Verhalten

| Aspekt | Verhalten |
|---|---|
| Adresse | Bleibt dauerhaft stabil, auch nach Deaktivieren und erneutem Aktivieren |
| Deaktivieren | Endpunkt nicht mehr erreichbar, ID und Passwort bleiben gespeichert |
| Passwort | 20 Zeichen aus einem Alphabet ohne verwechselbare Zeichen (100 Bit) |
| Anmeldung | Passwortprüfung zeitkonstant, danach Session-Token mit 30 Minuten Gültigkeit |
| Brute-Force | Nach 10 Fehlversuchen je IP und Endpunkt 5 Minuten gesperrt |
| Gerät gelöscht | Endpunkt verschwindet mit dem Gerät |

> Das Passwort wird im Klartext in der `devices.json` abgelegt, weil es in den
> Plugin-Einstellungen angezeigt werden muss. Es ist damit auch in Backups enthalten.
> Endpunkt-Zugangsdaten werden **niemals** an die HCU übertragen – Geräte-Payloads
> werden vor dem Senden auf die Felder des Connect-API-Schemas reduziert.

---

## Datenzuordnung

Homematic IP reagiert nur auf exakt passende Attributnamen und Werte. Auf der
Konfigurationsseite des Endpunkts lässt sich deshalb pro Gerät festlegen, wie
angelieferte Werte übersetzt werden.

### Aufbau einer Regel

```
Externer Wert                →   Homematic IP-Wert
[ Name  ] [ Wert ]           →   [ Attribut ▾ ] [ Wert ]
                                 ☐ Wert durchreichen
```

Das Eingabefeld für den Homematic IP-Wert richtet sich nach dem gewählten Attribut:

| Attributtyp | Eingabe |
|---|---|
| Boolean | Auswahl `true` / `false` |
| Aufzählung | Auswahl der erlaubten Werte, z.B. `AUTO` / `COOLING` / `HEATING` |
| Zahl | Zahlenfeld mit Minimum und Maximum aus dem Katalog |

Mit **Wert durchreichen** entfallen beide Wertfelder: jeder unter diesem Namen
angelieferte Wert wird direkt übernommen, passend zum Zieltyp umgewandelt und bei
Zahlen auf den erlaubten Bereich begrenzt.

Mehrere Regeln dürfen denselben Namen verwenden – nötig etwa für `ON → true` und
`OFF → false`. Trifft für einen Namen sowohl eine Regel mit festem Wert als auch
eine Durchreich-Regel zu, gewinnt die Regel mit festem Wert.

### Umwandlung

| Zieltyp | Regel |
|---|---|
| Boolean | Ausschließlich `true` und `1` gelten als wahr, alles andere als falsch |
| Zahl | Komma und Punkt als Dezimaltrennzeichen, Begrenzung auf Minimum/Maximum, Ganzzahlen werden gerundet |
| Aufzählung | Muss einem erlaubten Wert entsprechen, Groß- und Kleinschreibung wird ignoriert; sonst Ablehnung |

Namen und externe Werte werden ohne Beachtung der Groß-/Kleinschreibung verglichen.
Werte ohne passende Regel werden verworfen und protokolliert, das Gerät bleibt unverändert.

### Anlieferung

Die Adresse des Endpunkts steht auf der Konfigurationsseite in einem
schreibgeschützten Feld samt Kopierknopf bereit – das Passwort ist bereits enthalten:

```
https://hcu1-XXXX.local:8745/<endpointId>/data?password=…
```

Weitere Werte werden mit `&` angehängt, bei POST stehen sie im JSON-Body:

```
GET  …/data?password=…&state=ON&bright=0.4
POST …/data?password=…
     {"state": "ON", "bright": 0.4}
```

> Die kopierte Adresse enthält das Passwort im Klartext. Sie gehört damit in
> dieselbe Kategorie wie ein Zugangsdatum und sollte nicht in Chats, Tickets oder
> öffentlichen Repositories landen.

Eine Anlieferung darf mehrere Namen gleichzeitig enthalten. Die Antwort nennt die
übernommenen und die verworfenen Werte:

```json
{ "applied": [{ "name": "state", "value": "ON", "target": "switchState.on", "result": true }],
  "ignored": [{ "name": "foo", "reason": "keine Regel für diesen Namen" }] }
```

Status `200` bei mindestens einer Übernahme, `422` wenn keine Regel griff, `401` bei
falschem Passwort, `429` nach zu vielen Fehlversuchen.

Nach jeder Übernahme wird der Wert in der `devices.json` gespeichert und ein
`STATUS_EVENT` an die HCU gesendet.

### Ausgehende Aufrufe

Die Gegenrichtung liegt im selben Abschnitt der Konfigurationsseite. Oberste
Einheit ist der **Aufruf**: eine Adresse, die mehrere Attribute auf einmal
überträgt. Je Gerät sind mehrere Aufrufe an verschiedene Adressen möglich.

```
Aufruf 1                                        ✕ Aufruf entfernen
Zieladresse: [ http://host/api?on={value1}&dim={value2} ]

  {value1}  [ switchState.on      ▾ ]                       ✕
            [ true  ] → [ AN  ]                             ✕
            [ false ] → [ AUS ]                             ✕
            + Wertepaar hinzufügen
            ☐ Wert durchreichen

  {value2}  [ dimming.dimLevel    ▾ ]                       ✕
            ☑ Wert durchreichen
  + Attribut hinzufügen
```

Der Platzhalter `{valueN}` verweist auf die N-te Zeile **innerhalb desselben
Aufrufs**; die Nummer steht direkt an der Zeile. Werte werden beim Einsetzen
URL-kodiert.

Je Zeile lassen sich beliebig viele Wertepaare hinterlegen, etwa `true → AN` und
`false → AUS`. Passt der aktuelle Wert zu keinem Paar, bleibt der Platzhalter
leer – der Parameter wird also ohne Inhalt gesendet. Mit **Wert durchreichen**
entfällt die Tabelle und der Rohwert des Geräts geht hinaus.

Ein Aufruf feuert, sobald sich **mindestens eines** seiner Attribute ändert, und
sendet dann die aktuellen Werte **aller** seiner Zeilen. Aus einer Änderung von
drei Attributen wird also ein Aufruf, nicht drei.

#### Auslöser

| Quelle der Änderung | Löst aus |
|---|---|
| `CONTROL_REQUEST` – Homematic IP App, Zentralenprogramm | ja |
| Feld „Aktueller Status" im Einstellungsmenü | ja |
| Wert über den Daten-Endpunkt | **nein** |

Die dritte Zeile ist Absicht: Bei einer beidseitig angebundenen Fremdanwendung
entstünde sonst eine Rückkopplung – extern schreibt einen Wert, das Plugin ruft
zurück, die Fremdanwendung schreibt erneut.

Ausgelöst wird nur bei **tatsächlicher Wertänderung**. Ein Schreibvorgang mit dem
bereits gesetzten Wert erzeugt keinen Aufruf.

#### Testen

Der Knopf **Alle Aufrufe testen** setzt jeden hinterlegten Aufruf einmal ab und
zeigt je Aufruf, ob das Ziel erreichbar war. Geprüft werden die gerade im Formular
stehenden Regeln, nicht die gespeicherten – eine Adresse lässt sich also
ausprobieren, bevor sie festgeschrieben wird.

Bei Regeln mit festem Wert wird dieser gesendet, bei Durchreich-Regeln der
aktuelle Wert des Geräts. Besitzt das Gerät das Attribut noch nicht, dient der
Vorgabewert aus dem Katalog.

> Der Test setzt **echte** Aufrufe ab. Die Gegenstelle reagiert also so, als hätte
> sich der Zustand tatsächlich geändert.

#### Zustellung

| Eigenschaft | Verhalten |
|---|---|
| Methode | GET |
| Zeitlimit | 10 Sekunden je Aufruf |
| Wiederholung | keine, Fehler landen im Log |
| Gleichzeitigkeit | höchstens 8, weitere warten in einer Schlange (max. 200) |
| Zertifikate | selbstsignierte werden bei `https` akzeptiert |

Der Versand ist asynchron: Ein nicht erreichbares Ziel verzögert weder den
`CONTROL_RESPONSE` an die HCU noch das Speichern der Einstellungen.

Zeigt eine Zeile auf ein Feature, das das Gerät noch nicht besitzt,
wird es – wie bei den eingehenden Regeln – beim Speichern angelegt. Ohne das
könnte die HCU das Attribut gar nicht ansteuern und die Regel nie auslösen.

### Feature-Katalog

`constants/feature_catalog.js` enthält alle 40 Features der Connect API 1.0.1 mit
61 Attributen sowie die Zuordnung Gerätetyp → erlaubte Features. Damit stehen auch
optionale Attribute als Ziel bereit, etwa `dimming.dimLevel` oder `color.hue` bei
einer Leuchte oder die Wartungsflags `maintenance.lowBat`, `sabotage` und `unreach`
bei jedem Gerätetyp.

Zeigt eine gespeicherte Regel auf ein Feature, das das Gerät noch nicht besitzt,
wird dieses Feature dauerhaft in das Gerät übernommen und der HCU neu gemeldet.

Regeln liegen in `data/mappings.json`, geschlüsselt nach `deviceId`:

```json
{
  "version": 3,
  "devices": {
    "vardev-light-1": {
      "inbound": [],
      "outbound": [
        { "id": "…", "url": "http://host/api?on={value1}",
          "rows": [
            { "id": "…", "source": "switchState.on", "passThrough": false,
              "pairs": [{ "from": true, "to": "AN" }] }
          ] }
      ]
    }
  }
}
```

Ältere Dateien werden beim Laden überführt und zurückgeschrieben: Schema 1 hatte
die eingehenden Regeln als flaches Array, Schema 2 je ausgehender Regel eine
eigene Adresse mit dem Platzhalter `{value}`. Aus jeder solchen Regel wird ein
Aufruf mit einer Zeile, `{value}` wird zu `{value1}`. Gleich lautende Adressen
werden dabei **nicht** zusammengelegt – welche zusammengehören, ließe sich nur
raten. Wird ein Gerät gelöscht,
verschwinden beide Regelsätze mit ihm.

---

## Backup & Wiederherstellung

Beide Vorgänge laufen über einen temporären Webserver im Plugin-Container auf **Port 8744**.
Die Sitzung ist jeweils **10 Minuten** gültig; Token und URL werden pro Sitzung neu zufällig erzeugt.

### Backup erstellen

1. HCUWeb → Plugin-Einstellungen → **Backup & Wiederherstellung**
2. Aktion auf `Backup starten` setzen und speichern
3. Einstellungen erneut öffnen → der Download-Button erscheint
4. Button anklicken – die Datei `backup-<plugin-id>-v<version>-<timestamp>.json` wird einmalig heruntergeladen

### Backup einspielen

1. Aktion auf `Wiederherstellung starten` setzen und speichern
2. Einstellungen erneut öffnen → Sicherheits-Token und Link zur Upload-Seite erscheinen
3. Link öffnen, Token einfügen, Backup-Datei hochladen
4. Nach Erfolg startet das Plugin automatisch neu

> Ein Backup mit **höherer Hauptversion** als das installierte Plugin wird abgelehnt.
> Gesichert wird der komplette Inhalt von `/data` (`config.json` und `devices.json`).

---

## Update-Check

Beim Verbindungsaufbau und anschließend alle 24 Stunden fragt das Plugin das neueste
Release bzw. Tag des GitHub-Repositories ab. Ist dort eine neuere Version hinterlegt,
erscheint eine schließbare Benachrichtigung in der Homematic IP App.

Verglichen wird die `version` aus der `package.json` mit dem Release-Tag (Semantic Versioning,
ein führendes `v` wird toleriert). Der Check ist rein informativ – es wird nichts automatisch
installiert oder verändert.

---

## Kalendersteuerung

Jedes Gerät arbeitet in einer von zwei Betriebsarten, umschaltbar oben auf der
Konfigurationsseite:

| Betriebsart | Verhalten |
|---|---|
| **Daten-Endpunkt** | Werte kommen von außen herein, Änderungen lösen ausgehende Aufrufe aus |
| **Kalender** | Termine eines abonnierten Kalenders schalten das Gerät |

Die aktive Betriebsart steht auch in den HCU-Einstellungen beim Gerät.

### Kalender verbinden

Google, Outlook und iCloud bieten alle eine geheime Feed-Adresse im
iCal-Format (`.ics`) an. Damit ist für alle drei derselbe Weg möglich – ohne
Anmeldung, ohne API-Schlüssel. Die Auswahl des Anbieters blendet lediglich die
passende Anleitung ein.

| Anbieter | Wo die Adresse steht |
|---|---|
| Google | Einstellungen → Kalender auswählen → Kalender integrieren → *Geheime Adresse im iCal-Format* |
| Outlook | Kalender → Freigeben → Veröffentlichen → ICS-Link |
| iCloud | Kalender freigeben → Öffentlicher Kalender → Adresse kopieren |

> Die geheime Adresse gewährt Lesezugriff auf den Kalender und gehört wie ein
> Passwort behandelt. Bei Verdacht auf Weitergabe lässt sie sich beim Anbieter
> zurücksetzen.

`webcal://` wird automatisch auf `https://` abgebildet.

### Was bei einem Termin geschieht

Pro Gerät wird ein Attribut und ein Wert festgelegt, etwa
`setPointTemperature` auf 24. Beginnt ein Termin, sichert das Plugin den
bisherigen Wert und schreibt den eingestellten. Endet der Termin, wird der
gesicherte Wert zurückgeschrieben.

**Ausnahme:** Wurde der Wert während des Termins von Hand geändert – über die
Homematic IP App, ein Zentralenprogramm oder die Einstellungen –, bleibt diese
Änderung bestehen. Das Plugin erkennt das daran, dass der aktuelle Wert nicht
mehr dem entspricht, den es selbst gesetzt hat.

Mit einem **Stichwort** lässt sich einschränken, welche Termine auslösen: nur
Termine, deren Titel den Text enthält, Groß- und Kleinschreibung wird ignoriert.
Ohne Stichwort löst jeder Termin aus.

### Abruf

Der Kalender wird **einmal täglich** zur eingestellten Stunde abgerufen; dabei
wird ein Zeitfenster von 36 Stunden geladen. Zusätzlich gibt es den Knopf
**Jetzt abrufen**, der die Einstellungen speichert, den Feed sofort holt und
unmittelbar anwendet.

Ob ein Termin beginnt oder endet, wird **minütlich** geprüft. Änderungen, die
nach dem Abruf im Kalender vorgenommen werden, greifen erst nach dem nächsten
Abruf.

### Unterstützter Funktionsumfang des Formats

| Bereich | Umfang |
|---|---|
| Termine | `VEVENT` mit `DTSTART` und `DTEND` oder `DURATION`, ganztägig über `VALUE=DATE` |
| Wiederholungen | `FREQ=DAILY/WEEKLY/MONTHLY/YEARLY` mit `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `COUNT`, `UNTIL` |
| Ausnahmen | einzelne Termine über `EXDATE` gelöscht, über `RECURRENCE-ID` geändert |
| Zeiten | UTC (`Z`) sowie Ortszeit; `TZID` wird als Ortszeit des Containers ausgelegt |
| Format | umbrochene Zeilen und maskierte Zeichen nach RFC 5545 |

Nicht ausgewertet werden `BYSETPOS`, `BYWEEKNO` und `BYYEARDAY` – Regeln wie
„jeder dritte Donnerstag im Monat". Solche Termine werden übersprungen und im
Log vermerkt.

### Zustand

Der laufende Termin und der gesicherte Wert liegen in `data/calendar-state.json`.
Dadurch übersteht ein laufender Termin einen Neustart des Plugins: Der gesicherte
Wert bleibt erhalten und wird am Terminende korrekt zurückgeschrieben.

---

## Konfigurationsseite anpassen

Die Endpunkt-Seite ist auf drei Dateien aufgeteilt, jede mit einer Aufgabe:

| Datei | Inhalt |
|---|---|
| `html/webconfig.html` | Aufbau der Seite – ausschließlich Markup, keine Logik |
| `js/webconfig.js` | Verhalten der Seite – reines JavaScript, keine Platzhalter |
| `styles/webconfig.css` | Gestaltung – Farben als Variablen, heller und dunkler Modus |

### Aufbau der Seite

```
.container                     Rahmen, zentriert, höchstens 1470px breit
  .content                     Flex-Zeile, Karten beginnen oben auf gleicher Höhe
    .logo
    #card-lock                 Anmeldung, nur vor dem Login sichtbar
    #card-device    .js-panel  Gerätedaten, schmale Spalte links
    #card-settings  .js-panel  Einstellungen, breite Spalte rechts
```

Die beiden Karten des angemeldeten Zustands tragen die Klasse `js-panel` und
werden vom Seitenskript gemeinsam ein- und ausgeblendet.

### Sicherheit der Konfigurationsseite

Die Seite selbst wird ohne Anmeldung ausgeliefert – sie enthält aber **keine
Daten**, nur leere Container und die Oberflächentexte. Gerätedaten, Regeln, die
Anlieferungsadresse und die Kalenderadresse kommen ausschließlich über Routen,
die serverseitig einen Sitzungs-Token verlangen. Das Ein- und Ausblenden per
CSS-Klasse ist reine Darstellung und **keine** Zugriffsbeschränkung.

Zwei Punkte, die daraus folgen und umgesetzt sind:

- Beim Abmelden werden alle abgerufenen Inhalte aus dem Dokument entfernt.
  Ohne das blieben sie unter der ausgeblendeten Karte lesbar – darunter die
  Anlieferungsadresse mit Passwort und die geheime Kalenderadresse.
- Das Abmelden verwirft die Sitzung auch serverseitig (`DELETE /<id>/session`).
  Der Token wäre sonst bis zum Ablauf seiner Gültigkeit weiter verwendbar.

Die Seite wird mit folgenden Kopfzeilen ausgeliefert:

| Kopfzeile | Wert |
|---|---|
| `Content-Security-Policy` | `default-src 'none'` mit je Aufruf neuer Kennung für Skript und Gestaltung |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store` |

Die Inhaltsrichtlinie kommt ohne `unsafe-inline` aus: Skript- und Gestaltungsblock
tragen eine zufällige Kennung, die bei jedem Seitenaufruf neu erzeugt wird.

### Ziele ausgehender Verbindungen

Ausgehende Aufrufe und Kalender-Feeds richten sich ausdrücklich auch an Geräte im
Heimnetz. Private Adressbereiche bleiben deshalb erlaubt. Gesperrt sind:

| Bereich | Beispiel | Grund |
|---|---|---|
| Loopback | `127.0.0.1`, `::1`, `localhost` | der Container selbst |
| Link-Local | `169.254.0.0/16`, `fe80::/10` | darunter die Metadaten-Adresse virtueller Umgebungen |
| Sonderbereiche | `0.0.0.0/8`, Multicast | keine sinnvollen Ziele |

Hostnamen werden vor dem Verbindungsaufbau aufgelöst und anhand **aller**
zurückgegebenen Adressen bewertet; die strengste Einstufung entscheidet.

Beim Folgen einer Weiterleitung gilt zusätzlich: Eine Kette, die bei einer
öffentlichen Adresse beginnt, darf nicht auf eine private führen. Andernfalls
könnte eine von außen erreichbare Kalenderadresse auf Dienste im Heimnetz zeigen.

**TLS-Zertifikate** werden bei öffentlichen Zielen geprüft. Nur im privaten
Adressbereich wird darauf verzichtet, weil Geräte im Heimnetz üblicherweise
selbstsignierte Zertifikate verwenden.

### Passwort wechseln

Auf der Konfigurationsseite unter *Anlieferung* lässt sich ein neues Passwort
erzeugen. Die Endpunkt-Kennung bleibt dabei erhalten, die Adresse ändert sich nur
im `password`-Teil.

Nach dem Wechsel ist das bisherige Passwort ungültig, alle übrigen Sitzungen
dieses Endpunkts werden beendet und die Sperrzähler zurückgesetzt. Die eigene
Sitzung bleibt bestehen. Das neue Passwort erscheint sofort in den
HCU-Einstellungen.

> Anliefernde Systeme müssen anschließend auf die neue Adresse umgestellt werden.

### Umbruchpunkte

| Breite | Verhalten |
|---|---|
| ab 1000px | Gerätedaten und Einstellungen nebeneinander |
| unter 1000px | Karten untereinander, höchstens 640px breit |
| unter 640px | engere Abstände, Zuordnungszeilen einspaltig, Pfeil zeigt nach unten |
| unter 420px | Rahmen entfällt, Gerätedaten einspaltig, Knöpfe über volle Breite |

`src/dataEndpoint.js` lädt alle drei beim ersten Seitenaufruf und legt sie ab.

### Platzhalter der HTML-Datei

| Platzhalter | Wird ersetzt durch |
|---|---|
| `{{styles}}` | Inhalt der CSS-Datei als `<style>`-Block |
| `{{script}}` | Inhalt der JS-Datei |
| `{{textJson}}` | alle Texte der Seite als JSON-Objekt |
| `{{pluginId}}` | Plugin-Identifier, HTML-maskiert |
| `{{lang}}` | Sprachcode, HTML-maskiert |
| `{{langJson}}` | Sprachcode als JSON-Zeichenkette |
| `{{t:name}}` | einzelne Übersetzung, HTML-maskiert |

### Texte im Skript

Das Skript enthält **keine** Platzhalter. Die Seite stellt ihm alles über ein
globales Objekt bereit:

```js
window.SMX = { lang: "de", text: { mapHeadline: "Datenzuordnung", … } };
```

In `js/webconfig.js` steht das als `T.mapHeadline` zur Verfügung. Dadurch bleibt
die Datei gültiges JavaScript und lässt sich mit Linter, Formatierer und
Syntaxhervorhebung bearbeiten.

Ein neuer Text braucht drei Schritte: Eintrag in `lang/localization.json`,
Zuordnung des Kurznamens in `PAGE_KEYS` in `dataEndpoint.js`, dann Verwendung –
im Markup als `{{t:name}}`, im Skript als `T.name`.

Fehlt eine der Dateien, liefert das Plugin eine schlichte Ersatzseite mit Hinweis
statt eines Serverfehlers.

---

## Lokalisierung

Alle Texte des Plugins liegen in `lang/localization.json`, nach Sprache und Schlüssel
sortiert. Geladen werden sie über `src/localization.js`.

```json
{
  "de": { "group.general.name": "Allgemein" },
  "en": { "group.general.name": "General" }
}
```

Die HCU sendet den gewünschten Sprachcode als `body.languageCode` in jedem
`CONFIG_TEMPLATE_REQUEST` und `CONFIG_UPDATE_REQUEST`. Die Konfigurationsseite des
Endpunkts übernimmt ihn als Parameter `hl` und hängt ihn an ihre eigenen Anfragen an.

Platzhalter der Form `{name}` werden zur Laufzeit ersetzt, etwa `{num}` für die
Nummer der Variablen oder `{value}` in Fehlermeldungen.

Fehlt ein Schlüssel in der gewünschten Sprache, greift Deutsch; fehlt er auch dort,
wird der Schlüssel selbst ausgegeben, damit die Oberfläche nie leer bleibt.

Eine weitere Sprache ergänzt man, indem man in der `localization.json` einen Block
mit dem entsprechenden ISO-639-1-Kürzel anlegt. Die Texte der drei eingebundenen
Bibliotheken bleiben davon unberührt, damit diese austauschbar bleiben.

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2025 Kevin Schipper
