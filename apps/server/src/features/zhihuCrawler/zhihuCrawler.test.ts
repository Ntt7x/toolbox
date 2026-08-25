// ============================================================
// features/zhihuCrawler 单测：纯函数（urlToken 解析、HTML→Markdown）
// 不触网（知乎风控/需要登录态，真实抓取留待用户 cookie 后验收）
// ============================================================
import { test } from "node:test";
import { deriveZhihuStats } from "./index.js";
import assert from "node:assert/strict";
import { extractUrlToken, htmlToMarkdown, parseZhihuComment, parseZhihuTarget } from "./service.js";

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

test("parseZhihuComment：作者自己的评论保留", () => {
  const c = { id: 1, content: "<p>作者评论</p>", created_time: 1700000000, author: { url_token: "target", name: "目标用户" } };
  const r = parseZhihuComment(c, "target");
  assert.ok(r);
  assert.equal(r!.author, "目标用户");
  assert.equal(r!.content, "作者评论");
});

test("parseZhihuComment：作者回复的评论保留（reply_author_tag 标注上下文）", () => {
  const c = {
    id: 2,
    content: "<p>路人回复</p>",
    author: { url_token: "someone", name: "路人" },
    reply_author_tag: "target",
  };
  const r = parseZhihuComment(c, "target");
  assert.ok(r, "作者被回复 → 该评论是作者参与讨论的上下文");
  assert.equal(r!.replyTo, "target");
});

test("parseZhihuComment：内容作者标记（is_author）保留", () => {
  const c = { id: 6, content: "作者补充评论", author: { url_token: "someone", name: "路人" }, is_author: true };
  const r = parseZhihuComment(c, "target");
  assert.ok(r, "is_author 标记的内容作者评论应保留（即使 url_token 不匹配）");
});

test("parseZhihuComment：与作者无关的评论返回 null", () => {
  const c = { id: 3, content: "路人闲聊", author: { url_token: "a", name: "A" }, reply_to_author: { url_token: "b", name: "B" } };
  assert.equal(parseZhihuComment(c, "target"), null);
});

test("parseZhihuComment：子评论含作者 → 保留父子上下文", () => {
  const c = {
    id: 4,
    content: "路人评论",
    author: { url_token: "a", name: "A" },
    child_comments: [{ id: 5, content: "作者回复", author: { url_token: "target", name: "目标用户" } }],
  };
  const r = parseZhihuComment(c, "target");
  assert.ok(r, "子评论含作者 → 父评论保留为上下文");
  assert.equal(r!.children?.length, 1);
  assert.equal(r!.children![0].author, "目标用户");
});

test("parseZhihuTarget：识别用户/问题/回答/文章/想法链接", () => {
  assert.deepEqual(parseZhihuTarget("https://www.zhihu.com/people/zhihu").kind, "user");
  assert.equal(parseZhihuTarget("https://www.zhihu.com/people/zhihu").ref, "zhihu");
  assert.deepEqual(parseZhihuTarget("https://www.zhihu.com/question/123456").kind, "question");
  assert.equal(parseZhihuTarget("https://www.zhihu.com/question/123456").ref, "123456");
  assert.deepEqual(parseZhihuTarget("https://www.zhihu.com/question/123/answer/456").kind, "answer");
  assert.equal(parseZhihuTarget("https://www.zhihu.com/question/123/answer/456").ref, "456");
  assert.deepEqual(parseZhihuTarget("https://www.zhihu.com/p/abcdef").kind, "article");
  assert.deepEqual(parseZhihuTarget("https://www.zhihu.com/pin/123").kind, "pin");
});

test("parseZhihuTarget：从分享文本中自动提取链接", () => {
  const text = "看看这个：https://www.zhihu.com/question/999 很有意思，顺便推荐 https://www.zhihu.com/question/888";
  const r = parseZhihuTarget(text);
  assert.equal(r.kind, "question");
  assert.equal(r.ref, "999");
});

test("parseZhihuTarget：裸 token 视为用户；无法识别返回 unknown", () => {
  assert.equal(parseZhihuTarget("zhihu").kind, "user");
  assert.equal(parseZhihuTarget("随便一段没有链接的文字").kind, "unknown");
});

test("parseZhihuTarget：zhuanlan 专栏文章链接（含分享文本）识别为 article 且保留专栏域", () => {
  const text = "Python 处理 API 的十个实用技巧：把脚本从能跑升级到好用 - deephub的文章 - 知乎 https://zhuanlan.zhihu.com/p/2068818795909666748";
  const r = parseZhihuTarget(text);
  assert.equal(r.kind, "article");
  assert.equal(r.ref, "2068818795909666748");
  assert.equal(r.url, "https://zhuanlan.zhihu.com/p/2068818795909666748");
  const r2 = parseZhihuTarget("https://zhuanlan.zhihu.com/p/123456");
  assert.equal(r2.kind, "article");
  assert.equal(r2.url, "https://zhuanlan.zhihu.com/p/123456");
});

test("deriveZhihuStats：类型分布/平均长度/日期范围聚合", () => {
  const items = [
    { kind: "answer", content: "答一答一", createdAt: "2026-08-01T00:00:00Z", url: "u1", title: "t1" },
    { kind: "answer", content: "答二答二答二", createdAt: "2026-08-02T00:00:00Z", url: "u2", title: "t2" },
    { kind: "pin", content: "想法一", createdAt: "2026-08-03T00:00:00Z", url: "u3", title: "t3" },
  ] as any;
  const st = deriveZhihuStats(items);
  assert.equal(st.total, 3);
  assert.deepEqual(st.byKind, { answer: 2, pin: 1 });
  assert.equal(st.avgContentLen, 4); // (4+6+3)/3 ≈ 4
  assert.deepEqual(st.dateRange, { from: "2026-08-01", to: "2026-08-03" });
});

test("deriveZhihuStats：空列表", () => {
  const st = deriveZhihuStats([]);
  assert.equal(st.total, 0);
  assert.deepEqual(st.byKind, {});
  assert.equal(st.avgContentLen, 0);
  assert.equal(st.dateRange, undefined);
});
