// vite config: react plugin only; ws proxying is not needed (client dials the server port directly)
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // honor a harness-assigned port (preview tools set PORT); vite picks its own otherwise
  server: process.env.PORT ? { port: Number(process.env.PORT) } : undefined,
  build: {
    rollupOptions: {
      output: {
        // split deps into their own cacheable chunks; keeps every chunk under the 500 kB warning limit
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return; // app code stays in the entry chunk
          if (id.includes("@clerk")) return "clerk"; // checked first: "clerk-react" also matches "react"
          if (id.includes("react") || id.includes("scheduler")) return "react";
          return "vendor";
        },
      },
    },
  },
});
