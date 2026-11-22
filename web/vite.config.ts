import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The registry examples are written for shadcn's Next.js website; these stand in for its
    // modules (src/demo/README.md). Exact matches first, then the "@" prefix.
    alias: [
      { find: /^@\/components\/example$/, replacement: resolve(import.meta.dirname, "./src/demo/example.tsx") },
      { find: /^next\/link$/, replacement: resolve(import.meta.dirname, "./src/demo/shims/next-link.tsx") },
      { find: /^next\/image$/, replacement: resolve(import.meta.dirname, "./src/demo/shims/next-image.tsx") },
      { find: /^@\/app\/\(create\)\/lib\/search-params$/, replacement: resolve(import.meta.dirname, "./src/demo/shims/search-params.ts") },
      { find: /^@\/components\/message-parts$/, replacement: resolve(import.meta.dirname, "./src/demo/shims/message-parts.ts") },
      { find: "@", replacement: resolve(import.meta.dirname, "./src") },
    ],
  },
})
