import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  API_PREFIX,
  type HealthResponse,
  type ToolListResponse,
  type ToolMeta,
} from "@toolbox/shared";

const app = new Hono();
app.use(`${API_PREFIX}/*`, cors());

// 健康检查：vibe coding 阶段用于验证前后端联通
app.get(`${API_PREFIX}/health`, (c) => {
  const body: HealthResponse = {
    ok: true,
    service: "toolbox-server",
    version: "0.1.0",
    time: new Date().toISOString(),
  };
  return c.json(body);
});

// 小工具注册表（占位：实际工具由 vibe coding 逐步添加）
const tools: ToolMeta[] = [
  {
    id: "json-format",
    name: "JSON 格式化",
    description: "格式化 / 校验 / 压缩 JSON",
    path: "/tools/json-format",
  },
  {
    id: "uuid",
    name: "UUID 生成",
    description: "生成批量随机 UUID（v4）",
    path: "/tools/uuid",
  },
  {
    id: "base64",
    name: "Base64 编解码",
    description: "文本 / 文件的 Base64 编解码",
    path: "/tools/base64",
  },
];

app.get(`${API_PREFIX}/tools`, (c) => {
  const body: ToolListResponse = { tools };
  return c.json(body);
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`toolbox server: http://localhost:${info.port}${API_PREFIX}/health`);
});
