#!/bin/bash
# Memoria — One-line installer for OpenClaw
# Usage: curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

echo "🧠 Memoria — Installation"
echo "========================="
echo ""

# ─── Step 1: Check prerequisites ───

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node.js ≥ 20 first."
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_V" -ge 20 ] || warn "Node.js $NODE_V detected. v20+ recommended."

command -v npm >/dev/null 2>&1 || fail "npm not found. Install npm first."

# Check Ollama
OLLAMA_BIN=""
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="ollama"
elif [ -f "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
fi

if [ -z "$OLLAMA_BIN" ]; then
  warn "Ollama not found. Install from https://ollama.ai"
  warn "Memoria needs Ollama for local LLM + embeddings (free, no API key)."
  echo "  After installing Ollama, run:"
  echo "    ollama pull gemma3:4b"
  echo "    ollama pull nomic-embed-text-v2-moe"
  echo ""
else
  log "Ollama found: $OLLAMA_BIN"

  # Check if Ollama is running
  if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    log "Ollama server running"
  else
    warn "Ollama not responding on localhost:11434. Start it with: ollama serve"
  fi

  # Pull models if missing
  MODELS=$($OLLAMA_BIN list 2>/dev/null | tail -n +2 | awk '{print $1}' || true)

  if echo "$MODELS" | grep -q "gemma3:4b"; then
    log "gemma3:4b already installed"
  else
    echo "📥 Pulling gemma3:4b (3.3 GB — LLM for fact extraction)..."
    $OLLAMA_BIN pull gemma3:4b || warn "Failed to pull gemma3:4b. Pull manually: ollama pull gemma3:4b"
  fi

  if echo "$MODELS" | grep -q "nomic-embed-text-v2-moe"; then
    log "nomic-embed-text-v2-moe already installed"
  else
    echo "📥 Pulling nomic-embed-text-v2-moe (957 MB — embeddings)..."
    $OLLAMA_BIN pull nomic-embed-text-v2-moe || warn "Failed to pull embeddings model. Pull manually: ollama pull nomic-embed-text-v2-moe"
  fi
fi

# ─── Step 2: Clone or update plugin ───

DEST="$HOME/.openclaw/extensions/memoria"

if [ -d "$DEST/.git" ]; then
  echo "📦 Updating existing installation..."
  cd "$DEST" && git pull --ff-only origin main 2>/dev/null || warn "Git pull failed. Continuing with existing version."
else
  echo "📦 Cloning Memoria..."
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  git clone https://github.com/Primo-Studio/openclaw-memoria.git "$DEST"
fi

# ─── Step 3: Install dependencies ───

cd "$DEST"
echo "📦 Installing npm dependencies..."
npm install --production 2>&1 | tail -3
log "Dependencies installed"

# ─── Step 4: Suggest config ───

CONFIG_FILE="$HOME/.openclaw/openclaw.json"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Add this to your openclaw.json:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
cat << 'CONFIG'
In plugins.entries, add:

  "memoria": {
    "enabled": true
  }

In plugins.allow, add "memoria":

  "allow": ["memoria", ...]
CONFIG

echo ""
echo "That's it! All settings have smart defaults (Ollama + gemma3:4b + nomic-embed)."
echo "Override only what you need. See INSTALL.md for advanced config."
echo ""

# ─── Step 5: Verify ───

if [ -f "$CONFIG_FILE" ]; then
  if grep -q '"memoria"' "$CONFIG_FILE" 2>/dev/null; then
    log "Memoria already in openclaw.json"
    echo ""
    echo "🚀 Run: openclaw doctor && openclaw gateway restart"
  else
    warn "Memoria not yet in openclaw.json. Add the config above, then:"
    echo "   openclaw doctor && openclaw gateway restart"
  fi
else
  warn "openclaw.json not found at $CONFIG_FILE"
  echo "   Create your config, then: openclaw gateway restart"
fi

echo ""
log "Installation complete! 🧠"
echo ""
