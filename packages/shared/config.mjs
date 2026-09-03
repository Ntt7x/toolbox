// ============================================================
// 服务配置内核（packages/shared/config.mjs）
// ------------------------------------------------------------
// 目的：**配置化 + 配置文件化**——服务跑哪个库、监听哪个端口、日志/数据落在哪，
// 一律由配置文件决定，不再散落在代码里硬编码（部署与服务管理的前提）。
//
// 为什么是 .mjs（纯 JS）而不是 .ts：
//   服务端（TS，经 tsx 运行）与 scripts/dev-utils/*.mjs（纯 node 运行）都要用同一份配置。
//   shared 包的其它模块是 TS，脚本侧无法直接 import → 配置内核用零依赖纯 ESM，
//   两端共用同一实现，避免「两份默认值各改一半」的漂移。类型见 config.d.mts。
//
// 配置文件（均位于仓库根）：
//   toolbox.config.json        ← 提交进仓库的**默认配置**（所有人共享，改它即改部署基线）
//   toolbox.config.local.json  ← 本地/机器私有覆盖（已 .gitignore，不提交）
//
// 优先级（后者覆盖前者）：
//   内置默认值 DEFAULTS
//     → toolbox.config.json
//     → toolbox.config.local.json
//     → TOOLBOX_CONFIG_FILE 指定的额外配置文件（部署时指向 /etc/toolbox.json 之类）
//     → 环境变量（PORT / TOOLBOX_SERVER_PORT / TOOLBOX_DATA_DIR / TOOLBOX_DB_FILE …）
//
// 约定的路径语义：
//   相对路径一律相对**仓库根**解析；绝对路径直接胜出（dev 环境注入绝对路径就靠这条）。
//   server.dbFile 相对 server.dataDir 解析（写绝对路径则整体指向别处）。
// ============================================================
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- 仓库根定位 ----------

/**
 * 仓库根：由本文件真实路径上溯两级（packages/shared → 根）。
 * 用 realpathSync 是因为 workspace 软链（apps/server/node_modules/@toolbox/shared）
 * 会让 import.meta.url 指向链接路径，不还原会定位到错误的根。
 */
function detectRoot() {
  const self = realpathSync(fileURLToPath(import.meta.url));
  return resolve(dirname(self), "..", "..");
}

// ---------- 内置默认值 ----------

/**
 * 内置默认配置（= 无任何配置文件时的行为，与 2026-09-04 之前的历史行为一致）。
 * 注意：只放**真正被代码消费**的开关——不消费的配置项等于谎言。
 */
export const DEFAULT_CONFIG = Object.freeze({
  server: Object.freeze({
    /** 监听地址：null = 不指定（Node 默认双栈绑定，保持历史行为）；部署到内网可写 "0.0.0.0" */
    host: null,
    /** server 监听端口（prod 环境） */
    port: 8787,
    /** 数据目录（相对仓库根；绝对路径直接生效）——SQLite 库、docs 二进制、浏览器 profile 都在其下 */
    dataDir: ".file",
    /** SQLite 数据库文件名（相对 dataDir；绝对路径则直接指向库文件） */
    dbFile: "toolbox.db",
    /** CORS：true=允许全部来源；也可写具体 origin 字符串或字符串数组 */
    cors: true,
  }),
  web: Object.freeze({
    /** vite dev server 监听地址 */
    host: "localhost",
    /** vite dev server 端口（prod 环境） */
    port: 5173,
  }),
  env: Object.freeze({
    /** 命中此分支即为 prod 环境（真实数据实例）；其它分支为 dev（独立端口与数据） */
    prodBranch: "main",
    /** dev 环境 server 端口段起始：8800 + slot */
    devServerPortBase: 8800,
    /** dev 环境 web 端口段起始：5180 + slot */
    devWebPortBase: 5180,
    /** dev 环境最大槽位数（可并存的开发分支数） */
    maxSlots: 50,
    /** dev 环境根目录（注册表/各分支数据与日志都在其下） */
    envsDir: ".file/envs",
  }),
  supervisor: Object.freeze({
    /** 健康检查间隔（ms）：进程退出/端口空闲检测频率 */
    healthCheckMs: 5000,
    /** 端口连续空闲 N 次才判定服务卡死（tsx watch 重编译期间端口会短暂空闲） */
    idleThreshold: 3,
    /** 单个服务的自动重启次数上限（超过即停止拉起，避免无限重启） */
    restartLimit: 12,
    /** 刚拉起后的宽限期（ms）：宽限期内不做空闲判定 */
    spawnGraceMs: 15000,
    /** start/restart 前台等待就绪的超时（ms） */
    readyTimeoutMs: 20000,
  }),
});

/** 配置文件名（均在仓库根） */
export const CONFIG_FILE_NAME = "toolbox.config.json";
export const LOCAL_CONFIG_FILE_NAME = "toolbox.config.local.json";

// ---------- 校验规则 ----------

const PORT_RANGE = { min: 1, max: 65535 };

/** 字段校验表：路径 → 期望类型与约束（配置写错要**立刻报错**，静默忽略最坑） */
const SCHEMA = {
  "server.host": { types: ["string", "null"] },
  "server.port": { types: ["number"], ...PORT_RANGE, integer: true },
  "server.dataDir": { types: ["string"], nonEmpty: true },
  "server.dbFile": { types: ["string"], nonEmpty: true },
  "server.cors": { types: ["boolean", "string", "array"] },
  "web.host": { types: ["string"] },
  "web.port": { types: ["number"], ...PORT_RANGE, integer: true },
  "env.prodBranch": { types: ["string"], nonEmpty: true },
  "env.devServerPortBase": { types: ["number"], ...PORT_RANGE, integer: true },
  "env.devWebPortBase": { types: ["number"], ...PORT_RANGE, integer: true },
  "env.maxSlots": { types: ["number"], min: 1, integer: true },
  "env.envsDir": { types: ["string"], nonEmpty: true },
  "supervisor.healthCheckMs": { types: ["number"], min: 100, integer: true },
  "supervisor.idleThreshold": { types: ["number"], min: 1, integer: true },
  "supervisor.restartLimit": { types: ["number"], min: 1, integer: true },
  "supervisor.spawnGraceMs": { types: ["number"], min: 0, integer: true },
  "supervisor.readyTimeoutMs": { types: ["number"], min: 0, integer: true },
};

/** 环境变量 → 配置路径（数组顺序即优先级，后者覆盖前者） */
const ENV_MAP = [
  ["PORT", "server.port", Number],
  ["TOOLBOX_SERVER_PORT", "server.port", Number],
  ["TOOLBOX_HOST", "server.host", String],
  ["TOOLBOX_DATA_DIR", "server.dataDir", String],
  ["TOOLBOX_DB_FILE", "server.dbFile", String],
  ["TOOLBOX_WEB_PORT", "web.port", Number],
  ["TOOLBOX_WEB_HOST", "web.host", String],
  ["TOOLBOX_ENVS_DIR", "env.envsDir", String],
  ["TOOLBOX_MAX_SLOTS", "env.maxSlots", Number],
];

// ---------- 解析工具 ----------

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 预处理配置文本：去掉 `//` 与 `/* *\/` 注释、去掉尾逗号。
 * 手写配置文件没有注释很难维护，但严格 JSON 不允许——自己做一遍字符串感知的剥离
 * （字符串内的 `//`、`", }` 不受影响）。
 */
function preprocessJson(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === ",") {
      // 尾逗号：逗号之后（跳过空白）紧接 } 或 ] 时丢弃该逗号
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") { i = j; continue; }
      out += ch; i += 1; continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 深合并（对象递归，其余类型整体覆盖） */
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * 校验：不合法直接抛错，附带来源与字段路径。
 * 支持**部分配置**（只写 server 段的文件也能过）——只校验出现的字段。
 */
function validate(cfg, source) {
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!prefix) {
        // 顶层段（server/web/env/supervisor）：合法性已由 assertKnownSections 把关，只管往下递归
        if (isPlainObject(v)) walk(v, path);
        continue;
      }
      const rule = SCHEMA[path];
      if (!rule) {
        // 未知字段：拼错的配置静默不生效最坑，宁可启动失败
        throw new Error(`配置字段未知：${path}（来源 ${source}）— 可配置字段见 toolbox.config.json`);
      }
      const t = typeName(v);
      if (!rule.types.includes(t)) {
        throw new Error(`配置字段类型错误：${path} 期望 ${rule.types.join("|")}，实际 ${t}（来源 ${source}）`);
      }
      if (rule.integer && !Number.isInteger(v)) throw new Error(`配置字段必须是整数：${path}=${v}（来源 ${source}）`);
      if (rule.min !== undefined && v < rule.min) throw new Error(`配置字段超出下界：${path}=${v} < ${rule.min}（来源 ${source}）`);
      if (rule.max !== undefined && v > rule.max) throw new Error(`配置字段超出上界：${path}=${v} > ${rule.max}（来源 ${source}）`);
      if (rule.nonEmpty && String(v).trim() === "") throw new Error(`配置字段不能为空：${path}（来源 ${source}）`);
      if (isPlainObject(v)) walk(v, path);
    }
  };
  walk(cfg, "");
}

// ---------- 加载 ----------

/** 读取并解析一个配置文件；不存在返回 null */
function readConfigFile(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(preprocessJson(readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`配置文件解析失败：${file}\n  ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`配置文件内容必须是 JSON 对象：${file}`);
  return parsed;
}

/** 校验未知顶层段（server/web/env/supervisor 之外的一律报错） */
function assertKnownSections(cfg, source) {
  for (const k of Object.keys(cfg)) {
    if (!(k in DEFAULT_CONFIG)) throw new Error(`配置段未知：${k}（来源 ${source}）— 可用段：${Object.keys(DEFAULT_CONFIG).join(", ")}`);
  }
}

/**
 * 加载配置。
 * @param {object} [opts]
 * @param {string} [opts.root]           仓库根（缺省自动探测）
 * @param {object} [opts.env]            环境变量（缺省 process.env）
 * @param {string} [opts.extraConfigFile] 额外配置文件（缺省取 env.TOOLBOX_CONFIG_FILE）
 * @param {boolean} [opts.silent]        静默（不打印警告）
 * @returns {object} 解析后的配置（含 paths / sources）
 */
export function loadConfig(opts = {}) {
  const root = resolve(opts.root ?? detectRoot());
  const env = opts.env ?? process.env;
  const configFile = join(root, CONFIG_FILE_NAME);
  const localConfigFile = join(root, LOCAL_CONFIG_FILE_NAME);
  const extraConfigFile = opts.extraConfigFile ?? env.TOOLBOX_CONFIG_FILE?.trim() ?? "";

  // 分层合并：默认 → 主配置 → 本地覆盖 → 额外配置
  let merged = structuredClone(DEFAULT_CONFIG);
  const sources = [];
  const layers = [
    { file: configFile, label: CONFIG_FILE_NAME, required: false },
    { file: localConfigFile, label: LOCAL_CONFIG_FILE_NAME, required: false },
    { file: extraConfigFile, label: extraConfigFile || "(TOOLBOX_CONFIG_FILE)", required: false },
  ];
  for (const layer of layers) {
    if (!layer.file) continue;
    const parsed = readConfigFile(resolve(root, layer.file));
    if (!parsed) { sources.push({ label: layer.label, file: layer.file, loaded: false }); continue; }
    // 逐层校验：**报错能精确指向是哪个文件写错**（合并后再校验只能含糊说"某处"）
    assertKnownSections(parsed, layer.label);
    validate(parsed, layer.label);
    merged = deepMerge(merged, parsed);
    sources.push({ label: layer.label, file: layer.file, loaded: true });
  }

  // 环境变量覆盖（最高优先级：部署/CI 临时改端口与库路径）
  const envOverrides = [];
  for (const [name, path, cast] of ENV_MAP) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    const value = cast === Number ? Number(String(raw).trim()) : String(raw).trim();
    if (cast === Number && !Number.isFinite(value)) {
      throw new Error(`环境变量 ${name} 不是合法数字：${raw}`);
    }
    const [section, key] = path.split(".");
    merged[section][key] = value;
    envOverrides.push({ name, path, value });
  }

  // 环境变量覆盖后复检（只可能因环境变量写错而失败）
  if (envOverrides.length > 0) validate(merged, `环境变量 ${envOverrides.map((o) => o.name).join(", ")}`);

  // 路径解析：相对路径 → 相对仓库根；绝对路径直接胜出
  const dataDir = isAbsolute(merged.server.dataDir) ? merged.server.dataDir : resolve(root, merged.server.dataDir);
  const dbPath = isAbsolute(merged.server.dbFile) ? merged.server.dbFile : join(dataDir, merged.server.dbFile);
  const envsDir = isAbsolute(merged.env.envsDir) ? merged.env.envsDir : resolve(root, merged.env.envsDir);

  return {
    ...merged,
    paths: { root, configFile, localConfigFile, extraConfigFile: extraConfigFile || null, dataDir, dbPath, envsDir },
    sources,
    envOverrides,
  };
}
