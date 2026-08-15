// ============================================================
// 文档中心：Cordis 插件（挂载四个服务到 Context）
// ============================================================
import type { Context } from "@deepseek-ai/cordis";
import { DocStoreService, DocFileService, DocIndexService, DocImportService } from "./services.js";

export const name = "docs-center";

export function apply(ctx: Context) {
  ctx.plugin(DocStoreService as any);
  ctx.plugin(DocFileService as any);
  ctx.plugin(DocIndexService as any);
  ctx.plugin(DocImportService as any);
}
