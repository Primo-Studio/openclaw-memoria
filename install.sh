#!/bin/bash
# Memoria — Interactive installer for OpenClaw
# Usage: curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
# Silent: curl ... | bash -s -- --preset local-only
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

# ─── Parse CLI args ───

PRESET=""
SILENT=false
UPDATE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --preset=*) PRESET="${arg#*=}" ;;
    --preset) shift; PRESET="$1" ;;
    --yes|-y) SILENT=true ;;
    --update|-u) UPDATE_ONLY=true ;;
    local-only|cloud-first|paranoid) PRESET="$arg" ;;
  esac
done

echo ""
echo -e "${BOLD}🧠 Memoria — Mémoire persistante pour OpenClaw${NC}"
echo "================================================="
echo ""

# ─── Update mode ───

DEST="$HOME/.openclaw/extensions/memoria"

if [ "$UPDATE_ONLY" = true ]; then
  if [ ! -d "$DEST/.git" ]; then
    fail "Memoria non installé. Lancez d'abord l'installation complète."
  fi

  OLD_V=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)
  echo -e "  Version actuelle : ${BOLD}v$OLD_V${NC}"
  echo ""

  cd "$DEST"
  git fetch origin main --quiet 2>/dev/null
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null)
  REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null)

  if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
    log "Déjà à jour (v$OLD_V)"
    exit 0
  fi

  echo "  → Mise à jour disponible..."
  git pull --ff-only origin main 2>/dev/null || fail "Git pull échoué"
  npm install --production 2>&1 | tail -1

  NEW_V=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)
  log "Mis à jour : v$OLD_V → v$NEW_V"
  echo ""
  echo -e "  ${BOLD}🚀${NC} Appliquer : openclaw gateway restart"
  echo ""

  # Afficher le changelog si dispo
  if [ -f "$DEST/CHANGELOG.md" ]; then
    echo -e "  ${DIM}📋 Changelog : cat $DEST/CHANGELOG.md${NC}"
  fi
  echo ""
  exit 0
fi

# Detect if already installed → propose update
if [ -d "$DEST/.git" ]; then
  OLD_V=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)
  cd "$DEST"
  git fetch origin main --quiet 2>/dev/null
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null)
  REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null)

  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    echo -e "  ${YELLOW}⚡ Memoria v$OLD_V est installé — une mise à jour est disponible !${NC}"
    echo ""
    echo -e "  ${BOLD}1)${NC} 🔄 Mettre à jour ${DIM}(garder la config actuelle)${NC}"
    echo -e "  ${BOLD}2)${NC} 🔧 Réinstaller ${DIM}(wizard complet)${NC}"
    echo -e "  ${BOLD}3)${NC} ❌ Annuler"
    echo ""
    read -r -p "  Tapez 1, 2 ou 3 [1] : " UPD_CHOICE </dev/tty 2>/dev/null || UPD_CHOICE="1"
    UPD_CHOICE=${UPD_CHOICE:-1}

    case "$UPD_CHOICE" in
      2) ;; # continue with full wizard
      3) echo "  Annulé."; exit 0 ;;
      *)
        # Quick update
        git pull --ff-only origin main 2>/dev/null || fail "Git pull échoué"
        npm install --production 2>&1 | tail -1
        NEW_V=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)
        log "Mis à jour : v$OLD_V → v$NEW_V"
        echo ""
        echo -e "  ${BOLD}🚀${NC} Appliquer : openclaw gateway restart"
        echo ""
        exit 0
        ;;
    esac
  else
    echo -e "  ${GREEN}✅ Memoria v$OLD_V est déjà installé et à jour${NC}"
    echo ""
    echo -e "  ${BOLD}1)${NC} 🔧 Reconfigurer ${DIM}(wizard complet)${NC}"
    echo -e "  ${BOLD}2)${NC} ❌ Quitter"
    echo ""
    read -r -p "  Tapez 1 ou 2 [2] : " REINSTALL_CHOICE </dev/tty 2>/dev/null || REINSTALL_CHOICE="2"
    REINSTALL_CHOICE=${REINSTALL_CHOICE:-2}

    case "$REINSTALL_CHOICE" in
      1) ;; # continue with full wizard
      *) echo "  OK 👋"; exit 0 ;;
    esac
  fi
  cd - >/dev/null 2>&1
fi

# ─── Step 1: Detect environment ───

h1 "📋 Détection de l'environnement..."
echo ""

# Node.js
command -v node >/dev/null 2>&1 || fail "Node.js non trouvé. Installez Node.js ≥ 20 d'abord."
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_V" -ge 20 ]; then
  log "Node.js $(node -v)"
else
  warn "Node.js v$NODE_V détecté. v20+ recommandé."
fi
command -v npm >/dev/null 2>&1 || fail "npm non trouvé."

# Ollama
OLLAMA_BIN=""
HAS_OLLAMA=false
OLLAMA_RUNNING=false
OLLAMA_MODELS=""
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="ollama"
elif [ -f "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
fi
if [ -n "$OLLAMA_BIN" ]; then
  HAS_OLLAMA=true
  log "Ollama trouvé"
  if curl -s --connect-timeout 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    OLLAMA_RUNNING=true
    OLLAMA_MODELS=$($OLLAMA_BIN list 2>/dev/null | tail -n +2 | awk '{print $1}' || true)
    log "Ollama en ligne (localhost:11434)"
  else
    warn "Ollama installé mais pas démarré"
  fi
else
  warn "Ollama non trouvé — installation locale impossible sans Ollama"
fi

# LM Studio
HAS_LMSTUDIO=false
if curl -s --connect-timeout 2 http://localhost:1234/v1/models >/dev/null 2>&1; then
  HAS_LMSTUDIO=true
  log "LM Studio détecté (localhost:1234)"
else
  echo -e "${DIM}   LM Studio non détecté${NC}"
fi

# OpenAI key
HAS_OPENAI=false
if [ -n "$OPENAI_API_KEY" ]; then
  HAS_OPENAI=true
  log "Clé OpenAI trouvée (env OPENAI_API_KEY)"
else
  echo -e "${DIM}   Clé OpenAI non trouvée (optionnel)${NC}"
fi

# Existing data
WORKSPACE="$HOME/.openclaw/workspace"
MEMORY_DIR="$WORKSPACE/memory"
HAS_CORTEX=false
HAS_MEMORIA=false
EXISTING_FACTS="0"
if [ -f "$MEMORY_DIR/cortex.db" ]; then
  HAS_CORTEX=true
  EXISTING_FACTS=$(sqlite3 "$MEMORY_DIR/cortex.db" "SELECT count(*) FROM facts WHERE superseded=0" 2>/dev/null || echo "?")
  log "Données existantes détectées : cortex.db ($EXISTING_FACTS faits)"
elif [ -f "$MEMORY_DIR/memoria.db" ]; then
  HAS_MEMORIA=true
  EXISTING_FACTS=$(sqlite3 "$MEMORY_DIR/memoria.db" "SELECT count(*) FROM facts WHERE superseded=0" 2>/dev/null || echo "?")
  log "Base Memoria existante : $EXISTING_FACTS faits"
fi

# ─── Step 2: Choose mode (interactive or preset) ───

LLM_MODE=""      # local | cloud | advanced
FALLBACK_MODE="" # recommended | strict | none

if [ -n "$PRESET" ]; then
  case "$PRESET" in
    local-only)
      LLM_MODE="local"
      FALLBACK_MODE="recommended"
      info "Preset: local-only (Ollama + fallback LM Studio)"
      ;;
    cloud-first)
      LLM_MODE="cloud"
      FALLBACK_MODE="recommended"
      info "Preset: cloud-first (OpenAI + fallback Ollama)"
      ;;
    paranoid)
      LLM_MODE="local"
      FALLBACK_MODE="strict"
      info "Preset: paranoid (Ollama uniquement, aucun fallback)"
      ;;
    *)
      warn "Preset inconnu: $PRESET — lancement du wizard"
      PRESET=""
      ;;
  esac
fi

if [ -z "$PRESET" ]; then
  # ─── Question 1: LLM Provider ───
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  h1 "❓ Comment voulez-vous que Memoria fonctionne ?"
  echo ""
  echo -e "  ${BOLD}1)${NC} 🏠 ${GREEN}100% Local${NC} — Ollama + gemma3:4b ${DIM}(recommandé)${NC}"
  echo -e "     Gratuit, privé, fonctionne offline"
  echo -e "     Modèles à télécharger : ~4.3 GB"
  echo ""

  if [ "$HAS_OPENAI" = true ]; then
    echo -e "  ${BOLD}2)${NC} ☁️  Cloud + fallback local — OpenAI + Ollama"
    echo -e "     Haute précision, coût ~\$0.50/mois"
  else
    echo -e "  ${BOLD}2)${NC} ☁️  Cloud + fallback local — OpenAI, OpenRouter ou Anthropic"
    echo -e "     ${DIM}(nécessite une clé API)${NC}"
  fi
  echo ""
  echo -e "  ${BOLD}3)${NC} 🔧 Configuration manuelle (éditer openclaw.json après)"
  echo ""
  echo -e "  ${DIM}💡 Vous pourrez changer le LLM et les embeddings à tout moment${NC}"
  echo -e "  ${DIM}   via : bash ~/.openclaw/extensions/memoria/configure.sh${NC}"
  echo ""

  read -r -p "  Tapez 1, 2 ou 3 [1] : " LLM_CHOICE </dev/tty 2>/dev/null || LLM_CHOICE="1"
  LLM_CHOICE=${LLM_CHOICE:-1}

  case "$LLM_CHOICE" in
    2)
      echo ""
      h1 "☁️  Quel provider cloud ?"
      echo ""
      echo -e "  ${BOLD}a)${NC} OpenAI — GPT-5.4-nano ${DIM}(rapide, ~\$0.50/mois)${NC}"
      echo -e "  ${BOLD}b)${NC} OpenRouter — accès multi-modèles ${DIM}(flexible)${NC}"
      echo -e "  ${BOLD}c)${NC} Anthropic — Claude ${DIM}(haute qualité)${NC}"
      echo ""
      read -r -p "  Tapez a, b ou c [a] : " CLOUD_CHOICE </dev/tty 2>/dev/null || CLOUD_CHOICE="a"
      CLOUD_CHOICE=${CLOUD_CHOICE:-a}

      case "$CLOUD_CHOICE" in
        b|B)
          CLOUD_PROVIDER="openrouter"; CLOUD_MODEL="auto"
          if [ -z "$OPENROUTER_API_KEY" ]; then
            read -r -p "  Clé OpenRouter : " CLOUD_KEY </dev/tty 2>/dev/null || CLOUD_KEY=""
            [ -n "$CLOUD_KEY" ] && export OPENROUTER_API_KEY="$CLOUD_KEY"
          fi
          ;;
        c|C)
          CLOUD_PROVIDER="anthropic"; CLOUD_MODEL="claude-sonnet-4-5"
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            read -r -p "  Clé Anthropic : " CLOUD_KEY </dev/tty 2>/dev/null || CLOUD_KEY=""
            [ -n "$CLOUD_KEY" ] && export ANTHROPIC_API_KEY="$CLOUD_KEY"
          fi
          ;;
        *)
          CLOUD_PROVIDER="openai"; CLOUD_MODEL="gpt-5.4-nano"
          if [ "$HAS_OPENAI" != true ]; then
            read -r -p "  Clé OpenAI : " OPENAI_INPUT </dev/tty 2>/dev/null || OPENAI_INPUT=""
            if [ -n "$OPENAI_INPUT" ]; then
              export OPENAI_API_KEY="$OPENAI_INPUT"
              HAS_OPENAI=true
            fi
          fi
          ;;
      esac

      if [ -n "$CLOUD_PROVIDER" ]; then
        LLM_MODE="cloud"
      else
        warn "Pas de clé → mode local par défaut"
        LLM_MODE="local"
      fi
      ;;
    3)
      LLM_MODE="advanced"
      ;;
    *)
      LLM_MODE="local"
      ;;
  esac

  # ─── Question 2: Fallback strategy ───
  if [ "$LLM_MODE" != "advanced" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    h1 "❓ Résilience : que faire si le LLM principal plante ?"
    echo ""
    echo -e "  ${BOLD}1)${NC} 🛡️  ${GREEN}Fallback automatique${NC} ${DIM}(recommandé)${NC}"

    if [ "$LLM_MODE" = "local" ]; then
      echo "     Si Ollama plante → essaie LM Studio automatiquement"
    else
      echo "     Si OpenAI plante → essaie Ollama automatiquement"
    fi
    echo "     La mémoire ne s'arrête jamais"
    echo ""
    echo -e "  ${BOLD}2)${NC} 🔒 Mode strict (un seul provider)"
    echo "     Plus simple, mais si le provider crash → capture en pause"
    echo -e "     ${DIM}⚠️  Vous serez averti dans les logs si un crash survient${NC}"
    echo ""

    read -r -p "  Tapez 1 ou 2 [1] : " FB_CHOICE </dev/tty 2>/dev/null || FB_CHOICE="1"
    FB_CHOICE=${FB_CHOICE:-1}

    case "$FB_CHOICE" in
      2) FALLBACK_MODE="strict" ;;
      *) FALLBACK_MODE="recommended" ;;
    esac
  fi
fi

# ─── Step 3: Show summary before install ───

# ─── Step 2b: Embeddings note ───
echo ""
echo -e "  ${DIM}📊 Embeddings : nomic-embed-text-v2-moe (768d) via Ollama${NC}"
echo -e "  ${DIM}   Modifiable après via : bash ~/.openclaw/extensions/memoria/configure.sh${NC}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
h1 "📋 Configuration choisie :"
echo ""

case "$LLM_MODE" in
  local)
    echo -e "  Mode :       ${GREEN}🏠 100% Local (0€)${NC}"
    echo "  LLM :        Ollama + gemma3:4b"
    echo "  Embeddings : Ollama + nomic-embed-text-v2-moe"
    if [ "$FALLBACK_MODE" = "recommended" ]; then
      echo -e "  Fallback :   ${GREEN}Ollama → LM Studio${NC}"
    else
      echo "  Fallback :   aucun (strict)"
    fi
    ;;
  cloud)
    echo -e "  Mode :       ☁️  Cloud + Local"
    echo "  LLM :        ${CLOUD_PROVIDER:-openai} / ${CLOUD_MODEL:-gpt-5.4-nano}"
    echo "  Embeddings : Ollama + nomic-embed-text-v2-moe (local)"
    if [ "$FALLBACK_MODE" = "recommended" ]; then
      echo -e "  Fallback :   ${GREEN}${CLOUD_PROVIDER:-openai} → Ollama${NC}"
    else
      echo "  Fallback :   aucun (strict)"
    fi
    ;;
  advanced)
    echo -e "  Mode :       🔧 Manuel"
    echo "  → Éditez openclaw.json après l'installation"
    ;;
esac

if [ "$HAS_CORTEX" = true ]; then
  echo -e "  Migration :  ${GREEN}$EXISTING_FACTS faits (cortex.db → memoria.db auto)${NC}"
elif [ "$HAS_MEMORIA" = true ]; then
  echo -e "  Base :       $EXISTING_FACTS faits existants"
fi

echo ""

if [ "$SILENT" != true ] && [ "$LLM_MODE" != "advanced" ]; then
  echo -e "  ${DIM}💡 Appuyez sur Entrée pour valider. Tout est modifiable après l'installation${NC}"
  echo -e "  ${DIM}   via : bash ~/.openclaw/extensions/memoria/configure.sh${NC}"
  echo ""
  read -r -p "  ✅ On installe ? [O/n] : " CONFIRM </dev/tty 2>/dev/null || CONFIRM="o"
  CONFIRM=${CONFIRM:-o}
  case "$CONFIRM" in
    [nN]*) echo "  Annulé. Relancez quand vous êtes prêt 👋"; exit 0 ;;
  esac
fi

# ─── Step 4: Pull Ollama models ───

if [ "$LLM_MODE" != "advanced" ] && [ "$HAS_OLLAMA" = true ] && [ "$OLLAMA_RUNNING" = true ]; then
  echo ""
  h1 "📥 Téléchargement des modèles..."
  echo ""

  if echo "$OLLAMA_MODELS" | grep -q "gemma3:4b"; then
    log "gemma3:4b déjà installé"
  else
    echo "  → gemma3:4b (3.3 GB — extraction de faits)..."
    $OLLAMA_BIN pull gemma3:4b || warn "Échec pull gemma3:4b — à faire manuellement après"
  fi

  if echo "$OLLAMA_MODELS" | grep -q "nomic-embed-text-v2-moe"; then
    log "nomic-embed-text-v2-moe déjà installé"
  else
    echo "  → nomic-embed-text-v2-moe (957 MB — recherche sémantique)..."
    $OLLAMA_BIN pull nomic-embed-text-v2-moe || warn "Échec pull — à faire manuellement après"
  fi
elif [ "$HAS_OLLAMA" = false ] && [ "$LLM_MODE" = "local" ]; then
  echo ""
  warn "Ollama non installé — installez-le depuis https://ollama.ai puis :"
  echo "    ollama pull gemma3:4b"
  echo "    ollama pull nomic-embed-text-v2-moe"
fi

# ─── Step 5: Clone/update plugin ───

echo ""
h1 "📦 Installation du plugin..."
echo ""

if [ -d "$DEST/.git" ]; then
  echo "  Mise à jour..."
  cd "$DEST" && git pull --ff-only origin main 2>/dev/null || warn "Git pull échoué. Version existante conservée."
else
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  git clone https://github.com/Primo-Studio/openclaw-memoria.git "$DEST"
fi

cd "$DEST"
npm install --production 2>&1 | tail -1
log "Plugin installé"

# ─── Step 6: Generate and apply config ───

echo ""
h1 "🔧 Configuration d'openclaw.json..."
echo ""

CONFIG_FILE="$HOME/.openclaw/openclaw.json"

python3 << PYEOF
import json, sys, os, shutil

config_path = os.path.expanduser("~/.openclaw/openclaw.json")
if not os.path.exists(config_path):
    print("  ⚠️  Pas de openclaw.json — config à ajouter manuellement")
    sys.exit(0)

with open(config_path) as f:
    cfg = json.load(f)

# Build plugin config based on choices
llm_mode = "$LLM_MODE"
fallback_mode = "$FALLBACK_MODE"
has_openai = "$HAS_OPENAI" == "true"
openai_key = os.environ.get("OPENAI_API_KEY", "")

plugin_cfg = {
    "autoRecall": True,
    "autoCapture": True,
    "syncMd": True,
    "recallLimit": 12,
    "captureMaxFacts": 8,
}

if llm_mode == "local":
    plugin_cfg["llm"] = {"provider": "ollama", "model": "gemma3:4b"}
    plugin_cfg["embed"] = {"provider": "ollama", "model": "nomic-embed-text-v2-moe", "dimensions": 768}
    if fallback_mode == "recommended":
        plugin_cfg["fallback"] = [
            {"provider": "ollama", "model": "gemma3:4b"},
            {"provider": "lmstudio", "model": "auto"}
        ]
    else:
        plugin_cfg["fallback"] = [
            {"provider": "ollama", "model": "gemma3:4b"}
        ]

elif llm_mode == "cloud":
    cloud_prov = "$CLOUD_PROVIDER" or "openai"
    cloud_mod = "$CLOUD_MODEL" or "gpt-5.4-nano"
    plugin_cfg["llm"] = {"provider": cloud_prov, "model": cloud_mod}
    plugin_cfg["embed"] = {"provider": "ollama", "model": "nomic-embed-text-v2-moe", "dimensions": 768}
    if fallback_mode == "recommended":
        plugin_cfg["fallback"] = [
            {"provider": cloud_prov, "model": cloud_mod},
            {"provider": "ollama", "model": "gemma3:4b"}
        ]
    else:
        plugin_cfg["fallback"] = [
            {"provider": cloud_prov, "model": cloud_mod}
        ]

# else advanced: minimal config, user edits later

changed = False

if "plugins" not in cfg:
    cfg["plugins"] = {}
if "entries" not in cfg["plugins"]:
    cfg["plugins"]["entries"] = {}
if "allow" not in cfg["plugins"]:
    cfg["plugins"]["allow"] = []

if llm_mode == "advanced":
    # Minimal
    if "memoria" not in cfg["plugins"]["entries"]:
        cfg["plugins"]["entries"]["memoria"] = {"enabled": True}
        changed = True
elif "memoria" not in cfg["plugins"]["entries"]:
    cfg["plugins"]["entries"]["memoria"] = {"enabled": True, "config": plugin_cfg}
    changed = True
else:
    existing = cfg["plugins"]["entries"]["memoria"]
    if not existing.get("enabled"):
        existing["enabled"] = True
        changed = True
    if "config" not in existing or not existing["config"].get("fallback"):
        existing["config"] = {**existing.get("config", {}), **plugin_cfg}
        changed = True

if "memoria" not in cfg["plugins"]["allow"]:
    cfg["plugins"]["allow"].append("memoria")
    changed = True

# Disable memory-convex if present (conflicts with Memoria)
mc = cfg.get("plugins", {}).get("entries", {}).get("memory-convex", None)
if mc is not None:
    del cfg["plugins"]["entries"]["memory-convex"]
    changed = True
    print("  🧹 memory-convex désactivé (remplacé par Memoria)")

if changed:
    backup = config_path + ".backup"
    shutil.copy2(config_path, backup)
    print(f"  📋 Backup : {backup}")
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("  ✅ openclaw.json configuré")
else:
    print("  ℹ️  Déjà configuré")
PYEOF

# ─── Step 7: Validate (quick smoke test) ───

echo ""
h1 "🧪 Validation rapide..."
echo ""

if [ "$OLLAMA_RUNNING" = true ] && [ "$LLM_MODE" = "local" ]; then
  RESPONSE=$(curl -s --max-time 10 http://localhost:11434/api/generate \
    -d '{"model":"gemma3:4b","prompt":"Reply OK","stream":false,"options":{"num_predict":5}}' 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','')[:20])" 2>/dev/null || echo "")
  if [ -n "$RESPONSE" ]; then
    log "LLM gemma3:4b répond correctement"
  else
    warn "gemma3:4b ne répond pas — vérifiez Ollama"
  fi
fi

# ─── Step 8: Final summary ───

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
log "Installation terminée ! 🧠"
echo ""

VERSION=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)

echo -e "  ${BOLD}Version${NC}      $VERSION"
echo -e "  ${BOLD}Emplacement${NC}  $DEST"

case "$LLM_MODE" in
  local)
    echo -e "  ${BOLD}LLM${NC}          Ollama + gemma3:4b ${DIM}(local, 0€)${NC}"
    echo -e "  ${BOLD}Embeddings${NC}   Ollama + nomic-embed-text-v2-moe ${DIM}(local, 0€)${NC}"
    if [ "$FALLBACK_MODE" = "recommended" ]; then
      echo -e "  ${BOLD}Fallback${NC}     Ollama → LM Studio"
    else
      echo -e "  ${BOLD}Fallback${NC}     Aucun (strict)"
    fi
    ;;
  cloud)
    echo -e "  ${BOLD}LLM${NC}          ${CLOUD_PROVIDER:-openai} / ${CLOUD_MODEL:-gpt-5.4-nano}"
    echo -e "  ${BOLD}Embeddings${NC}   Ollama + nomic-embed-text-v2-moe ${DIM}(local, 0€)${NC}"
    if [ "$FALLBACK_MODE" = "recommended" ]; then
      echo -e "  ${BOLD}Fallback${NC}     ${CLOUD_PROVIDER:-openai} → Ollama"
    else
      echo -e "  ${BOLD}Fallback${NC}     Aucun (strict)"
    fi
    ;;
  advanced)
    echo -e "  ${BOLD}Config${NC}       Manuelle — éditez ~/.openclaw/openclaw.json"
    ;;
esac

if [ "$HAS_CORTEX" = true ]; then
  echo -e "  ${BOLD}Migration${NC}    $EXISTING_FACTS faits → auto au premier démarrage"
fi

echo ""
echo -e "  ${BOLD}🚀 Prochaine étape :${NC}"
echo ""
echo "     openclaw doctor && openclaw gateway restart"
echo ""
echo -e "  ${DIM}📖 Docs      $DEST/INSTALL.md${NC}"
echo -e "  ${DIM}🔧 Modifier  bash ~/.openclaw/extensions/memoria/configure.sh${NC}"
echo -e "  ${DIM}🆘 Support   https://github.com/Primo-Studio/openclaw-memoria/issues${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${BOLD}🙏 Merci d'avoir installé Memoria !${NC}"
echo ""
echo -e "  N'hésitez pas à nous faire un retour :"
echo -e "  🐦 X/Twitter : ${CYAN}@Nitix_${NC}"
echo -e "  ⭐ GitHub    : ${CYAN}https://github.com/Primo-Studio/openclaw-memoria${NC}"
echo ""
echo -e "  ${DIM}Fait avec ❤️  par Primo Studio — Guyane française${NC}"
echo ""
