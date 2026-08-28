#!/bin/bash
# Import automatique des conversations Claude Code + Codex dans Memoria.
# Lancé périodiquement par launchd (voir fr.primo-studio.memoria.autoimport.plist).
# Les souvenirs extraits arrivent DORMANTS → à valider dans l'écran Revue.
# Idempotent : seules les NOUVELLES fenêtres de conversation sont analysées.
set -u

# Tout est surchargeable par l'environnement (défauts = poste de Néto) : c'est
# ce qui rend le script TESTABLE sans daemon réel ni ~/.memoria, et portable
# sur une autre machine sans l'éditer.
#   MEMORIA_NODE      binaire node          MEMORIA_REPO_DIR  dépôt (CLI construite)
#   MEMORIA_CLI       bin.js de la CLI      MEMORIA_HOME      dossier de données (daemon.json)
#   MEMORIA_AUTO_IMPORT_LOG  journal
#   MEMORIA_AUTO_IMPORT_POLL_S      sonde « import en cours ? » toutes les N s (défaut 10)
#   MEMORIA_AUTO_IMPORT_MAX_WAIT_S  attente max d'un import concurrent (défaut 7200 = 2 h)
NODE="${MEMORIA_NODE:-/Users/primostudio/.nvm/versions/node/v22.22.2/bin/node}"
ROOT="${MEMORIA_REPO_DIR:-/Users/primostudio/openclaw-memoria}"
CLI="${MEMORIA_CLI:-$ROOT/packages/cli/dist/bin.js}"
DATA="${MEMORIA_HOME:-$HOME/.memoria/data}"
LOG="${MEMORIA_AUTO_IMPORT_LOG:-$HOME/.memoria/auto-import.log}"
POLL_S="${MEMORIA_AUTO_IMPORT_POLL_S:-10}"
MAX_WAIT_S="${MEMORIA_AUTO_IMPORT_MAX_WAIT_S:-7200}"
DAEMON_JSON="$DATA/daemon.json"

# Option : passer N (fenêtres max par fichier, transmis en --max-windows N) en 1er
# argument NU pour limiter le coût — ex. « auto-import.sh 1 » (test). Pas « --max-windows ».
MAXW="${1:-}"

log() { echo "$*" >> "$LOG"; }

log "=== auto-import $(date) ==="

if [ ! -f "$DAEMON_JSON" ]; then
  log "daemon.json absent — Memoria ne tourne pas, on saute."
  exit 0
fi

# Découvre les instances claude-code + codex (non révoquées) via l'API locale.
IDS=$(DAEMON_JSON="$DAEMON_JSON" "$NODE" -e '
const fs=require("fs"),http=require("http");
const d=JSON.parse(fs.readFileSync(process.env.DAEMON_JSON));
http.get({host:"127.0.0.1",port:d.port,path:"/v1/admin/agents",headers:{Authorization:"Bearer "+d.admin_token}},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>{try{const j=JSON.parse(b);const ids=(j.agents||j).filter(a=>["claude-code","codex"].includes(a.assistant_type)&&!a.instance.revoked_at).map(a=>a.instance.id);process.stdout.write(ids.join(" "))}catch(e){}})}).on("error",()=>{});
' 2>>"$LOG")

if [ -z "$IDS" ]; then
  log "aucune instance claude-code/codex trouvée."
  exit 0
fi

# État du job d'import du daemon : running / idle / done / error / interrupted,
# ou « unknown » si l'API ne répond pas (5 s) — on ne bloque jamais là-dessus.
import_state() {
  DAEMON_JSON="$DAEMON_JSON" "$NODE" -e '
const fs=require("fs"),http=require("http");
const d=JSON.parse(fs.readFileSync(process.env.DAEMON_JSON));
let done=false;const say=s=>{if(!done){done=true;process.stdout.write(s)}};
const req=http.get({host:"127.0.0.1",port:d.port,path:"/v1/admin/import_status",headers:{Authorization:"Bearer "+d.admin_token},timeout:5000},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>{try{say(String(JSON.parse(b).state||"unknown"))}catch(e){say("unknown")}})});
req.on("error",()=>say("unknown"));
req.on("timeout",()=>{say("unknown");req.destroy()});
' 2>>"$LOG"
}

# Un seul job d'import à la fois dans le daemon (409 sinon) : le job de
# l'instance précédente — ou un import lancé depuis l'UI — peut durer des
# heures. On attend sa fin (sonde toutes les POLL_S s) plutôt que d'échouer.
# Retourne 1 si toujours occupé après MAX_WAIT_S s.
wait_import_free() {
  local waited=0 state
  state=$(import_state)
  if [ "$state" != "running" ]; then
    return 0
  fi
  log "un import est déjà en cours dans le daemon — on attend sa fin (sonde toutes les ${POLL_S} s, plafond ${MAX_WAIT_S} s)…"
  while [ "$state" = "running" ]; do
    if [ "$waited" -ge "$MAX_WAIT_S" ]; then
      log "toujours en cours après ${waited} s — on n'insiste pas pour ce passage."
      return 1
    fi
    sleep "$POLL_S"
    waited=$((waited + POLL_S))
    state=$(import_state)
  done
  log "import précédent terminé (${state}) après ~${waited} s — on enchaîne."
  return 0
}

for INST in $IDS; do
  if ! wait_import_free; then
    log "import $INST sauté (daemon occupé) — prochain passage."
    continue
  fi
  log "-- import $INST $( [ -n "$MAXW" ] && echo "(max-windows $MAXW)" ) --"
  if [ -n "$MAXW" ]; then
    "$NODE" "$CLI" import --instance "$INST" --transcripts --max-windows "$MAXW" >> "$LOG" 2>&1 || log "import $INST échoué"
  else
    "$NODE" "$CLI" import --instance "$INST" --transcripts >> "$LOG" 2>&1 || log "import $INST échoué"
  fi
done

log "=== fin $(date) ==="
