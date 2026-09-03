import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { loadConfig } from "../../packages/shared/config.mjs";

// 配置化（2026-09-04）：端口与 API 代理目标统一取自配置内核（与服务端、脚本同一份实现），
//   不再在此处兜底硬编码——改 toolbox.config.json 即改全套端口。
// 环境感知：prod（main 分支）用 server.port / web.port；
//   dev（开发分支）由 dev.mjs 注入 TOOLBOX_SERVER_PORT / TOOLBOX_WEB_PORT 覆盖（8800+slot / 5180+slot）。
const config = loadConfig();
const serverPort = config.server.port;
const webPort = config.web.port;

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
