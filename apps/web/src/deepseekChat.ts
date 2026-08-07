// 公共前端工具：一键「去 Chat」——服务端 playwright 打开 DeepSeek Chat
// 自动打开浏览器、开启深度思考+智能搜索、填入提示词、自动发送（browserChat feature）
import { api } from "./api";

/** 一键去 Chat（自动打开 + 填入 + 发送）。返回给用户的提示消息（成功/失败均返回中文说明）。 */
export async function openDeepSeekChat(prompt: string): Promise<string> {
  const r = await api.chatBrowserOpen(prompt, { send: true, deepThink: true, search: true });
  if (!r.ok) return `❌ ${r.message ?? "打开失败"}`;
  return r.message ?? "✅ 已打开浏览器";
}
