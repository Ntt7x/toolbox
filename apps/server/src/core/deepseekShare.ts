// ============================================================
// 公共模块：DeepSeek 分享链接对话提取
// 输入 deepseek public link（或 share id）→ 调用 DeepSeek
// share/content API → 规范化输出完整对话（含 thinking/token）
// ============================================================

import type { ShareExtractResult, ShareMessage } from "@toolbox/shared";

const SHARE_API = "https://chat.deepseek.com/api/v0/share/content";
const SHARE_HOST = "chat.deepseek.com";

/** 从输入中提取 share id：支持完整链接或裸 id */
export function parseShareId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // 裸 id：字母数字短横线下划线，8~64 位
  if (/^[a-zA-Z0-9_-]{8,64}$/.test(s)) return s;
  // 完整链接
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (u.hostname !== SHARE_HOST && !u.hostname.endsWith(`.${SHARE_HOST}`)) return null;
    const m = u.pathname.match(/\/share\/([a-zA-Z0-9_-]{8,64})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** DeepSeek share/content API 原始响应（仅取所需字段） */
interface ShareApiData {
  code?: number;
  data?: {
    biz_code?: number;
    biz_data?: {
      title?: string;
      messages?: {
        message_id?: number;
        role?: string;
        content?: string;
        thinking?: string | null;
        inserted_at?: number;
        accumulated_token_usage?: number;
      }[];
    };
  };
}

/** 调用 DeepSeek 分享 API 获取原始数据 */
async function fetchShareRaw(shareId: string): Promise<ShareApiData> {
  const url = `${SHARE_API}?share_id=${encodeURIComponent(shareId)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json",
      Referer: `https://${SHARE_HOST}/share/${shareId}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek 分享接口响应异常（HTTP ${res.status}）`);
  }
  const json = (await res.json().catch(() => null)) as ShareApiData | null;
  if (!json || typeof json.code !== "number" || json.code !== 0 || !json.data) {
    throw new Error("分享内容解析失败：接口返回异常，链接可能无效或已过期");
  }
  return json;
}

/** 提取分享对话（入口） */
export async function extractShare(input: string): Promise<ShareExtractResult> {
  const shareId = parseShareId(input);
  if (!shareId) {
    return {
      ok: false,
      message: "无法识别的 DeepSeek 分享链接。格式：https://chat.deepseek.com/share/{id}（或直接粘贴 share id）",
    };
  }
  try {
    const raw = await fetchShareRaw(shareId);
    const biz = raw.data?.biz_data;
    const msgs = biz?.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      return { ok: false, message: "该分享链接没有可提取的对话内容" };
    }

    const messages: ShareMessage[] = msgs
      .map((m) => {
        const role: ShareMessage["role"] = (m.role ?? "").toLowerCase() === "user" ? "user" : "assistant";
        return {
          id: m.message_id ?? 0,
          role,
          content: (m.content ?? "").replace(/\r\n/g, "\n"),
          ...(m.thinking ? { thinking: m.thinking.replace(/\r\n/g, "\n") } : {}),
          ...(typeof m.inserted_at === "number" ? { time: new Date(m.inserted_at * 1000).toISOString() } : {}),
          ...(typeof m.accumulated_token_usage === "number" ? { tokenUsage: m.accumulated_token_usage } : {}),
        };
      })
      .filter((m) => m.content.length > 0 || m.thinking !== undefined);

    if (messages.length === 0) {
      return { ok: false, message: "该分享链接的消息内容为空" };
    }

    const lastTokens = messages[messages.length - 1].tokenUsage ?? 0;
    return {
      ok: true,
      title: biz?.title ?? "Shared Conversation",
      shareId,
      url: `https://${SHARE_HOST}/share/${shareId}`,
      messages,
      totalTokens: lastTokens,
      count: messages.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 区分"找不到分享"（404/空数据）与其它错误
    if (/404|not found|无效|过期/i.test(msg)) {
      return { ok: false, message: `未找到该分享（可能已被删除或链接有误）：${msg}` };
    }
    return { ok: false, message: msg };
  }
}
