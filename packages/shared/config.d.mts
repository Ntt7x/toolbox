// ============================================================
// 服务配置内核类型（packages/shared/config.d.mts）
// 实现在 config.mjs（纯 ESM，服务端 TS 与 scripts/*.mjs 共用）；本文件只提供类型。
// ============================================================

/** 配置文件中可写的完整结构（toolbox.config.json / toolbox.config.local.json） */
export interface ToolboxConfigFile {
  server: {
    /** 监听地址：null = 不指定（Node 默认双栈绑定） */
    host: string | null;
    /** server 监听端口（prod 环境） */
    port: number;
    /** 数据目录（相对仓库根，绝对路径直接生效） */
    dataDir: string;
    /** SQLite 数据库文件名（相对 dataDir，绝对路径直接指向库文件） */
    dbFile: string;
    /** CORS：true=允许全部来源；也可写 origin 字符串或其数组 */
    cors: boolean | string | string[];
  };
  web: {
    host: string;
    port: number;
  };
  env: {
    /** 命中此分支即为 prod 环境 */
    prodBranch: string;
    devServerPortBase: number;
    devWebPortBase: number;
    maxSlots: number;
    envsDir: string;
  };
  supervisor: {
    healthCheckMs: number;
    idleThreshold: number;
    restartLimit: number;
    spawnGraceMs: number;
    readyTimeoutMs: number;
  };
}

/** 单个配置文件层的加载情况 */
export interface ConfigSource {
  label: string;
  file: string;
  loaded: boolean;
}

/** 环境变量覆盖记录 */
export interface ConfigEnvOverride {
  name: string;
  path: string;
  value: string | number;
}

/** 解析后的配置（= 配置文件内容 + 派生绝对路径 + 来源追踪） */
export interface ResolvedConfig extends ToolboxConfigFile {
  paths: {
    /** 仓库根（绝对路径） */
    root: string;
    configFile: string;
    localConfigFile: string;
    extraConfigFile: string | null;
    /** server.dataDir 解析后的绝对路径 */
    dataDir: string;
    /** dataDir + dbFile，即 SQLite 实际库文件绝对路径 */
    dbPath: string;
    /** env.envsDir 解析后的绝对路径 */
    envsDir: string;
  };
  sources: ConfigSource[];
  envOverrides: ConfigEnvOverride[];
}

export interface LoadConfigOptions {
  /** 仓库根（缺省按本文件位置自动探测） */
  root?: string;
  /** 环境变量（缺省 process.env） */
  env?: Record<string, string | undefined>;
  /** 额外配置文件（缺省取 env.TOOLBOX_CONFIG_FILE） */
  extraConfigFile?: string;
  /** 静默（不打印警告） */
  silent?: boolean;
}

/** 内置默认配置（= 无配置文件时的行为） */
export declare const DEFAULT_CONFIG: ToolboxConfigFile;

export declare const CONFIG_FILE_NAME: string;
export declare const LOCAL_CONFIG_FILE_NAME: string;

/** 加载并校验配置（配置有误直接抛错，拒绝静默忽略） */
export declare function loadConfig(opts?: LoadConfigOptions): ResolvedConfig;
