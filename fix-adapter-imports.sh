#!/bin/bash

# Fix capture.ts
sed -i '' '8a\
import type { MemoriaConfig } from "./core/config.js";
' capture.ts

# Fix continuous.ts
sed -i '' '13a\
import type { MemoriaConfig } from "./core/config.js";
' continuous.ts

# Fix procedural-hooks.ts
sed -i '' '8a\
import type { MemoriaConfig } from "./core/config.js";
' procedural-hooks.ts

# Fix recall.ts
sed -i '' -e 's|from "\./observations\.js"|from "./core/observations.js"|g' \
          -e 's|from "\./revision\.js"|from "./core/revision.js"|g' \
          -e 's|from "\./scoring\.js"|from "./core/scoring.js"|g' recall.ts
sed -i '' '8a\
import type { MemoriaConfig } from "./core/config.js";
' recall.ts

# Fix orchestrator.ts
sed -i '' -e 's|from "\./observations\.js"|from "./core/observations.js"|g' \
          -e 's|from "\./fact-clusters\.js"|from "./core/fact-clusters.js"|g' \
          -e 's|from "\./sync\.js"|from "./core/sync.js"|g' orchestrator.ts

echo "Fixed adapter imports"
