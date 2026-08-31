// ============================================================
// 下层公共模块：文本匹配原子能力（非 LLM，零依赖，纯函数）
// - 精准匹配（exact）：归一化后子串包含，可选整词边界（拉丁/数字要求边界，CJK 天然成词）
// - 模糊匹配（fuzzy）：滑动窗口 + 编辑距离相似度，容忍错别字/简写/多字少字
// - 两类匹配统一返回**原始字符串下标**命中区间，供高亮渲染与打标共用
// 归一化做「逐码点 NFKC + 小写 + 空白折叠」并维护下标映射，
// 因此全角/半角、大小写、多余空格不影响匹配，且命中区间可回映原文。
// 不做任何 IO、不调 LLM（成本铁律 dev.md §6）
// ============================================================
import type { NewsMatchMode } from "@toolbox/shared";

/** 单处命中：区间下标基于原始字符串（左闭右开），score 为相似度（exact 恒为 1） */
export interface TextHit {
  start: number;
  end: number;
  /** 命中原文切片 */
  text: string;
  /** 命中的关键词 */
  word: string;
  /** 相似度 0~1（fuzzy 模式）；exact 命中恒为 1 */
  score: number;
}

export interface MatchOptions {
  /** 整词匹配（exact 生效）：命中两侧不得紧邻字母/数字 */
  wholeWord?: boolean;
  /**
   * fuzzy 相似度阈值（0~1，默认 0.65）。
   * 0.65 ≈ 「3 字错 1 字 / 6 字错 2 字」仍命中，同时随机文本几乎达不到该相似度（误命中低）。
   */
  threshold?: number;
}

/** fuzzy 默认阈值 */
export const FUZZY_THRESHOLD = 0.65;

/** 归一化结果：码点数组 + 「归一化下标 → 原始字符串下标」映射 */
interface Normalized {
  chars: string[];
  map: number[];
}

const WORD_CHAR = /[0-9a-z]/;

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch);
}

/** 归一化：逐码点 NFKC + 小写 + 连续空白折叠为一个空格；保留原始下标映射 */
function normalize(text: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];
  let idx = 0;
  for (const ch of text) {
    const folded = ch.normalize("NFKC").toLowerCase();
    for (const c of folded) {
      if (/\s/.test(c)) {
        // 连续空白折叠：只保留第一个空格对应的原始下标
        if (chars[chars.length - 1] !== " ") {
          chars.push(" ");
          map.push(idx);
        }
        continue;
      }
      chars.push(c);
      map.push(idx);
    }
    idx += ch.length;
  }
  return { chars, map };
}

/** 纯文本归一化结果（无下标映射，供外部比较/测试用） */
export function normalizeText(text: string): string {
  return normalize(text).chars.join("");
}

/** 词组解析：逗号/顿号/分号/换行分隔，保留词组内部空格（支持 "fed rate" 这类短语） */
export function parseWordList(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(/[,，、;；\n\r]+/);
  const out: string[] = [];
  for (const w of raw) {
    const t = String(w ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 编辑距离相似度（按码点）：1 - 距离 / max(len)；超过 maxEdits 直接判 0（早退）。
 * 完全一致返回 1；两空串返回 1。
 */
export function textSimilarity(a: string, b: string, maxEdits = Infinity): number {
  const ac = Array.from(a);
  const bc = Array.from(b);
  if (a === b) return 1;
  const max = Math.max(ac.length, bc.length);
  if (max === 0) return 1;
  if (Math.abs(ac.length - bc.length) > maxEdits) return 0;
  let prev = new Array<number>(bc.length + 1);
  let cur = new Array<number>(bc.length + 1);
  for (let j = 0; j <= bc.length; j++) prev[j] = j;
  for (let i = 1; i <= ac.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= bc.length; j++) {
      const cost = ac[i - 1] === bc[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const dist = prev[bc.length]!;
  if (dist > maxEdits) return 0;
  return 1 - dist / max;
}

/**
 * 允许的编辑距离：短词严格、长词宽松。
 * ≤2 字不允许错（1 字即 50% 差异，误命中不可控）；3~5 字允许 1；6~10 字允许 2；更长 3。
 */
function allowedEdits(len: number): number {
  if (len <= 2) return 0;
  if (len <= 5) return 1;
  if (len <= 10) return 2;
  return 3;
}

/** 命中区间回映：结束下标 = 下一个归一化字符的原始起点（末尾取原文长度） */
function endOf(norm: Normalized, at: number, len: number, textLen: number): number {
  const next = norm.map[at + len];
  return next === undefined ? textLen : next;
}

/**
 * 单文本 × 多关键词的命中查找（精准/模糊）。
 * 返回按 start 升序、互不重叠的命中列表（重叠时保留相似度更高/更长者）。
 */
export function findHits(
  text: string,
  words: string | string[],
  mode: NewsMatchMode = "exact",
  opts: MatchOptions = {},
): TextHit[] {
  const list = Array.isArray(words) ? words : parseWordList(words);
  if (!text) return [];
  const { wholeWord = false, threshold = FUZZY_THRESHOLD } = opts;
  const norm = normalize(text);
  const hits: TextHit[] = [];

  for (const word of list) {
    const w = String(word ?? "").trim();
    if (!w) continue;
    const nw = normalize(w);
    if (nw.chars.length === 0) continue;

    if (mode === "exact") {
      const n = nw.chars.length;
      for (let i = 0; i + n <= norm.chars.length; i++) {
        let ok = true;
        for (let k = 0; k < n; k++) {
          if (norm.chars[i + k] !== nw.chars[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (wholeWord && (isWordChar(norm.chars[i - 1]) || isWordChar(norm.chars[i + n]))) continue;
        hits.push({
          start: norm.map[i]!,
          end: endOf(norm, i, n, text.length),
          text: text.slice(norm.map[i]!, endOf(norm, i, n, text.length)),
          word: w,
          score: 1,
        });
      }
      continue;
    }

    // fuzzy：滑动窗口（长度 = 词长 ± 允许编辑数），相似度达阈值即命中
    const edits = allowedEdits(nw.chars.length);
    const minLen = Math.max(1, nw.chars.length - edits);
    const maxLen = nw.chars.length + edits;
    for (let i = 0; i + minLen <= norm.chars.length; i++) {
      for (let len = minLen; len <= maxLen && i + len <= norm.chars.length; len++) {
        const window = norm.chars.slice(i, i + len).join("");
        const score = textSimilarity(window, w, edits);
        if (score < threshold) continue;
        hits.push({
          start: norm.map[i]!,
          end: endOf(norm, i, len, text.length),
          text: text.slice(norm.map[i]!, endOf(norm, i, len, text.length)),
          word: w,
          score,
        });
        break; // 同一窗口起点取最短命中，避免重复
      }
    }
  }

  return mergeHits(hits);
}

/** 合并重叠命中：按 start 升序；重叠时保留 score 高者（同分取更长者） */
export function mergeHits(hits: TextHit[]): TextHit[] {
  const sorted = [...hits].sort(
    (a, b) => a.start - b.start || b.score - a.score || b.end - b.start - (a.end - a.start),
  );
  const out: TextHit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) {
      const better = h.score > last.score || (h.score === last.score && h.end - h.start > last.end - last.start);
      if (better) out[out.length - 1] = h;
      continue;
    }
    out.push(h);
  }
  return out;
}

/** 原子能力：文本是否命中任一词组（打标/黑名单判定用） */
export function matchText(
  text: string,
  words: string | string[],
  mode: NewsMatchMode = "exact",
  opts: MatchOptions = {},
): boolean {
  return findHits(text, words, mode, opts).length > 0;
}
