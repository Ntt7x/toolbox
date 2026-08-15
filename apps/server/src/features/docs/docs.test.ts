// ============================================================
// 文档中心单测（Cordis 框架：服务注册 + 业务规则 + 文件系统）
// 运行：node scripts/dev-utils/test.mjs docs
// ⚠️ 数据安全：beforeEach 备份 / afterEach 恢复 docs KV（教训见 domains/cordis.md §5）
// ============================================================
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { kvGet, kvSet } from "../../core/kvStore.js";
import { chatToMarkdown } from "./services.js";
import {
  DOCS_CONTENT_PREFIX, DOCS_FOLDERS_KEY, DOCS_META_KEY, DOCS_FILE_DIR,
  DocStoreService, DocFileService, DocIndexService, DocImportService,
} from "./services.js";

let backup: Record<string, unknown> = {};
beforeEach(() => {
  backup = {
    folders: kvGet(DOCS_FOLDERS_KEY) ?? { items: [] },
    meta: kvGet(DOCS_META_KEY) ?? { items: [] },
  };
});
afterEach(() => {
  kvSet(DOCS_FOLDERS_KEY, backup.folders);
  kvSet(DOCS_META_KEY, backup.meta);
  // 清理测试期间写入的 md 内容 + pdf 文件
  const fileDir = path.join(path.resolve(process.cwd()), DOCS_FILE_DIR);
  if (fs.existsSync(fileDir)) {
    for (const f of fs.readdirSync(fileDir)) {
      try { fs.rmSync(path.join(fileDir, f), { force: true }); } catch { /* ignore */ }
    }
  }
});

async function makeCtx(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(DocStoreService as any);
  await ctx.plugin(DocFileService as any);
  await ctx.plugin(DocIndexService as any);
  await ctx.plugin(DocImportService as any);
  return ctx;
}

test("Cordis 服务注册：docStore/docFile/docIndex/docImport 可访问 + DocFile 目录初始化", async () => {
  const ctx = await makeCtx();
  assert.ok(ctx.docStore instanceof DocStoreService);
  assert.ok(ctx.docFile instanceof DocFileService);
  assert.ok(ctx.docIndex instanceof DocIndexService);
  assert.ok(ctx.docImport instanceof DocImportService);
  // DocFile 构造 effect 初始化目录
  const dir = ctx.docFile.fileDir();
  assert.ok(fs.existsSync(dir), "pdf 目录已初始化");
  // 服务间依赖：index 消费 store
  assert.deepEqual(ctx.docIndex.listTags(), []);
});

test("文档 CRUD：文件夹树 + md 内容 + tag 聚合", async () => {
  const ctx = await makeCtx();
  const store = ctx.docStore;
  // 文件夹树
  const f1 = store.createFolder("父").find((x) => x.name === "父")!;
  const f2 = store.createFolder("子", f1.id).find((x) => x.name === "子")!;
  assert.equal(f2.parentId, f1.id);
  // md 文档
  const item = store.createItem({ name: "笔记.md", type: "md", folderId: f1.id, tags: ["测试"], content: "# 标题", size: 6 });
  assert.ok(item);
  assert.equal(store.getContent(item.id), "# 标题");
  // tag 聚合
  const tags = ctx.docIndex.listTags();
  assert.equal(tags.length, 1);
  assert.equal(tags[0].name, "测试");
  // 过滤
  const filtered = ctx.docIndex.filter(store.listItems(), { folderId: f1.id });
  assert.equal(filtered.length, 1);
  // 更新
  store.updateItem(item.id, { tags: ["测试", "重要"] });
  assert.ok(store.getItem(item.id)!.tags.includes("重要"));
  // 删除（软删：内容保留供回收站恢复；purgeItem 才真删）
  store.deleteItem(item.id);
  assert.equal(ctx.docStore.getContent(item.id), "# 标题", "软删保留内容");
});

test("DocFileService：pdf 写入/读取/删除（存储后端抽象）", async () => {
  const ctx = await makeCtx();
  const file = ctx.docFile;
  file.writePdf("t1", Buffer.from("%PDF-test"));
  assert.ok(file.readPdf("t1")?.length === 9);
  file.deletePdf("t1");
  assert.equal(file.readPdf("t1"), null);
});

test("DocImportService：multipart 上传解析（md 进 KV）", async () => {
  const ctx = await makeCtx();
  const form = new FormData();
  form.append("files", new File(["# 导入内容"], "导入.md", { type: "text/markdown" }));
  const r = await ctx.docImport.uploadParse(form, { tags: ["导入"] });
  assert.equal(r.created.length, 1);
  assert.equal(r.errors.length, 0);
  const item = ctx.docStore.listItems().find((x) => x.name === "导入.md");
  assert.ok(item && item.tags.includes("导入"));
  assert.equal(ctx.docStore.getContent(item.id), "# 导入内容");
});
test("回收站：软删/恢复/彻底删除 + 文件夹级联 + 移动环拒绝", async () => {
  const ctx = await makeCtx();
  const store = ctx.docStore;
  // 文件夹树 + 文档
  const f1 = store.createFolder("回收站父").find((x) => x.name === "回收站父")!;
  const f2 = store.createFolder("回收站子", f1.id).find((x) => x.name === "回收站子")!;
  const it = store.createItem({ name: "回收站笔记.md", type: "md", folderId: f2.id, content: "# x", size: 3 })!;
  // 软删文档
  store.deleteItem(it.id);
  assert.ok(!store.listItems().some((x) => x.id === it.id), "正常列表无");
  assert.ok(store.listTrash().items.some((x) => x.id === it.id), "回收站有");
  // 恢复
  store.restoreItem(it.id);
  assert.ok(store.listItems().some((x) => x.id === it.id), "恢复后正常列表有");
  // 软删文件夹（级联）
  store.deleteFolder(f1.id);
  assert.ok(!store.listFolders().some((x) => x.id === f1.id || x.id === f2.id), "文件夹级联进回收站");
  assert.ok(!store.listItems().some((x) => x.id === it.id), "其中文档进回收站");
  assert.ok(store.listTrash().folders.length === 2 && store.listTrash().items.length === 1, "回收站含 2 文件夹 + 1 文档");
  // 整树恢复
  store.restoreFolder(f1.id);
  assert.ok(store.listFolders().some((x) => x.id === f1.id) && store.listFolders().some((x) => x.id === f2.id), "整树恢复");
  assert.ok(store.listItems().some((x) => x.id === it.id), "文档恢复");
  // 文件夹移动 + 环拒绝
  store.moveFolder(f2.id, null);   // f2 移到根
  assert.equal(store.listFolders().find((x) => x.id === f2.id)!.parentId, undefined, "移到根");
  store.moveFolder(f2.id, f1.id);  // f2 移回 f1
  store.moveFolder(f1.id, f2.id);  // 尝试移入子孙 → 拒绝
  assert.equal(store.listFolders().find((x) => x.id === f1.id)!.parentId, undefined, "环拒绝");
  // 彻底删除
  store.purgeItem(it.id);
  assert.ok(!store.listItems("all").some((x) => x.id === it.id), "彻底删除");
  store.purgeFolder(f1.id);
  // 数据独立断言：只验证「本测试创建的文件夹树已彻底删除」（真实用户数据共存时 length 不为 0，2026-08-16 修正）
  assert.ok(!store.listFolders("all").some((x) => x.id === f1.id || x.id === f2.id), "彻底删除文件夹整树");
});

test("chatToMarkdown：对话 → md（标题 + 来源 + 消息 + 思考折叠）", () => {
  const md = chatToMarkdown("测试对话", "https://chat.deepseek.com/share/abc", [
    { id: 1, role: "user", content: "你好" },
    { id: 2, role: "assistant", content: "你好！有什么可以帮你？", thinking: "用户问好，礼貌回应" },
  ]);
  assert.ok(md.includes("# 测试对话"), "标题");
  assert.ok(md.includes("来源：DeepSeek Chat 分享"), "来源行");
  assert.ok(md.includes("## 🧑 用户") && md.includes("## 🤖 助手"), "角色徽标");
  assert.ok(md.includes("<details>") && md.includes("🧠 思考过程"), "思考折叠");
  assert.ok(md.includes("你好！有什么可以帮你？"), "正文保留");
});
