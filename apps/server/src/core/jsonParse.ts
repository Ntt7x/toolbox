// ============================================================
// 下层公共模块：LLM JSON 输出容错解析
// 逐级降级：直接 parse → 栈匹配提取最外层 JSON → 修复值内裸引号后 parse。
// LLM 常在字符串值内插入未转义的半角引号（如 "摘要"xxx"yyy"），
// 直接 JSON.parse 必然失败，需启发式修复。
// 供所有 LLM 结构化输出业务复用（cbRate / treasuryFx 等）。
// ============================================================

/** 提取从首个 open 到最外层配对的 close 的子串（跳过字符串内的括号） */
function extractOuter(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 提取从首个 { 到最外层配对的 } 的子串（跳过字符串内的 { }） */
export function extractOuterJson(text: string): string | null {
  return extractOuter(text, "{", "}");
}

/** 提取从首个 [ 到最外层配对的 ] 的子串（跳过字符串内的 [ ]）——LLM 输出数组根时用（2026-08 修复） */
export function extractOuterArray(text: string): string | null {
  return extractOuter(text, "[", "]");
}

/**
 * 修复字符串值内未转义的半角引号。
 * 两遍扫描：
 * 1) 第一遍定位字符串状态内所有裸引号，按后随字符分为"内容引号"与"结束候选"；
 * 2) 最后一个结束候选作为真正的字符串结束引号，其余（含全部内容引号）一律转义。
 * 覆盖 LLM 最常见的畸形模式：内容引号成对出现且与字符串结束挤在一起（如 "高"}"）。
 */
export function fixJsonQuotes(s: string): string {
  // 第一遍：标记
  const marks: { pos: number; kind: "content" | "end-cand" }[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        const rest = s.slice(i + 1).replace(/^\s+/, "");
        const isEnd =
          rest.startsWith(",") || rest.startsWith("}") || rest.startsWith("]") || rest.startsWith(":");
        marks.push({ pos: i, kind: isEnd ? "end-cand" : "content" });
      }
    } else if (ch === '"') {
      inStr = true;
    }
  }
  const ends = marks.filter((m) => m.kind === "end-cand");
  const endPos = ends.length > 0 ? ends[ends.length - 1].pos : -1;
  const contentPos = new Set(marks.filter((m) => m.kind === "content").map((m) => m.pos));

  // 第二遍：重写（只转义 content 引号；键名闭合等合法结构引号保持原样）
  let out = "";
  inStr = false;
  esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        if (i === endPos) {
          out += ch;
          inStr = false;
        } else if (contentPos.has(i)) {
          out += '\\"';
        } else {
          out += ch;
          inStr = false;
        }
      } else {
        out += ch;
      }
    } else {
      out += ch;
      if (ch === '"') inStr = true;
    }
  }
  return out;
}

/** 多层容错解析：成功返回对象，失败返回 null */
export function robustJsonParse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  // 1. 直接解析
  let v = tryParse(trimmed);
  if (v) return v;
  // 2. 栈匹配提取最外层 JSON（容忍前后杂质/代码块；假设结构合法）
  //    按「首次出现的括号类型」选择对象/数组提取：对象根（{ 在前）与数组根（[ 在前）都覆盖，
  //    避免数组根被降级为第一个元素对象（2026-08 修复）
  const objAt = trimmed.indexOf("{");
  const arrAt = trimmed.indexOf("[");
  let outer: string | null = null;
  let outerArr: string | null = null;
  if (objAt >= 0 && (arrAt < 0 || objAt < arrAt)) {
    outer = extractOuterJson(trimmed);
    if (outer) {
      v = tryParse(outer);
      if (v) return v;
    }
  } else if (arrAt >= 0) {
    outerArr = extractOuterArray(trimmed);
    if (outerArr) {
      v = tryParse(outerArr);
      if (v) return v;
    }
  }
  // 3. 修复值内裸引号后整体解析（fix 使引号恢复平衡）
  const fixed = fixJsonQuotes(trimmed);
  v = tryParse(fixed);
  if (v) return v;
  // 4. 修复后重新提取最外层再解析
  if (outer) {
    v = tryParse(fixJsonQuotes(outer));
    if (v) return v;
  }
  if (outerArr) {
    v = tryParse(fixJsonQuotes(outerArr));
    if (v) return v;
  }
  return null;
}
