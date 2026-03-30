#!/bin/bash
# Fix all imports in core/ to use relative paths

for file in *.ts providers/*.ts; do
  [ -f "$file" ] || continue
  
  # Update imports that reference modules now in core/
  sed -i '' \
    -e 's|from "\./\([^"]*\)\.js"|from "./\1.js"|g' \
    -e 's|from "\./providers/|from "./providers/|g' \
    "$file"
  
  echo "Fixed: $file"
done
