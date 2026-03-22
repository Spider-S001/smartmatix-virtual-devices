# Basis-Image der HCU (ARM64 – Pflicht für Deployment auf der HCU)
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Abhängigkeiten installieren
COPY package*.json ./
RUN npm install --omit=dev

# Quellcode kopieren
COPY src/ ./src/
COPY constants/ ./constants/

# Einstiegspunkt:
#   Argument 1: Plugin-ID
#   Argument 2: HCU-Host (host.containers.internal = HCU selbst)
#   Argument 3: Pfad zur Auth-Token-Datei (von der HCU bereitgestellt unter /TOKEN)
ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.virtual-devices", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion mindestens 1.5.16 für Connect API 1.0.1
#  scope         LOCAL = nur im lokalen Netzwerk
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.virtual-devices",\
  "issuer": "Kevin Schipper",\
  "version": "1.0.0",\
  "hcuMinVersion": "1.5.16",\
  "scope": "LOCAL",\
  "friendlyName": {\
    "en": "SmartMatix Virtual Devices",\
    "de": "SmartMatix Virtuelle Geräte"\
  },\
  "description": {\
    "en": "A plugin for creating and editing virtual devices as variables.",\
    "de": "Ein Plugin zur Erstellung und dem Bearbeiten von virtuellen Geräten als Variablen."\
  },\
  "image": "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",\
  "logsEnabled": true\
}'
