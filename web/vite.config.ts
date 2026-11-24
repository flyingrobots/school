import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        "home-a": resolve(import.meta.dirname, "mockups/home-a.html"),
        "home-b": resolve(import.meta.dirname, "mockups/home-b.html"),
        "home-c": resolve(import.meta.dirname, "mockups/home-c.html"),
        "home-d": resolve(import.meta.dirname, "mockups/home-d.html"),
        "home-e": resolve(import.meta.dirname, "mockups/home-e.html"),
        "home-f": resolve(import.meta.dirname, "mockups/home-f.html"),
        "home-g": resolve(import.meta.dirname, "mockups/home-g.html"),
        "home-h": resolve(import.meta.dirname, "mockups/home-h.html"),
        "home-i": resolve(import.meta.dirname, "mockups/home-i.html"),
      },
    },
  },
  resolve: {
    // The registry examples are written for shadcn's Next.js website; these stand in for its
    // modules (src/demo/README.md). Exact matches first, then the "@" prefix.
    alias: [
      {
        find: /^@\/components\/example$/,
        replacement: resolve(import.meta.dirname, "./src/demo/example.tsx"),
      },
      {
        find: /^next\/link$/,
        replacement: resolve(
          import.meta.dirname,
          "./src/demo/shims/next-link.tsx"
        ),
      },
      {
        find: /^next\/image$/,
        replacement: resolve(
          import.meta.dirname,
          "./src/demo/shims/next-image.tsx"
        ),
      },
      {
        find: /^@\/app\/\(create\)\/lib\/search-params$/,
        replacement: resolve(
          import.meta.dirname,
          "./src/demo/shims/search-params.ts"
        ),
      },
      {
        find: /^@\/components\/message-parts$/,
        replacement: resolve(
          import.meta.dirname,
          "./src/demo/shims/message-parts.ts"
        ),
      },
      { find: "@", replacement: resolve(import.meta.dirname, "./src") },
    ],
  },
})
