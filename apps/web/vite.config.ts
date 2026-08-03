import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const webPort = Number(process.env.WEB_PORT ?? 4173);
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4100";
const buildOutDir = process.env.WEB_BUILD_OUT_DIR ?? "dist";
const productionOutDir = resolve(process.cwd(), "dist");
if (process.env.VITE_DEMO_LOGIN === "true" && resolve(process.cwd(), buildOutDir) === productionOutDir) {
  throw new Error("Refusing to write a demo-login Web build into the production dist directory");
}
const apiProxy = {
  "/api": { target: apiTarget, changeOrigin: true },
  "/health": { target: apiTarget, changeOrigin: true }
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    proxy: apiProxy
  },
  preview: {
    host: "127.0.0.1",
    port: webPort,
    proxy: apiProxy
  },
  build: {
    outDir: buildOutDir,
    sourcemap: process.env.WEB_SOURCEMAP === "true"
  }
});
