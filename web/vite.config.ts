import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/crm/",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/crm/api": { target: "http://localhost:8000", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    // tokens.test.ts reads tokens.css?raw; vitest blanks CSS unless included here.
    css: { include: [/tokens\.css/] },
  },
});
