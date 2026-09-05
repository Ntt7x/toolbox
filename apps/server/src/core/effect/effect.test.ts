// core/effect 单测：并发编排 / HTTP 重试与超时 / 中断 / 运行时与错误文案
// 网络部分用本地 http 服务，不依赖外网（可离线跑）。

import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import { Data, Duration, Effect } from "effect";
import { allOrdered, allSettled } from "./concurrency.js";
import { requestText } from "./http.js";
import {
  HttpStatusError,
  ParseError,
  SourceUnavailableError,
  TimeoutError,
  TransportError,
  describeError,
  isRetryable,
  type FetchError,
} from "./errors.js";
import { EffectFailure, interruptOn, runEffect, runEffectOrMessage } from "./runtime.js";

// ---------- 本地测试服务 ----------
interface Hit {
  path: string;
  at: number;
}
const hits: Hit[] = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  hits.push({ path: url, at: Date.now() });
  if (url.startsWith("/ok")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
    return;
  }
  if (url.startsWith("/slow")) {
    // 永不响应：用于验证超时是真中断
    return;
  }
  if (url.startsWith("/boom")) {
    res.writeHead(500);
    res.end("server error");
    return;
  }
  if (url.startsWith("/json-bad")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{ not json");
    return;
  }
  res.writeHead(404);
  res.end("nope");
});
after(() => {
  server.close();
});
const baseUrl = (): string => {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("测试服务未监听");
  return `http://127.0.0.1:${addr.port}`;
};

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

// ---------- 并发编排 ----------

test("allOrdered：结果与入参严格同序，且并发度受限", async () => {
  let running = 0;
  let peak = 0;
  const out = await runEffect(
    allOrdered([1, 2, 3, 4, 5, 6], 2, (n) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          running += 1;
          peak = Math.max(peak, running);
        });
        const v = yield* Effect.promise(() => new Promise<number>((r) => setTimeout(() => r(n * 10), 10 - n)));
        yield* Effect.sync(() => {
          running -= 1;
        });
        return v;
      }),
    ),
  );
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.ok(peak <= 2, `并发峰值应 ≤2，实际 ${peak}`);
});

test("allOrdered：任一失败即整体失败，且兄弟任务被中断（结构化并发）", async () => {
  // 注意：Effect 的 TaggedError 在负载类型为 {} 时构造器入参是 void（new Boom()，不传 {}）
  class Boom extends Data.TaggedError("Boom")<{}> {}
  let interrupted = false;
  const slow: Effect.Effect<void, Boom> = Effect.onInterrupt(Effect.sleep(Duration.seconds(5)), () =>
    Effect.sync(() => {
      interrupted = true;
    }),
  );
  const boom: Effect.Effect<void, Boom> = Effect.fail(new Boom());
  const started = Date.now();
  await assert.rejects(runEffect(allOrdered([1, 2], 2, (n) => (n === 1 ? slow : boom))));
  assert.ok(interrupted, "失败应中断仍在跑的兄弟任务（裸 Promise.all 会让它跑满 5s）");
  assert.ok(Date.now() - started < 3000, "应快速失败，不等兄弟任务跑完");
});

test("allSettled：单项失败不拖垮整批，失败项转成 note", async () => {
  class Miss extends Data.TaggedError("Miss")<{ code: string }> {}
  const r = await runEffect(
    allSettled(["a", "b", "c"], 3, (code) =>
      code === "b" ? Effect.fail(new Miss({ code })) : Effect.succeed(code.toUpperCase()),
    (item) => `${item} 取数失败`),
  );
  assert.deepEqual(r.ok, ["A", "C"]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0]?.item, "b");
  assert.equal(r.failed[0]?.note, "b 取数失败");
});

// ---------- HTTP：重试 / 超时 / 状态 / 解析 ----------

test("requestText：成功取文本", async () => {
  const text = await runEffect(requestText({ url: `${baseUrl()}/ok` }));
  assert.equal(text, "hello");
});

test("requestText：5xx 按指数退避重试 2 次（共 3 次尝试）", async () => {
  hits.length = 0;
  await assert.rejects(runEffect(requestText({ url: `${baseUrl()}/boom`, retries: 2, retryBaseMs: 10 })));
  assert.equal(hits.length, 3, `期望 1 次 + 2 次重试，实际 ${hits.length}`);
});

test("requestText：4xx 不重试（重试无意义，只会放大延迟）", async () => {
  hits.length = 0;
  await assert.rejects(runEffect(requestText({ url: `${baseUrl()}/missing`, retries: 2, retryBaseMs: 10 })));
  assert.equal(hits.length, 1);
});

test("requestText：超时是真中断（不会等到底层连接自然超时）", async () => {
  const started = Date.now();
  await assert.rejects(runEffect(requestText({ url: `${baseUrl()}/slow`, timeoutMs: 200, retries: 0 })), (e) => {
    assert.ok(e instanceof EffectFailure);
    assert.ok(e.failure instanceof TimeoutError, `期望 TimeoutError，实际 ${String(e.failure)}`);
    return true;
  });
  assert.ok(Date.now() - started < 3000, "应在超时后立刻失败");
});

test("requestJson 的解析失败 → ParseError（不静默返回 undefined）", async () => {
  const r = await runEffectOrMessage(requestJsonBroken());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /解析失败/);
});

function requestJsonBroken(): Effect.Effect<unknown, FetchError> {
  return Effect.flatMap(requestText({ url: `${baseUrl()}/json-bad`, retries: 0 }), (text) =>
    Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => new ParseError({ source: "json-bad", reason: e instanceof Error ? e.message : String(e) }),
    }),
  );
}

// ---------- 错误文案与重试判定 ----------

test("describeError：一处收口中文文案", () => {
  assert.equal(describeError(new TimeoutError({ url: "u", ms: 8000 })), "数据源响应超时（超过 8000ms）");
  assert.equal(describeError(new Error("x")), "x");
  assert.equal(describeError("oops"), "oops");
});

test("isRetryable：仅超时/网络/5xx/429 重试，4xx 与解析失败不重试", () => {
  const cases: [FetchError, boolean][] = [
    [new TimeoutError({ url: "u", ms: 1 }), true],
    [new TransportError({ url: "u", reason: "ECONNRESET" }), true],
    [new HttpStatusError({ url: "u", status: 500 }), true],
    [new HttpStatusError({ url: "u", status: 429 }), true],
    [new HttpStatusError({ url: "u", status: 404 }), false],
    [new HttpStatusError({ url: "u", status: 400 }), false],
    [new ParseError({ source: "u", reason: "bad" }), false],
    [new SourceUnavailableError({ source: "u", attempts: ["a"] }), false],
  ];
  for (const [e, want] of cases) assert.equal(isRetryable(e), want, `${e._tag} 重试判定不符`);
});

// ---------- 运行时 ----------

test("runEffect：失败抛 EffectFailure，message 为可读文案", async () => {
  class NotFound extends Data.TaggedError("NotFound")<{ what: string }> {}
  await assert.rejects(runEffect(Effect.fail(new NotFound({ what: "标的" }))), (e: unknown) => {
    assert.ok(e instanceof EffectFailure);
    assert.equal(e.name, "EffectFailure");
    return true;
  });
});

test("runEffectOrMessage：旁路取数失败降级为文案，不抛", async () => {
  const r = await runEffectOrMessage(Effect.fail(new TimeoutError({ url: "u", ms: 100 })));
  assert.deepEqual(r, { ok: false, message: "数据源响应超时（超过 100ms）" });
});

test("interruptOn：外部信号触发 → Effect 被中断", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(runEffect(interruptOn(ac.signal)(Effect.sleep(Duration.seconds(10)))));
});
