import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __API_BASE__: JSON.stringify(process.env.VITE_API_BASE_URL ?? ""),
  },
  server: {
    proxy: {
      "/auth": {
        target: process.env.AUTH_URL ?? "http://localhost:3001",
        changeOrigin: true,
      },
      "/tree": {
        target: process.env.PLATFORM_URL ?? "http://localhost:3002",
        changeOrigin: true,
      },
      "/api": {
        target: process.env.API_URL ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
