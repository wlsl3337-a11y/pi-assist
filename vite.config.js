import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    // ESM 전용 구문(import.meta) 대신 빌드타임 상수 주입 — 아티팩트 파서 호환 유지
    define: { __AI_PROXY_BASE__: JSON.stringify(env.VITE_AI_PROXY_BASE || "") },
    server: {
      host: true,
      proxy: { "/api": "http://localhost:8787" },
    },
  };
});
