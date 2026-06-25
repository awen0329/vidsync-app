import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const daemonURL = env.VITE_DAEMON_URL || "http://127.0.0.1:8384";
  const apiKey = env.VITE_API_KEY || "";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      // Proxy all /rest/* calls to the running sync daemon. This
      // sidesteps CORS during dev — the browser sees a same-origin
      // request to the Vite dev server, which forwards to the daemon
      // with the X-API-Key header injected. In production (Wails or
      // similar) the frontend talks directly to the daemon and this
      // proxy is unused.
      proxy: {
        "/rest": {
          target: daemonURL,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader("X-API-Key", apiKey);
              }
            });
          },
        },
      },
    },
  };
});
