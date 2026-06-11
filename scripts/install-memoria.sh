#!/bin/sh
# Installe Memoria sur un Mac neuf (ex. l'iMac de Luna) — pensé pour un non-dev.
# Une seule commande :
#   curl -fsSL https://raw.githubusercontent.com/Primo-Studio/openclaw-memoria/memoria-v1/scripts/install-memoria.sh | sh
# ou, dépôt déjà cloné :  sh scripts/install-memoria.sh
#
# Fait : vérifie Node, clone/maj le dépôt, installe, construit, démarre le daemon,
# affiche l'URL de l'interface web. Idempotent (relançable sans risque).
set -eu

REPO_URL="https://github.com/Primo-Studio/openclaw-memoria.git"
BRANCH="memoria-v1"
DEST="${MEMORIA_HOME_REPO:-$HOME/openclaw-memoria}"
BIN_DIR="$HOME/.local/bin"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$1"; }
err() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# 1) Node >= 20 (22.19+ recommandé pour cohabiter avec OpenClaw)
command -v node >/dev/null 2>&1 || err "Node.js manquant. Installe Node 22 LTS depuis https://nodejs.org puis relance."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || err "Node $NODE_MAJOR détecté ; Memoria requiert Node 20+ (22 conseillé)."
say "Node $(node -v) OK"

# 2) cloner ou mettre à jour
if [ -d "$DEST/.git" ]; then
  say "Mise à jour du dépôt dans $DEST"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  say "Clonage de Memoria dans $DEST"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$DEST"
fi

# 3) installer + construire
say "Installation des dépendances (peut prendre 1-2 min)…"
npm --prefix "$DEST" install --no-audit --no-fund
say "Construction…"
npm --prefix "$DEST" run build

# 4) raccourci CLI 'memoria' dans ~/.local/bin
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/memoria" <<EOF
#!/bin/sh
exec "$(command -v node)" "$DEST/packages/cli/dist/bin.js" "\$@"
EOF
chmod +x "$BIN_DIR/memoria"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) say "Ajoute ceci à ton ~/.zshrc :  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# 5) init + démarrage du daemon
say "Initialisation + démarrage du service…"
"$BIN_DIR/memoria" init >/dev/null 2>&1 || true
"$BIN_DIR/memoria" start

# 6) URL de l'interface (token d'accès dans daemon.json)
DATA="${MEMORIA_HOME:-$HOME/.memoria/data}"
if [ -f "$DATA/daemon.json" ]; then
  PORT="$(node -p "require('$DATA/daemon.json').port")"
  TOKEN="$(node -p "require('$DATA/daemon.json').admin_token")"
  printf '\n\033[1;32m✓ Memoria est installé et lancé.\033[0m\n'
  printf '   Interface : http://127.0.0.1:%s/ui/#token=%s\n' "$PORT" "$TOKEN"
  printf '   (ou tape simplement « memoria » pour rouvrir l’interface plus tard)\n'
  printf '\n   Pour relier cette machine à Koda (le hub) : Réglages → Synchro → « Relier au hub ».\n\n'
else
  printf '\n\033[1;32m✓ Installé.\033[0m Lance « memoria start » puis ouvre l’interface affichée.\n\n'
fi
