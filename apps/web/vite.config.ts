import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// 环境感知（2026-09-02）：端口与 API 代理目标由 dev.mjs 注入环境变量驱动。
//   prod（main 分支）：web 5173 + 代理到 server 8787（历史默认，行为不变）
//   dev（开发分支）  ：web 5180+slot + 代理到 server 8800+slot，与 prod 及其它分支并存互不干扰
const serverPort = Number(process.env.TOOLBOX_SERVER_PORT ?? 8787);
const webPort = Number(process.env.TOOLBOX_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: webPort,
    // 端口被占（如另一分支已占用同槽位）不自动顺延——顺延会让「env status 显示的端口」与实际不符，
    // 排查成本高；宁可显式报错由用户处理。
    strictPort: true,
    proxy: {
      // 前端所有 /api 请求转发到 TS 后端；后端换成 Go 时改这里即可
      "/api": `http://localhost:${serverPort}`,
    },
  },
});
