#!/bin/bash

# Core modules to move
sed -i '' \
  -e 's|from "\./db\.js"|from "./core/db.js"|g' \
  -e 's|from "\./selective\.js"|from "./core/selective.js"|g' \
  -e 's|from "\./embeddings\.js"|from "./core/embeddings.js"|g' \
  -e 's|from "\./graph\.js"|from "./core/graph.js"|g' \
  -e 's|from "\./context-tree\.js"|from "./core/context-tree.js"|g' \
  -e 's|from "\./budget\.js"|from "./core/budget.js"|g' \
  -e 's|from "\./sync\.js"|from "./core/sync.js"|g' \
  -e 's|from "\./md-regen\.js"|from "./core/md-regen.js"|g' \
  -e 's|from "\./fallback\.js"|from "./core/fallback.js"|g' \
  -e 's|from "\./topics\.js"|from "./core/topics.js"|g' \
  -e 's|from "\./providers/|from "./core/providers/|g' \
  -e 's|from "\./embed-fallback\.js"|from "./core/embed-fallback.js"|g' \
  -e 's|from "\./observations\.js"|from "./core/observations.js"|g' \
  -e 's|from "\./fact-clusters\.js"|from "./core/fact-clusters.js"|g' \
  -e 's|from "\./feedback\.js"|from "./core/feedback.js"|g' \
  -e 's|from "\./identity-parser\.js"|from "./core/identity-parser.js"|g' \
  -e 's|from "\./lifecycle\.js"|from "./core/lifecycle.js"|g' \
  -e 's|from "\./revision\.js"|from "./core/revision.js"|g' \
  -e 's|from "\./hebbian\.js"|from "./core/hebbian.js"|g' \
  -e 's|from "\./expertise\.js"|from "./core/expertise.js"|g' \
  -e 's|from "\./procedural\.js"|from "./core/procedural.js"|g' \
  -e 's|from "\./patterns\.js"|from "./core/patterns.js"|g' \
  -e 's|from "\./config\.js"|from "./core/config.js"|g' \
  index.ts

echo "✓ index.ts imports fixed"
