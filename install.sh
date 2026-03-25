#!/bin/bash
# Memoria — One-line installer for OpenClaw
# Usage: curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/main/install.sh | bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${CYAN}ℹ️  $1${NC}"; }

echo ""
echo "🧠 Memoria — Persistent Memory for OpenClaw"
echo "============================================="
echo ""

# ─── Step 1: Check prerequisites ───

echo "📋 Checking prerequisites..."
echo ""

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node.js ≥ 20 first."
NODE_V=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_V" -ge 20 ]; then
  log "Node.js v$(node -v | sed 's/v//') found"
else
  warn "Node.js $NODE_V detected. v20+ recommended."
fi

command -v npm >/dev/null 2>&1 || fail "npm not found."
log "npm $(npm -v) found"

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
  echo ""
  echo "  After installing Ollama, run:"
  echo "    ollama pull gemma3:4b"
  echo "    ollama pull nomic-embed-text-v2-moe"
  echo ""
else
  log "Ollama found: $OLLAMA_BIN"

  if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    log "Ollama server running"
  else
    warn "Ollama not responding on localhost:11434. Start it: ollama serve"
  fi

  # Pull models if missing
  MODELS=$($OLLAMA_BIN list 2>/dev/null | tail -n +2 | awk '{print $1}' || true)

  if echo "$MODELS" | grep -q "gemma3:4b"; then
    log "gemma3:4b already installed"
  else
    echo "📥 Pulling gemma3:4b (3.3 GB — LLM for fact extraction)..."
    $OLLAMA_BIN pull gemma3:4b || warn "Failed to pull gemma3:4b. Pull manually later."
  fi

  if echo "$MODELS" | grep -q "nomic-embed-text-v2-moe"; then
    log "nomic-embed-text-v2-moe already installed"
  else
    echo "📥 Pulling nomic-embed-text-v2-moe (957 MB — embeddings)..."
    $OLLAMA_BIN pull nomic-embed-text-v2-moe || warn "Failed to pull. Pull manually later."
  fi
fi

# ─── Step 2: Clone or update plugin ───

echo ""
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

# ─── Step 4: Auto-configure openclaw.json ───

echo ""
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

configure_openclaw() {
  # Use python3 (available on macOS/Linux) for safe JSON manipulation
  python3 << 'PYEOF'
import json, sys, os

config_path = os.path.expanduser("~/.openclaw/openclaw.json")
if not os.path.exists(config_path):
    print("  ⚠️  No openclaw.json found — skipping auto-config")
    sys.exit(0)

with open(config_path) as f:
    cfg = json.load(f)

changed = False

# Ensure plugins section exists
if "plugins" not in cfg:
    cfg["plugins"] = {}
if "entries" not in cfg["plugins"]:
    cfg["plugins"]["entries"] = {}
if "allow" not in cfg["plugins"]:
    cfg["plugins"]["allow"] = []

# Add memoria to entries if missing
if "memoria" not in cfg["plugins"]["entries"]:
    cfg["plugins"]["entries"]["memoria"] = {"enabled": True}
    changed = True
    print("  ✅ Added memoria to plugins.entries")
elif not cfg["plugins"]["entries"]["memoria"].get("enabled"):
    cfg["plugins"]["entries"]["memoria"]["enabled"] = True
    changed = True
    print("  ✅ Enabled memoria in plugins.entries")
else:
    print("  ℹ️  memoria already configured in entries")

# Add to allow list if missing
if "memoria" not in cfg["plugins"]["allow"]:
    cfg["plugins"]["allow"].append("memoria")
    changed = True
    print("  ✅ Added memoria to plugins.allow")
else:
    print("  ℹ️  memoria already in allow list")

if changed:
    # Backup original
    import shutil
    backup = config_path + ".backup"
    shutil.copy2(config_path, backup)
    print(f"  📋 Backup saved: {backup}")

    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("  ✅ openclaw.json updated")
else:
    print("  ℹ️  No changes needed")
PYEOF
}

echo "🔧 Configuring openclaw.json..."
configure_openclaw

# ─── Step 5: Detect existing data ───

echo ""
WORKSPACE="$HOME/.openclaw/workspace"
MEMORY_DIR="$WORKSPACE/memory"

if [ -f "$MEMORY_DIR/cortex.db" ] && [ ! -f "$MEMORY_DIR/memoria.db" ]; then
  SIZE=$(du -h "$MEMORY_DIR/cortex.db" | awk '{print $1}')
  FACTS=$(sqlite3 "$MEMORY_DIR/cortex.db" "SELECT count(*) FROM facts WHERE superseded=0" 2>/dev/null || echo "?")
  log "Found existing cortex.db ($SIZE, $FACTS active facts)"
  info "Memoria will auto-migrate your data on first startup — zero manual action needed."
elif [ -f "$MEMORY_DIR/memoria.db" ]; then
  SIZE=$(du -h "$MEMORY_DIR/memoria.db" | awk '{print $1}')
  FACTS=$(sqlite3 "$MEMORY_DIR/memoria.db" "SELECT count(*) FROM facts WHERE superseded=0" 2>/dev/null || echo "?")
  log "Found existing memoria.db ($SIZE, $FACTS active facts)"
elif [ -f "$MEMORY_DIR/facts.json" ]; then
  FACTS=$(python3 -c "import json; f=json.load(open('$MEMORY_DIR/facts.json')); print(len([x for x in f if not x.get('superseded')]))" 2>/dev/null || echo "?")
  log "Found existing facts.json ($FACTS facts)"
  info "Run 'npx tsx migrate.ts' in the plugin folder to import into Memoria."
else
  info "No existing memory data found. Memoria will start fresh."
fi

# ─── Step 6: Summary ───

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
log "Installation complete! 🧠"
echo ""

VERSION=$(node -e "try{console.log(require('$DEST/package.json').version)}catch{console.log('?')}" 2>/dev/null)
echo "  Version:    $VERSION"
echo "  Location:   $DEST"
echo "  Config:     $CONFIG_FILE"
echo "  LLM:        Ollama + gemma3:4b (local, free)"
echo "  Embeddings: Ollama + nomic-embed-text-v2-moe (local, free)"
echo ""

if [ -f "$CONFIG_FILE" ] && grep -q '"memoria"' "$CONFIG_FILE" 2>/dev/null; then
  echo "🚀 Next step:"
  echo ""
  echo "   openclaw doctor && openclaw gateway restart"
  echo ""
else
  echo "⚠️  Add memoria to your openclaw.json, then:"
  echo ""
  echo "   openclaw doctor && openclaw gateway restart"
  echo ""
fi

echo "📖 Docs:     $DEST/INSTALL.md"
echo "🔧 Advanced: Override defaults in plugins.entries.memoria.config"
echo "             See INSTALL.md for all options (LLM, limits, providers)."
echo ""
