#!/bin/bash
# Import automatique des conversations Claude Code + Codex dans Memoria.
# Lancé périodiquement par launchd (voir fr.primo-studio.memoria.autoimport.plist).
# Les souvenirs extraits arrivent DORMANTS → à valider dans l'écran Revue.
# Idempotent : seules les NOUVELLES fenêtres de conversation sont analysées.
set -u

NODE="/Users/primostudio/.nvm/versions/node/v22.22.2/bin/node"
ROOT="/Users/primostudio/openclaw-memoria"
CLI="$ROOT/packages/cli/dist/bin.js"
LOG="$HOME/.memoria/auto-import.log"
DAEMON_JSON="$HOME/.memoria/data/daemon.json"

# Option : passer --max-windows N en 1er argument pour limiter le coût (test).
MAXW="${1:-}"

echo "=== auto-import $(date) ===" >> "$LOG"

if [ ! -f "$DAEMON_JSON" ]; then
  echo "daemon.json absent — Memoria ne tourne pas, on saute." >> "$LOG"
  exit 0
fi

# Découvre les instances claude-code + codex (non révoquées) via l'API locale.
IDS=$("$NODE" -e '
const fs=require("fs"),http=require("http");
const d=JSON.parse(fs.readFileSync(process.env.HOME+"/.memoria/data/daemon.json"));
http.get({host:"127.0.0.1",port:d.port,path:"/v1/admin/agents",headers:{Authorization:"Bearer "+d.admin_token}},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>{try{const j=JSON.parse(b);const ids=(j.agents||j).filter(a=>["claude-code","codex"].includes(a.assistant_type)&&!a.instance.revoked_at).map(a=>a.instance.id);process.stdout.write(ids.join(" "))}catch(e){}})}).on("error",()=>{});
' 2>>"$LOG")

if [ -z "$IDS" ]; then
  echo "aucune instance claude-code/codex trouvée." >> "$LOG"
  exit 0
fi

for INST in $IDS; do
  echo "-- import $INST $( [ -n "$MAXW" ] && echo "(max-windows $MAXW)" ) --" >> "$LOG"
  if [ -n "$MAXW" ]; then
    "$NODE" "$CLI" import --instance "$INST" --transcripts --max-windows "$MAXW" >> "$LOG" 2>&1 || echo "import $INST échoué" >> "$LOG"
  else
    "$NODE" "$CLI" import --instance "$INST" --transcripts >> "$LOG" 2>&1 || echo "import $INST échoué" >> "$LOG"
  fi
done

echo "=== fin $(date) ===" >> "$LOG"
