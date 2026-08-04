import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端所有 /api 请求转发到 TS 后端；后端换成 Go 时改这里即可
      "/api": "http://localhost:8787",
    },
  },
});
