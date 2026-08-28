import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base relative : l'UI est servie par le daemon sous /ui/, pas à la racine.
export default defineConfig({
  base: './',
  // Cast : la racine du monorepo hoiste vite 8 (vitest) alors que ce package
  // utilise vite 7 — les types Plugin divergent, le runtime est compatible.
  plugins: [react() as unknown as PluginOption, tailwindcss() as unknown as PluginOption],
  resolve: {
    // Alias shadcn : `@/components/ui/button` → src/components/ui/button (cf. tsconfig paths).
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
