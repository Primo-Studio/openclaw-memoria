#!/bin/bash

# Liste des modules à préfixer avec ./core/
modules=(
  "db" "selective" "embeddings" "graph" "topics" "lifecycle"
  "hebbian" "expertise" "feedback" "patterns" "procedural"
  "context-tree" "budget" "md-regen" "identity-parser"
  "extraction" "format" "config" "observations" "fact-clusters"
  "sync" "revision" "scoring"
)

for file in recall.ts continuous.ts capture.ts procedural-hooks.ts orchestrator.ts; do
  echo "Updating $file..."
  
  for mod in "${modules[@]}"; do
    sed -i '' "s|from \"\\./${mod}\\.js\"|from \"./core/${mod}.js\"|g" "$file"
  done
  
  # Providers
  sed -i '' 's|from "\./providers/types\.js"|from "./core/providers/types.js"|g' "$file"
  
  echo "✓ $file"
done

echo "All adapters updated!"
