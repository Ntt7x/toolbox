// 文本匹配原子能力（精准/模糊）单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { findHits, matchText, mergeHits, normalizeText, parseWordList, textSimilarity } from "./newsText.js";

test("normalizeText：全角转半角 + 大小写折叠 + 空白折叠", () => {
  assert.equal(normalizeText("ＣＰＩ"), "cpi");
  assert.equal(normalizeText("Fed  Rate"), "fed rate");
  assert.equal(normalizeText("降息\n预期"), "降息 预期");
});

test("parseWordList：多分隔符解析 + 去重 + 保留短语内部空格", () => {
  assert.deepEqual(parseWordList("降息,加息、CPI；fed rate\n降息"), ["降息", "加息", "CPI", "fed rate"]);
  assert.deepEqual(parseWordList(["a", "b"]), ["a", "b"]);
});

test("textSimilarity：完全一致=1；错 1 字按比例；超过 maxEdits 判 0", () => {
  assert.equal(textSimilarity("降息预期", "降息预期"), 1);
  assert.ok(textSimilarity("降息预其", "降息预期") > 0.7);
  assert.equal(textSimilarity("降息预期", "降息预其其其", 1), 0);
});

test("exact：中文子串命中 + 全角关键词可命中半角文本", () => {
  assert.equal(matchText("央行宣布降准 0.5 个百分点", ["降准"]), true);
  assert.equal(matchText("CPI 同比上涨", ["ＣＰＩ"]), true);
  assert.equal(matchText("银行板块走强", ["降准"]), false);
});

test("exact + wholeWord：fed 不命中 federal，CJK 无边界要求", () => {
  assert.equal(matchText("federal reserve", ["fed"], "exact", { wholeWord: true }), false);
  assert.equal(matchText("fed raises rates", ["fed"], "exact", { wholeWord: true }), true);
  assert.equal(matchText("美联储议息", ["美联储"], "exact", { wholeWord: true }), true);
});

test("fuzzy：容忍错字/缺字；≤2 字词不允许编辑（防误命中）", () => {
  assert.equal(matchText("市场预期央行降息预其升温", ["降息预期"], "fuzzy"), true);
  assert.equal(matchText("央行开展逆回构操作", ["逆回购"], "fuzzy"), true);
  assert.equal(matchText("央行开展公开市场操作", ["降息"], "fuzzy"), false);
  assert.equal(matchText("房地产市场回暖，销售面积同比转正", ["逆回购"], "fuzzy"), false);
});

test("findHits：命中区间可回映原文（切片 = 原文片段），多命中按序不重叠", () => {
  const text = "央行降准，市场关注通胀与降准节奏";
  const hits = findHits(text, ["降准", "通胀"]);
  assert.equal(hits.length, 3);
  for (const h of hits) assert.equal(text.slice(h.start, h.end), h.text);
  assert.deepEqual(hits.map((h) => [h.start, h.text]), [[2, "降准"], [9, "通胀"], [12, "降准"]]);
  // 区间互不重叠且升序
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.start >= hits[i - 1]!.end);
});

test("mergeHits：重叠区间保留相似度更高者", () => {
  const merged = mergeHits([
    { start: 0, end: 4, text: "aaaa", word: "a", score: 0.8 },
    { start: 2, end: 8, text: "bbbbbb", word: "b", score: 0.95 },
    { start: 10, end: 12, text: "cc", word: "c", score: 1 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.word, "b");
  assert.equal(merged[1]!.word, "c");
});

test("findHits：空文本/空词返回空；fuzzy 阈值可收紧", () => {
  assert.deepEqual(findHits("", ["降息"]), []);
  assert.deepEqual(findHits("降息", [""]), []);
  assert.equal(matchText("降息预其", ["降息预期"], "fuzzy", { threshold: 0.99 }), false);
});
