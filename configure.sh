#!/bin/bash
# Memoria — Post-install reconfiguration wizard
# Usage: bash configure.sh                    (interactive)
#        bash configure.sh --preset local-only (silent)
#        bash configure.sh --show              (show current config)
set -e

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${CYAN}ℹ️  $1${NC}"; }
h1()   { echo -e "\n${BOLD}$1${NC}"; }

CONFIG_FILE="$HOME/.openclaw/openclaw.json"
PLUGIN_DIR="$HOME/.openclaw/extensions/memoria"
DB_FILE="$HOME/.openclaw/workspace/memory/memoria.db"

# ─── Preflight ───

[ -f "$CONFIG_FILE" ] || fail "openclaw.json introuvable ($CONFIG_FILE)"
[ -d "$PLUGIN_DIR" ]  || fail "Memoria non installé ($PLUGIN_DIR)"

# ─── Parse CLI args ───

PRESET=""
SILENT=false
SHOW_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --preset=*) PRESET="${arg#*=}" ;;
    --show|-s) SHOW_ONLY=true ;;
    --yes|-y) SILENT=true ;;
    local-only|cloud-first|paranoid) PRESET="$arg" ;;
  esac
done

# ─── Read current config ───

read_current_config() {
  python3 << 'PYEOF'
import json, os, sys

config_path = os.path.expanduser("~/.openclaw/openclaw.json")
with open(config_path) as f:
    cfg = json.load(f)

memoria = cfg.get("plugins", {}).get("entries", {}).get("memoria", {})
pcfg = memoria.get("config", {})

# LLM
llm = pcfg.get("llm", {})
print(f"LLM_PROVIDER={llm.get('provider', 'ollama')}")
print(f"LLM_MODEL={llm.get('model', 'gemma3:4b')}")

# Embed
embed = pcfg.get("embed", {})
print(f"EMBED_PROVIDER={embed.get('provider', 'ollama')}")
print(f"EMBED_MODEL={embed.get('model', 'nomic-embed-text-v2-moe')}")
print(f"EMBED_DIMS={embed.get('dimensions', 768)}")

# Fallback
fb = pcfg.get("fallback", [])
providers = " > ".join([f"{f.get('provider','?')}/{f.get('model','?')}" for f in fb]) if fb else "aucun"
print(f"FALLBACK_CHAIN='{providers}'")
print(f"FALLBACK_COUNT={len(fb)}")

# Limits
print(f"RECALL_LIMIT={pcfg.get('recallLimit', 12)}")
print(f"CAPTURE_MAX={pcfg.get('captureMaxFacts', 8)}")
print(f"CONTEXT_WINDOW={pcfg.get('contextWindow', 200000)}")
print(f"SYNC_MD={pcfg.get('syncMd', True)}")
print(f"AUTO_RECALL={pcfg.get('autoRecall', True)}")
print(f"AUTO_CAPTURE={pcfg.get('autoCapture', True)}")

# Observations
obs = pcfg.get("observations", {})
print(f"OBS_EMERGENCE={obs.get('emergenceThreshold', 3)}")
print(f"OBS_MATCH={obs.get('matchThreshold', 0.6)}")
print(f"OBS_MAX_RECALL={obs.get('maxRecallObservations', 5)}")

# Enabled
print(f"ENABLED={memoria.get('enabled', False)}")
PYEOF
}

eval "$(read_current_config)"

# ─── --show: display current config and exit ───

if [ "$SHOW_ONLY" = true ]; then
  echo ""
  echo -e "${BOLD}🧠 Memoria — Configuration actuelle${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo -e "  ${BOLD}Activé${NC}          $ENABLED"
  echo -e "  ${BOLD}LLM${NC}             $LLM_PROVIDER / $LLM_MODEL"
  echo -e "  ${BOLD}Embeddings${NC}      $EMBED_PROVIDER / $EMBED_MODEL (${EMBED_DIMS}d)"
  echo -e "  ${BOLD}Fallback${NC}        $FALLBACK_CHAIN"
  echo -e "  ${BOLD}Recall limit${NC}    $RECALL_LIMIT"
  echo -e "  ${BOLD}Capture max${NC}     $CAPTURE_MAX"
  echo -e "  ${BOLD}Context window${NC}  $CONTEXT_WINDOW"
  echo -e "  ${BOLD}Sync .md${NC}        $SYNC_MD"
  echo -e "  ${BOLD}Auto-recall${NC}     $AUTO_RECALL"
  echo -e "  ${BOLD}Auto-capture${NC}    $AUTO_CAPTURE"
  echo ""
  echo -e "  ${BOLD}Observations${NC}"
  echo -e "    Emergence  : ${OBS_EMERGENCE} faits min"
  echo -e "    Match      : ${OBS_MATCH} (cosine)"
  echo -e "    Max recall : ${OBS_MAX_RECALL}"
  echo ""

  if [ -f "$DB_FILE" ]; then
    FACTS=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM facts WHERE superseded=0" 2>/dev/null || echo "?")
    OBS_COUNT=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM observations" 2>/dev/null || echo "?")
    EMBEDDED=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM embeddings" 2>/dev/null || echo "?")
    echo -e "  ${BOLD}Base de données${NC}"
    echo -e "    Faits actifs   : $FACTS"
    echo -e "    Observations   : $OBS_COUNT"
    echo -e "    Embedded       : $EMBEDDED"
    echo -e "    Fichier        : $DB_FILE"
    echo ""
  fi

  echo -e "  ${DIM}Modifier : bash configure.sh${NC}"
  echo -e "  ${DIM}Config   : $CONFIG_FILE${NC}"
  echo ""
  exit 0
fi

# ─── Detect environment ───

echo ""
echo -e "${BOLD}🧠 Memoria — Reconfiguration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

h1 "📋 Configuration actuelle :"
echo ""
echo -e "  LLM :        $LLM_PROVIDER / $LLM_MODEL"
echo -e "  Embeddings : $EMBED_PROVIDER / $EMBED_MODEL"
echo -e "  Fallback :   $FALLBACK_CHAIN"
echo -e "  Limits :     recall=$RECALL_LIMIT, capture=$CAPTURE_MAX, ctx=$CONTEXT_WINDOW"
echo ""

# Detect available providers
OLLAMA_BIN=""
HAS_OLLAMA=false
OLLAMA_RUNNING=false
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="ollama"
elif [ -f "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
fi
if [ -n "$OLLAMA_BIN" ]; then
  HAS_OLLAMA=true
  if curl -s --connect-timeout 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    OLLAMA_RUNNING=true
  fi
fi

HAS_LMSTUDIO=false
if curl -s --connect-timeout 2 http://localhost:1234/v1/models >/dev/null 2>&1; then
  HAS_LMSTUDIO=true
fi

HAS_OPENAI=false
[ -n "$OPENAI_API_KEY" ] && HAS_OPENAI=true

# ─── Preset mode ───

NEW_LLM_MODE=""
NEW_FALLBACK_MODE=""

if [ -n "$PRESET" ]; then
  case "$PRESET" in
    local-only)   NEW_LLM_MODE="local"; NEW_FALLBACK_MODE="recommended" ;;
    cloud-first)  NEW_LLM_MODE="cloud"; NEW_FALLBACK_MODE="recommended" ;;
    paranoid)     NEW_LLM_MODE="local"; NEW_FALLBACK_MODE="strict" ;;
    *)            warn "Preset inconnu: $PRESET"; exit 1 ;;
  esac
  info "Preset: $PRESET"
else

  # ─── Interactive: What to change? ───

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  h1 "❓ Que voulez-vous modifier ?"
  echo ""
  echo -e "  ${BOLD}1)${NC} 🔄 Tout reconfigurer ${DIM}(mode wizard complet)${NC}"
  echo -e "  ${BOLD}2)${NC} 🧠 LLM uniquement ${DIM}(provider + modèle)${NC}"
  echo -e "  ${BOLD}3)${NC} 📊 Limites uniquement ${DIM}(recall, capture, context window)${NC}"
  echo -e "  ${BOLD}4)${NC} 🔮 Observations ${DIM}(emergence, seuils)${NC}"
  echo -e "  ${BOLD}5)${NC} 🛡️  Fallback chain uniquement"
  echo ""
  read -r -p "  Choix [1] : " WHAT </dev/tty 2>/dev/null || WHAT="1"
  WHAT=${WHAT:-1}

  case "$WHAT" in
    2)
      # LLM only
      echo ""
      h1 "🧠 Choix du LLM :"
      echo ""
      echo -e "  ${BOLD}1)${NC} 🏠 Ollama + gemma3:4b ${DIM}(local, 0€)${NC}"
      echo -e "  ${BOLD}2)${NC} ☁️  OpenAI + gpt-5.4-nano ${DIM}(~\$0.50/mois)${NC}"
      echo -e "  ${BOLD}3)${NC} 💻 LM Studio ${DIM}(local)${NC}"
      echo -e "  ${BOLD}4)${NC} 🌐 OpenRouter"
      echo -e "  ${BOLD}5)${NC} ✏️  Personnalisé"
      echo ""
      read -r -p "  Choix [1] : " LLM_C </dev/tty 2>/dev/null || LLM_C="1"
      LLM_C=${LLM_C:-1}

      NEW_LLM_PROVIDER=""
      NEW_LLM_MODEL=""
      case "$LLM_C" in
        2)
          NEW_LLM_PROVIDER="openai"; NEW_LLM_MODEL="gpt-5.4-nano"
          if [ "$HAS_OPENAI" != true ]; then
            read -r -p "  Clé OpenAI : " OPENAI_INPUT </dev/tty 2>/dev/null || OPENAI_INPUT=""
            [ -n "$OPENAI_INPUT" ] && export OPENAI_API_KEY="$OPENAI_INPUT" && HAS_OPENAI=true
          fi
          ;;
        3) NEW_LLM_PROVIDER="lmstudio"; NEW_LLM_MODEL="auto" ;;
        4)
          NEW_LLM_PROVIDER="openrouter"
          read -r -p "  Modèle OpenRouter [auto] : " OR_MODEL </dev/tty 2>/dev/null || OR_MODEL="auto"
          NEW_LLM_MODEL="${OR_MODEL:-auto}"
          ;;
        5)
          read -r -p "  Provider (ollama/openai/lmstudio/openrouter) : " NEW_LLM_PROVIDER </dev/tty 2>/dev/null
          read -r -p "  Modèle : " NEW_LLM_MODEL </dev/tty 2>/dev/null
          ;;
        *) NEW_LLM_PROVIDER="ollama"; NEW_LLM_MODEL="gemma3:4b" ;;
      esac

      # Apply LLM-only change
      python3 << PYEOF
import json, os, shutil

path = os.path.expanduser("~/.openclaw/openclaw.json")
shutil.copy2(path, path + ".backup")
with open(path) as f:
    cfg = json.load(f)

pcfg = cfg["plugins"]["entries"]["memoria"].setdefault("config", {})
pcfg["llm"] = {"provider": "$NEW_LLM_PROVIDER", "model": "$NEW_LLM_MODEL"}

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("  ✅ LLM mis à jour : $NEW_LLM_PROVIDER / $NEW_LLM_MODEL")
PYEOF
      echo ""
      echo -e "  ${BOLD}🚀${NC} openclaw gateway restart"
      echo ""
      exit 0
      ;;

    3)
      # Limits only
      echo ""
      h1 "📊 Limites :"
      echo ""
      read -r -p "  Recall limit [$RECALL_LIMIT] : " NEW_RL </dev/tty 2>/dev/null || NEW_RL=""
      read -r -p "  Capture max [$CAPTURE_MAX] : " NEW_CM </dev/tty 2>/dev/null || NEW_CM=""
      read -r -p "  Context window [$CONTEXT_WINDOW] : " NEW_CW </dev/tty 2>/dev/null || NEW_CW=""

      NEW_RL=${NEW_RL:-$RECALL_LIMIT}
      NEW_CM=${NEW_CM:-$CAPTURE_MAX}
      NEW_CW=${NEW_CW:-$CONTEXT_WINDOW}

      python3 << PYEOF
import json, os, shutil

path = os.path.expanduser("~/.openclaw/openclaw.json")
shutil.copy2(path, path + ".backup")
with open(path) as f:
    cfg = json.load(f)

pcfg = cfg["plugins"]["entries"]["memoria"].setdefault("config", {})
pcfg["recallLimit"] = int("$NEW_RL")
pcfg["captureMaxFacts"] = int("$NEW_CM")
pcfg["contextWindow"] = int("$NEW_CW")

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"  ✅ Limites : recall={int('$NEW_RL')}, capture={int('$NEW_CM')}, ctx={int('$NEW_CW')}")
PYEOF
      echo ""
      echo -e "  ${BOLD}🚀${NC} openclaw gateway restart"
      echo ""
      exit 0
      ;;

    4)
      # Observations only
      echo ""
      h1 "🔮 Observations :"
      echo ""
      echo -e "  ${DIM}emergenceThreshold = min faits pour créer une observation${NC}"
      read -r -p "  Emergence threshold [$OBS_EMERGENCE] : " NEW_OE </dev/tty 2>/dev/null || NEW_OE=""
      echo -e "  ${DIM}matchThreshold = similarité cosine pour update${NC}"
      read -r -p "  Match threshold [$OBS_MATCH] : " NEW_OM </dev/tty 2>/dev/null || NEW_OM=""
      echo -e "  ${DIM}maxRecallObservations = nb max injectées au recall${NC}"
      read -r -p "  Max recall observations [$OBS_MAX_RECALL] : " NEW_OR </dev/tty 2>/dev/null || NEW_OR=""

      NEW_OE=${NEW_OE:-$OBS_EMERGENCE}
      NEW_OM=${NEW_OM:-$OBS_MATCH}
      NEW_OR=${NEW_OR:-$OBS_MAX_RECALL}

      python3 << PYEOF
import json, os, shutil

path = os.path.expanduser("~/.openclaw/openclaw.json")
shutil.copy2(path, path + ".backup")
with open(path) as f:
    cfg = json.load(f)

pcfg = cfg["plugins"]["entries"]["memoria"].setdefault("config", {})
pcfg["observations"] = {
    "emergenceThreshold": int("$NEW_OE"),
    "matchThreshold": float("$NEW_OM"),
    "maxRecallObservations": int("$NEW_OR")
}

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"  ✅ Observations : emergence={int('$NEW_OE')}, match={float('$NEW_OM')}, maxRecall={int('$NEW_OR')}")
PYEOF
      echo ""
      echo -e "  ${BOLD}🚀${NC} openclaw gateway restart"
      echo ""
      exit 0
      ;;

    5)
      # Fallback only
      echo ""
      h1 "🛡️ Fallback chain :"
      echo ""
      echo -e "  Actuel : $FALLBACK_CHAIN"
      echo ""
      echo -e "  ${BOLD}1)${NC} 🏠 Ollama → LM Studio ${DIM}(tout local)${NC}"
      echo -e "  ${BOLD}2)${NC} 🏠 Ollama → OpenAI → LM Studio ${DIM}(avec cloud backup)${NC}"
      echo -e "  ${BOLD}3)${NC} ☁️  OpenAI → Ollama"
      echo -e "  ${BOLD}4)${NC} 🔒 Provider unique ${DIM}(pas de fallback)${NC}"
      echo ""
      read -r -p "  Choix [1] : " FB_C </dev/tty 2>/dev/null || FB_C="1"
      FB_C=${FB_C:-1}

      python3 << PYEOF
import json, os, shutil

path = os.path.expanduser("~/.openclaw/openclaw.json")
shutil.copy2(path, path + ".backup")
with open(path) as f:
    cfg = json.load(f)

pcfg = cfg["plugins"]["entries"]["memoria"].setdefault("config", {})

choice = "$FB_C"
if choice == "1":
    pcfg["fallback"] = [
        {"provider": "ollama", "model": "gemma3:4b"},
        {"provider": "lmstudio", "model": "auto"}
    ]
    desc = "Ollama → LM Studio"
elif choice == "2":
    pcfg["fallback"] = [
        {"provider": "ollama", "model": "gemma3:4b"},
        {"provider": "openai", "model": "gpt-5.4-nano"},
        {"provider": "lmstudio", "model": "auto"}
    ]
    desc = "Ollama → OpenAI → LM Studio"
elif choice == "3":
    pcfg["fallback"] = [
        {"provider": "openai", "model": "gpt-5.4-nano"},
        {"provider": "ollama", "model": "gemma3:4b"}
    ]
    desc = "OpenAI → Ollama"
elif choice == "4":
    llm = pcfg.get("llm", {"provider": "ollama", "model": "gemma3:4b"})
    pcfg["fallback"] = [{"provider": llm["provider"], "model": llm["model"]}]
    desc = f"{llm['provider']} uniquement (strict)"
else:
    desc = "inchangé"

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"  ✅ Fallback : {desc}")
PYEOF
      echo ""
      echo -e "  ${BOLD}🚀${NC} openclaw gateway restart"
      echo ""
      exit 0
      ;;

    *)
      # Full wizard → continue below
      ;;
  esac

  # ─── Full wizard (option 1) ───

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  h1 "❓ Mode LLM :"
  echo ""
  echo -e "  ${BOLD}1)${NC} 🏠 ${GREEN}100% Local${NC} — Ollama + gemma3:4b ${DIM}(recommandé)${NC}"
  if [ "$HAS_OPENAI" = true ]; then
    echo -e "  ${BOLD}2)${NC} ☁️  Cloud — OpenAI + fallback Ollama"
  else
    echo -e "  ${BOLD}2)${NC} ☁️  ${DIM}Cloud — nécessite clé OpenAI${NC}"
  fi
  echo ""
  read -r -p "  Choix [1] : " LLM_CHOICE </dev/tty 2>/dev/null || LLM_CHOICE="1"
  LLM_CHOICE=${LLM_CHOICE:-1}

  case "$LLM_CHOICE" in
    2)
      if [ "$HAS_OPENAI" = true ]; then
        NEW_LLM_MODE="cloud"
      else
        read -r -p "  Clé OpenAI : " OPENAI_INPUT </dev/tty 2>/dev/null || OPENAI_INPUT=""
        if [ -n "$OPENAI_INPUT" ]; then
          export OPENAI_API_KEY="$OPENAI_INPUT"
          NEW_LLM_MODE="cloud"
        else
          warn "Pas de clé → mode local"
          NEW_LLM_MODE="local"
        fi
      fi
      ;;
    *) NEW_LLM_MODE="local" ;;
  esac

  echo ""
  h1 "❓ Fallback :"
  echo ""
  echo -e "  ${BOLD}1)${NC} 🛡️  ${GREEN}Fallback automatique${NC} ${DIM}(recommandé)${NC}"
  echo -e "  ${BOLD}2)${NC} 🔒 Mode strict"
  echo ""
  read -r -p "  Choix [1] : " FB_CHOICE </dev/tty 2>/dev/null || FB_CHOICE="1"
  case "${FB_CHOICE:-1}" in
    2) NEW_FALLBACK_MODE="strict" ;;
    *) NEW_FALLBACK_MODE="recommended" ;;
  esac

  # Limits
  echo ""
  h1 "📊 Limites (Entrée = garder actuel) :"
  echo ""
  read -r -p "  Recall limit [$RECALL_LIMIT] : " NEW_RL </dev/tty 2>/dev/null || NEW_RL=""
  read -r -p "  Capture max [$CAPTURE_MAX] : " NEW_CM </dev/tty 2>/dev/null || NEW_CM=""
  read -r -p "  Context window [$CONTEXT_WINDOW] : " NEW_CW </dev/tty 2>/dev/null || NEW_CW=""
  NEW_RL=${NEW_RL:-$RECALL_LIMIT}
  NEW_CM=${NEW_CM:-$CAPTURE_MAX}
  NEW_CW=${NEW_CW:-$CONTEXT_WINDOW}

  # Observations
  echo ""
  h1 "🔮 Observations (Entrée = garder actuel) :"
  echo ""
  read -r -p "  Emergence threshold [$OBS_EMERGENCE] : " NEW_OE </dev/tty 2>/dev/null || NEW_OE=""
  read -r -p "  Match threshold [$OBS_MATCH] : " NEW_OM </dev/tty 2>/dev/null || NEW_OM=""
  read -r -p "  Max recall observations [$OBS_MAX_RECALL] : " NEW_OR </dev/tty 2>/dev/null || NEW_OR=""
  NEW_OE=${NEW_OE:-$OBS_EMERGENCE}
  NEW_OM=${NEW_OM:-$OBS_MATCH}
  NEW_OR=${NEW_OR:-$OBS_MAX_RECALL}
fi

# ─── Apply full config ───

python3 << PYEOF
import json, os, shutil

path = os.path.expanduser("~/.openclaw/openclaw.json")
shutil.copy2(path, path + ".backup")
with open(path) as f:
    cfg = json.load(f)

llm_mode = "$NEW_LLM_MODE"
fallback_mode = "$NEW_FALLBACK_MODE"
recall = int("${NEW_RL:-12}")
capture = int("${NEW_CM:-8}")
ctx = int("${NEW_CW:-200000}")
obs_e = int("${NEW_OE:-3}")
obs_m = float("${NEW_OM:-0.6}")
obs_r = int("${NEW_OR:-5}")

pcfg = {
    "autoRecall": True,
    "autoCapture": True,
    "syncMd": True,
    "recallLimit": recall,
    "captureMaxFacts": capture,
    "contextWindow": ctx,
}

if llm_mode == "local":
    pcfg["llm"] = {"provider": "ollama", "model": "gemma3:4b"}
    pcfg["embed"] = {"provider": "ollama", "model": "nomic-embed-text-v2-moe", "dimensions": 768}
    if fallback_mode == "recommended":
        pcfg["fallback"] = [
            {"provider": "ollama", "model": "gemma3:4b"},
            {"provider": "lmstudio", "model": "auto"}
        ]
    else:
        pcfg["fallback"] = [{"provider": "ollama", "model": "gemma3:4b"}]
elif llm_mode == "cloud":
    pcfg["llm"] = {"provider": "openai", "model": "gpt-5.4-nano"}
    pcfg["embed"] = {"provider": "ollama", "model": "nomic-embed-text-v2-moe", "dimensions": 768}
    if fallback_mode == "recommended":
        pcfg["fallback"] = [
            {"provider": "openai", "model": "gpt-5.4-nano"},
            {"provider": "ollama", "model": "gemma3:4b"}
        ]
    else:
        pcfg["fallback"] = [{"provider": "openai", "model": "gpt-5.4-nano"}]

pcfg["observations"] = {
    "emergenceThreshold": obs_e,
    "matchThreshold": obs_m,
    "maxRecallObservations": obs_r
}

cfg["plugins"]["entries"]["memoria"]["config"] = pcfg

with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

# Summary
mode_str = "🏠 Local (0€)" if llm_mode == "local" else "☁️ Cloud"
llm_str = pcfg["llm"]["provider"] + " / " + pcfg["llm"]["model"]
fb_str = " → ".join([f"{f['provider']}/{f['model']}" for f in pcfg.get("fallback", [])])

print(f"\n  ✅ Configuration mise à jour !")
print(f"")
print(f"  Mode :        {mode_str}")
print(f"  LLM :         {llm_str}")
print(f"  Fallback :    {fb_str}")
print(f"  Recall :      {recall}")
print(f"  Capture :     {capture}")
print(f"  Context :     {ctx}")
print(f"  Observations : emergence={obs_e}, match={obs_m}, maxRecall={obs_r}")
PYEOF

echo ""

# ─── Pull models if needed ───

if [ "$NEW_LLM_MODE" = "local" ] && [ "$OLLAMA_RUNNING" = true ]; then
  OLLAMA_MODELS=$($OLLAMA_BIN list 2>/dev/null | tail -n +2 | awk '{print $1}' || true)
  if ! echo "$OLLAMA_MODELS" | grep -q "gemma3:4b"; then
    echo "  → Pull gemma3:4b..."
    $OLLAMA_BIN pull gemma3:4b || warn "Pull échoué"
  fi
  if ! echo "$OLLAMA_MODELS" | grep -q "nomic-embed-text-v2-moe"; then
    echo "  → Pull nomic-embed-text-v2-moe..."
    $OLLAMA_BIN pull nomic-embed-text-v2-moe || warn "Pull échoué"
  fi
fi

# ─── Smoke test ───

if [ "$OLLAMA_RUNNING" = true ] && [ "$NEW_LLM_MODE" = "local" ]; then
  RESPONSE=$(curl -s --max-time 10 http://localhost:11434/api/generate \
    -d '{"model":"gemma3:4b","prompt":"Reply OK","stream":false,"options":{"num_predict":5}}' 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','')[:20])" 2>/dev/null || echo "")
  if [ -n "$RESPONSE" ]; then
    log "LLM gemma3:4b OK"
  else
    warn "LLM ne répond pas — vérifiez Ollama"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${BOLD}🚀 Appliquer :${NC}  openclaw gateway restart"
echo -e "  ${DIM}📋 Voir :       bash configure.sh --show${NC}"
echo -e "  ${DIM}📋 Backup :     $CONFIG_FILE.backup${NC}"
echo ""
