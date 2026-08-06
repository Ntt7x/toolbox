// ============================================================
// features/zhihuCrawler 单测：纯函数（urlToken 解析、HTML→Markdown）
// 不触网（知乎风控/需要登录态，真实抓取留待用户 cookie 后验收）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrlToken, htmlToMarkdown } from "./service.js";

test("extractUrlToken：从主页 URL / 列表页 URL / 裸 token 解析", () => {
  assert.equal(extractUrlToken("https://www.zhihu.com/people/zhihu"), "zhihu");
  assert.equal(extractUrlToken("https://www.zhihu.com/people/zhihu/answers"), "zhihu");
  assert.equal(extractUrlToken("https://www.zhihu.com/people/some-user_123/answers?page=2"), "some-user_123");
  assert.equal(extractUrlToken("zhihu"), "zhihu");
  assert.equal(extractUrlToken(""), "");
  assert.equal(extractUrlToken("https://www.zhihu.com/question/123"), "");
});

test("htmlToMarkdown：剥离标签、保留结构（标题/列表/链接/代码）", () => {
  const html =
    '<p>第一段</p><h2>小标题</h2><ul><li>项一</li><li>项二</li></ul>' +
    '<a href="https://example.com">链接文字</a><pre><code>const a = 1;</code></pre>';
  const md = htmlToMarkdown(html);
  assert.ok(md.includes("第一段"), "应保留正文");
  assert.ok(md.includes("## 小标题"), "标题转 markdown");
  assert.ok(md.includes("- 项一"), "列表项转 - ");
  assert.ok(md.includes("[链接文字](https://example.com)"), "链接转 markdown");
  assert.ok(md.includes("```"), "代码块保留");
  assert.ok(md.includes("const a = 1;"), "代码内容保留");
  assert.ok(!md.includes("<"), "不应残留 HTML 标签");
});

test("htmlToMarkdown：空输入与无标签输入", () => {
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown("纯文本内容"), "纯文本内容");
});
