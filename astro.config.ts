import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Server-rendered output: every page and API route runs per request so it
// can read the shared creature's current state from SQLite, and `astro
// build` emits the Node server the Dockerfile runs.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    // Fly's proxy terminates TLS, so naming the deploy domain is what lets
    // Astro trust x-forwarded-proto and accept same-origin form POSTs (the
    // action buttons) and the SSE endpoint.
    allowedDomains: [{ hostname: "**.fly.dev", protocol: "https" }],
  },
});
