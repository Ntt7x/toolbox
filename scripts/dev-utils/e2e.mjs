// ============================================================
// 开发辅助脚本：API E2E 断言脚手架（scripts/dev-utils/e2e.mjs）
// 反复需求固化：集成验证 = 一串「调用 API + 断言状态/结果」。
// 用法：脚本内 import { call } 与 e2e，声明用例后 run：
//   import { call } from "./api.mjs";
//   import { e2e } from "./e2e.mjs";
//   e2e("策略仓位管理", [
//     { name: "新建策略", run: async () => { const r = await call("/strategies", "POST", { name }); assert(r.status === 200 && r.data.ok); return r.data.strategy.id; } },
//   ]);
// 输出：每个用例 ✅/❌ + 统计；失败 process.exit(1)。
// ============================================================
import assert from "node:assert/strict";

/**
 * 运行一组 E2E 用例。用例 run 返回任意值（可作后续用例输入）；失败捕获并打印。
 * @param {string} suiteName
 * @param {{name: string, run: () => Promise<any>}[]} cases
 */
export async function e2e(suiteName, cases) {
  let pass = 0;
  const ctx = {};
  console.log(`═══ ${suiteName} ═══`);
  for (const c of cases) {
    try {
      const out = await c.run(ctx);
      if (out !== undefined && out !== null) ctx[c.name] = out;
      console.log(`  ✅ ${c.name}`);
      pass += 1;
    } catch (e) {
      console.log(`  ❌ ${c.name}: ${e.message}`);
      console.log(`═══ ${suiteName} 失败（${pass}/${cases.length} 通过）═══`);
      process.exit(1);
    }
  }
  console.log(`═══ ${suiteName} 完成：${pass}/${cases.length} 全过 ═══`);
}

/** 断言工具（复用 node:assert/strict） */
export { assert };
