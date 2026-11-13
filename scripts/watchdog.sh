#!/bin/bash
# Surveillance du daemon Memoria (ticket #27).
# Lancé chaque minute par launchd (voir fr.primo-studio.memoria.watchdog.plist).
# Interroge /v1/health ; après 3 contrôles ratés de suite, affiche une
# notification. Deux pannes sont restées invisibles pendant des jours : le
# daemon arrêté derrière un verrou périmé, et le daemon « vivant » mais bloqué.
# Ce script ne redémarre rien : il prévient, c'est tout.
set -u

# Tout est surchargeable par l'environnement (testable sans daemon réel).
#   MEMORIA_HOME                 dossier de données (daemon.json)
#   MEMORIA_WATCHDOG_STATE       compteur d'échecs consécutifs
#   MEMORIA_WATCHDOG_LOG         journal
#   MEMORIA_WATCHDOG_TIMEOUT_S   délai d'une sonde (défaut 10)
#   MEMORIA_WATCHDOG_THRESHOLD   échecs de suite avant d'alerter (défaut 3)
#   MEMORIA_WATCHDOG_REPEAT      rappel tous les N échecs ensuite (défaut 60 = 1 h)
#   MEMORIA_WATCHDOG_NOTIFY      commande d'alerte, reçoit le message en $1
DATA="${MEMORIA_HOME:-$HOME/.memoria/data}"
STATE="${MEMORIA_WATCHDOG_STATE:-$HOME/.memoria/watchdog.state}"
LOG="${MEMORIA_WATCHDOG_LOG:-$HOME/.memoria/watchdog.log}"
TIMEOUT_S="${MEMORIA_WATCHDOG_TIMEOUT_S:-10}"
THRESHOLD="${MEMORIA_WATCHDOG_THRESHOLD:-3}"
REPEAT="${MEMORIA_WATCHDOG_REPEAT:-60}"
DAEMON_JSON="$DATA/daemon.json"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

notify() {
  if [ -n "${MEMORIA_WATCHDOG_NOTIFY:-}" ]; then
    "$MEMORIA_WATCHDOG_NOTIFY" "$1"
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Memoria\"" >/dev/null 2>&1
  fi
}

# Une sonde : 0 = le daemon répond, 1 = non. `reason` dit pourquoi.
reason=""
probe() {
  if [ ! -f "$DAEMON_JSON" ]; then
    reason="daemon arrêté (daemon.json absent)"
    return 1
  fi
  local port
  port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DAEMON_JSON" | head -1)
  if [ -z "$port" ]; then
    reason="daemon.json illisible"
    return 1
  fi
  if curl -s -f -o /dev/null -m "$TIMEOUT_S" "http://127.0.0.1:$port/v1/health"; then
    return 0
  fi
  reason="aucune réponse en ${TIMEOUT_S} s sur le port $port"
  return 1
}

fails=0
[ -f "$STATE" ] && fails=$(tr -cd '0-9' < "$STATE")
fails=${fails:-0}

if probe; then
  if [ "$fails" -ge "$THRESHOLD" ]; then
    log "rétabli après $fails contrôle(s) raté(s)"
    notify "La mémoire répond de nouveau."
  fi
  echo 0 > "$STATE"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$STATE"
log "contrôle raté $fails : $reason"
if [ "$fails" -eq "$THRESHOLD" ] || { [ "$fails" -gt "$THRESHOLD" ] && [ $(( (fails - THRESHOLD) % REPEAT )) -eq 0 ]; }; then
  notify "La mémoire ne répond plus depuis $fails contrôles : $reason."
fi
exit 0
