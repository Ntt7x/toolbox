// ============================================================
// 公共·证券代码搜索（东方财富 suggest：名称/拼音 → 代码候选）
// 原为 features/watchlist 内联裸 fetch（违反「禁止裸 fetch 散落 feature」红线），
// 2026-09-01 上提到 core 作为公共取数能力，供自选股 / 仓位管理等复用。
// 数据工程定位：外部 API 源（kind=api），走统一缓存（TTL.DAILY，代码映射几乎不变）。
// ============================================================
import { cachedFetch } from "./cache.js";
import { TTL } from "./cache.js";
import { registerDataSource } from "./dataRegistry.js";

/** 搜索结果条目 */
export interface StockSearchItem {
  /** 纯数字代码（如 600519 / 00700） */
  code: string;
  /** 证券名称 */
  name: string;
  /** 市场：sh / sz / bj / hk；无法判定时空串 */
  market: string;
  /** 证券类型（沪A / 深A / 港股 / ETF…） */
  type: string;
}

/** 东财 suggest 原始条目（仅取用字段） */
interface EastmoneySuggestRow {
  Code?: string;
  Name?: string;
  MktNum?: string | number;
  SecurityTypeName?: string;
}

registerDataSource({
  kind: "kv",
  name: "ds:eastmoney.suggest",
  page: "行情工具",
  tag: "分析数据",
  description: "证券代码搜索缓存（东方财富 suggest，名称/拼音 → 代码候选，TTL 24h）",
});

/** 市场判定：MktNum 优先（1=沪 2=深 3=京 116=港），退化为类型名关键字 */
function marketOf(mkt: string, type: string): string {
  if (mkt === "1") return "sh";
  if (mkt === "2") return "sz";
  if (mkt === "3") return "bj";
  if (mkt === "116") return "hk";
  if (type.includes("港")) return "hk";
  if (type.includes("深")) return "sz";
  if (type.includes("沪")) return "sh";
  if (type.includes("京")) return "bj";
  return "";
}

/** 缓存 key 版本：解析逻辑/字段变更时 +1 */
const CACHE_V = "v1";

/**
 * 按名称/拼音搜索证券代码（东方财富 suggest）。
 * 失败返回空数组（不抛错，调用方给出「未找到」提示）——搜索是交互辅助，不应阻断流程。
 */
export async function searchStock(name: string, limit = 8): Promise<StockSearchItem[]> {
  const q = name.trim();
  if (!q) return [];
  const n = Math.min(20, Math.max(1, Math.floor(limit) || 8));
  const key = `ds:eastmoney.suggest:${CACHE_V}:${q}:${n}`;
  try {
    const r = await cachedFetch(
      key,
      TTL.DAILY,
      async () => {
        const res = await fetch(
          `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&count=${n}`,
          {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) throw new Error(`东财搜索接口 ${res.status}`);
        const j = (await res.json()) as { QuotationCodeTable?: { Data?: EastmoneySuggestRow[] } };
        return (j.QuotationCodeTable?.Data ?? [])
          .filter((x) => x?.Code && x?.Name)
          .map((x) => ({
            code: String(x.Code),
            name: x.Name ?? "",
            market: marketOf(String(x.MktNum ?? ""), x.SecurityTypeName ?? ""),
            type: x.SecurityTypeName ?? "",
          }));
      },
      { staleIfError: true },
    );
    return r.data;
  } catch {
    return [];
  }
}
