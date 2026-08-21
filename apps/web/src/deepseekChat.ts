// 公共前端工具：一键「去 Chat」——服务端 playwright 打开 DeepSeek Chat
// 自动打开浏览器、开启深度思考+智能搜索、填入提示词、自动发送（browserChat feature）
import { api } from "./api";

// 防抖：连续点击多次「去 Chat」时，只处理第一次，后续提示等待（避免重复开窗口/重复调用，2026-08-19）
let opening = false;

/** 一键去 Chat（自动打开 + 填入 + 发送）。返回给用户的提示消息（成功/失败均返回中文说明）。 */
export async function openDeepSeekChat(prompt: string): Promise<string> {
  if (opening) return "⏳ 正在打开 DeepSeek Chat（上一次还在处理中），请稍候…";
  opening = true;
  try {
    const r = await api.chatBrowserOpen(prompt, { send: true, deepThink: true, search: true });
    if (!r.ok) return `❌ ${r.message ?? "打开失败"}`;
    return r.message ?? "✅ 已打开浏览器";
  } finally {
    opening = false;
  }
}
