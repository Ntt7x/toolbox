// ============================================================
// 业务模块：新闻中心 · 文本加工编排（features/newsCenter/textRules）
// - 依赖 core/newsText 的匹配原子能力（精准/模糊，非 LLM）
// - 配置存本地设置数据（settings:news.textConfig），经「本地数据管理」可查
// - 加工流水线（纯函数、可单测）：黑名单判定 → 规则打标 → 高亮命中
// ============================================================
import type {
  NewsBlacklistConfig,
  NewsHighlightConfig,
  NewsMatchMode,
  NewsTagRule,
  NewsTextConfig,
  NewsTextHit,
  ProcessedNewsItem,
} from "@toolbox/shared";
import { findHits, matchText, parseWordList } from "../../core/newsText.js";
import { registerDataSource } from "../../core/dataRegistry.js";
import { getSetting, setSetting } from "../../core/settingsStore.js";

const CONFIG_KEY = "news.textConfig";

/** 内置「重要」词库（沿用展示区原硬编码的重要关键词，改为可配置后的默认值） */
const IMPORTANT_WORDS = [
  "利率", "央行", "降息", "加息", "CPI", "PPI", "逆回购", "MLF", "LPR",
  "货币政策", "美联储", "议息", "降准", "存款准备金", "国债", "汇率", "通胀", "财政政策",
];

/** 默认配置：重要标签 + 同词组高亮，黑名单默认关闭 */
export const DEFAULT_TEXT_CONFIG: NewsTextConfig = {
  rules: [{ id: "builtin-important", name: "重要", mode: "exact", keywords: [...IMPORTANT_WORDS], color: "#f97316", enabled: true }],
  highlight: { enabled: true, mode: "exact", words: [...IMPORTANT_WORDS] },
  blacklist: { enabled: false, mode: "fuzzy", words: [], action: "hide" },
};

const MAX_RULES = 30;
const MAX_WORDS = 200;
const MAX_WORD_LEN = 60;

/** 待加工的新闻条目（与 features/newsCenter 的 NewsItem 结构一致） */
export interface RawNewsItem {
  title: string;
  digest: string;
  time: string;
  url: string;
  source: string;
  sourceName: string;
}

// ---------- 配置读写 ----------

function asMode(v: unknown): NewsMatchMode {
  return v === "fuzzy" ? "fuzzy" : "exact";
}

function asWords(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((x) => String(x ?? "")) : typeof v === "string" ? v.split(/[,，、;；\n\r]+/) : [];
  return parseWordList(list)
    .map((w) => w.slice(0, MAX_WORD_LEN))
    .slice(0, MAX_WORDS);
}

/** 脏数据兜底：任何字段缺失/类型错误都退回默认，保证加工永不抛错 */
export function sanitizeTextConfig(raw: unknown): NewsTextConfig {
  const src = (raw ?? {}) as Partial<NewsTextConfig>;
  const rules: NewsTagRule[] = Array.isArray(src.rules)
    ? src.rules
        .slice(0, MAX_RULES)
        .map((r, i) => {
          const o = (r ?? {}) as Partial<NewsTagRule>;
          const name = String(o.name ?? "").trim().slice(0, 30);
          const keywords = asWords(o.keywords);
          return {
            id: String(o.id ?? "").trim() || `rule-${i + 1}`,
            name,
            mode: asMode(o.mode),
            keywords,
            ...(typeof o.color === "string" && o.color.trim() ? { color: o.color.trim().slice(0, 20) } : {}),
            enabled: o.enabled !== false,
          };
        })
        .filter((r) => r.name && r.keywords.length > 0)
    : [];
  const hl = (src.highlight ?? {}) as Partial<NewsHighlightConfig>;
  const bl = (src.blacklist ?? {}) as Partial<NewsBlacklistConfig>;
  return {
    rules: rules.length > 0 || Array.isArray(src.rules) ? rules : DEFAULT_TEXT_CONFIG.rules.map((r) => ({ ...r, keywords: [...r.keywords] })),
    highlight: { enabled: hl.enabled !== false, mode: asMode(hl.mode), words: asWords(hl.words) },
    blacklist: {
      enabled: bl.enabled === true,
      mode: asMode(bl.mode),
      words: asWords(bl.words),
      action: bl.action === "mark" ? "mark" : "hide",
    },
  };
}

/** 读取文本加工配置（无配置 → 默认） */
export function getTextConfig(): NewsTextConfig {
  return sanitizeTextConfig(getSetting<NewsTextConfig>(CONFIG_KEY) ?? DEFAULT_TEXT_CONFIG);
}

/** 保存文本加工配置（校验后落库） */
export function saveTextConfig(input: unknown): { ok: boolean; config: NewsTextConfig; message?: string } {
  const cfg = sanitizeTextConfig(input);
  if (cfg.rules.some((r) => !r.name.trim())) return { ok: false, config: getTextConfig(), message: "规则名不能为空" };
  if (cfg.highlight.enabled && cfg.highlight.words.length === 0 && cfg.rules.length === 0) {
    return { ok: false, config: getTextConfig(), message: "高亮词组为空（请填词组或关闭高亮）" };
  }
  setSetting(CONFIG_KEY, cfg);
  return { ok: true, config: cfg };
}

// ---------- 加工流水线 ----------

/** 单条加工：黑名单 → 打标 → 高亮（任一环节异常不影响整条新闻展示） */
export function processItem(item: RawNewsItem, cfg: NewsTextConfig = getTextConfig()): ProcessedNewsItem {
  const title = item.title ?? "";
  const digest = item.digest ?? "";
  const blockHits: string[] = [];
  if (cfg.blacklist.enabled && cfg.blacklist.words.length > 0) {
    for (const w of cfg.blacklist.words) {
      if (matchText(title, [w], cfg.blacklist.mode) || matchText(digest, [w], cfg.blacklist.mode)) blockHits.push(w);
    }
  }
  const tags: string[] = [];
  for (const r of cfg.rules) {
    if (!r.enabled || r.keywords.length === 0) continue;
    if (matchText(title, r.keywords, r.mode) || matchText(digest, r.keywords, r.mode)) {
      if (!tags.includes(r.name)) tags.push(r.name);
    }
  }
  const hits: NewsTextHit[] = [];
  if (cfg.highlight.enabled && cfg.highlight.words.length > 0) {
    for (const field of ["title", "digest"] as const) {
      const text = field === "title" ? title : digest;
      for (const h of findHits(text, cfg.highlight.words, cfg.highlight.mode)) {
        hits.push({ field, start: h.start, end: h.end, text: h.text, word: h.word });
      }
    }
  }
  return { ...item, title, digest, tags, blockHits, blocked: blockHits.length > 0, hits };
}

/**
 * 流式加工：对新闻流逐条加工（分页追加时按同一配置加工，口径一致）。
 * 黑名单 action=hide 的条目被剔除（计数回传，前端可提示"已过滤 N 条"）。
 */
export function processNews(
  items: RawNewsItem[],
  cfg: NewsTextConfig = getTextConfig(),
): { items: ProcessedNewsItem[]; blockedCount: number } {
  const out: ProcessedNewsItem[] = [];
  let blockedCount = 0;
  for (const it of items) {
    const p = processItem(it, cfg);
    if (p.blocked && cfg.blacklist.enabled && cfg.blacklist.action === "hide") {
      blockedCount++;
      continue;
    }
    out.push(p);
  }
  return { items: out, blockedCount };
}

/** 自定义文本试跑（配置页预览：把一段文本当作一条新闻加工） */
export function processTextItem(text: string, cfg: NewsTextConfig): ProcessedNewsItem {
  const [title = "", ...rest] = String(text ?? "").split(/\r?\n/);
  return processItem(
    { title, digest: rest.join("\n"), time: "", url: "", source: "preview", sourceName: "试跑" },
    cfg,
  );
}

registerDataSource({
  kind: "kv",
  name: "settings:news.",
  page: "新闻中心",
  tag: "配置数据",
  description: "新闻源启用配置 + 文本加工配置（打标规则 / 高亮词组 / 黑名单词组）",
});
