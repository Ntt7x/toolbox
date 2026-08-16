// 交易单批量解析纯函数（memo msvvn2v4）——独立模块便于单测（无 React 依赖）
// 格式：每行「[买/卖] 代码 数量 价格 [手续费] [备注]」，空格/tab/逗号分隔

export interface OrderRow {
  key: number;
  code: string;
  name?: string;
  action: "buy" | "sell";
  quantity: number;
  price: number;
  fee?: number;
  note?: string;
}

export function numInput(v: string): number {
  return Number(v.replace(/[,，\s]/g, "")) || 0;
}

/** 解析粘贴的批量交易文本；nextKey 生成行 key（调用方维护自增） */
export function parseBatchText(text: string, nextKey: (r: Omit<OrderRow, "key">) => number): OrderRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed: OrderRow[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) continue; // 注释行跳过
    const parts = line.split(/[,\t，、\s]+/).filter(Boolean);
    if (parts.length === 0) continue;
    let action: "buy" | "sell" = "buy";
    let pi = 0;
    const first = parts[0]!.toLowerCase();
    if (["买", "买入", "buy", "b", "加仓"].includes(first)) { action = "buy"; pi = 1; }
    else if (["卖", "卖出", "sell", "s", "减仓"].includes(first)) { action = "sell"; pi = 1; }
    const code = parts[pi] ?? ""; pi++;
    if (!code.trim()) continue;
    const quantity = numInput(parts[pi] ?? ""); pi++;
    const price = numInput(parts[pi] ?? ""); pi++;
    const fee = numInput(parts[pi] ?? ""); pi++;
    const note = parts.slice(pi).join(" ");
    const base: Omit<OrderRow, "key"> = { code: code.trim(), action, quantity, price, ...(fee > 0 ? { fee } : {}), ...(note ? { note } : {}) };
    parsed.push({ key: nextKey(base), ...base });
  }
  return parsed;
}
