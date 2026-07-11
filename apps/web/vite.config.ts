import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  return {
    envDir: "../..",
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET ?? `http://127.0.0.1:${env.PORT || "8787"}`,
          changeOrigin: true,
        },
      },
    },
  };
});
