// ============================================================
// 知乎爬虫可靠性核心：限速（令牌桶）+ 分级退避（对抗风控）
// 设计要点：
//  - 令牌桶限速：全局共享（多任务/多类型间也限速），按域控 QPS，"人类频率"= 桶速率而非固定 sleep
//  - 分级退避：风控信号分类 → 不同停摆时长（40362=长停 / 403=短停+检查登录 / 429+超时=指数退避+抖动）
//  - 恢复：连续成功降级退避等级
// 纯逻辑模块（可单测），service.ts 集成调用
// ============================================================

export type BlockSignal = "40362" | "403" | "429" | "timeout";

export interface ZhihuRateLimitState {
  /** 令牌桶剩余（可立即执行数） */
  tokens: number;
  /** 速率（令牌/秒） */
  ratePerSec: number;
  /** 退避等级 0=正常 1=指数 2=短停 3=长停 */
  level: 0 | 1 | 2 | 3;
  /** 退避结束时间（ms） */
  backoffUntil: number;
  /** 连续成功数（用于降级） */
  consecutiveSuccess: number;
  /** 是否处于退避 */
  inBackoff: boolean;
}

/** 各风控信号对应的退避策略（毫秒） */
const BACKOFF_MS: Record<BlockSignal, number> = {
  "40362": 30 * 60 * 1000, // 限流 → 长停 30min
  "403": 5 * 60 * 1000,    // 指纹/cookie 异常 → 短停 5min
  "429": 2 * 60 * 1000,    // 频率过高 → 2min
  timeout: 60 * 1000,      // 超时 → 1min
};

/** 降级所需连续成功数 */
const SUCCESS_TO_DEGRADE = 5;

export class ZhihuRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private level: 0 | 1 | 2 | 3 = 0;
  private backoffUntil = 0;
  private consecutiveSuccess = 0;
  private totalBlocked = 0;

  private readonly ratePerSec: number;
  private readonly capacity: number;

  constructor(ratePerSec = 0.5, capacity = 2) {
    this.ratePerSec = ratePerSec; // 默认 0.5 令牌/秒（即 2 秒 1 次——人类浏览频率）
    this.capacity = capacity;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** 取令牌；不足则等待到有令牌（尊重退避期） */
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      // 退避中 → 分段等待（500ms 一段，reset/降级可及时生效）
      if (now < this.backoffUntil) {
        await sleep(Math.min(500, this.backoffUntil - now));
        continue;
      }
      // 补充令牌（按经过时间）
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // 无令牌 → 等待一个令牌的补充时间（+ 轻微抖动防同步）
      await sleep(Math.ceil(1000 / this.ratePerSec) + Math.floor(Math.random() * 300));
    }
  }

  /** 记录风控信号 → 升级退避等级并设停摆时间 */
  recordBlocked(signal: BlockSignal): void {
    this.totalBlocked += 1;
    this.consecutiveSuccess = 0;
    // 分级：40362 直接长停；403 短停；其余指数退避（多次触发逐级加时）
    if (signal === "40362") {
      this.level = 3;
    } else if (signal === "403") {
      this.level = (Math.max(this.level, 2) as 0 | 1 | 2 | 3);
    } else {
      // 429/timeout：指数退避（30s → 60s → 120s …），最高 2min 档
      const baseMs = BACKOFF_MS[signal];
      const exp = Math.min(this.level >= 1 ? this.level : 1, 3);
      const ms = Math.min(baseMs * Math.pow(2, exp - 1), 2 * 60 * 1000);
      this.level = this.level >= 1 ? (this.level === 3 ? 3 : ((this.level + 1) as 1 | 2 | 3)) : 1;
      this.backoffUntil = Date.now() + ms;
      return;
    }
    this.backoffUntil = Date.now() + BACKOFF_MS[signal];
  }

  /** 记录成功（用于降级：连续成功 N 次 → 降一级） */
  recordSuccess(): void {
    this.consecutiveSuccess += 1;
    if (this.consecutiveSuccess >= SUCCESS_TO_DEGRADE && this.level > 0) {
      this.level = (this.level - 1) as 0 | 1 | 2 | 3;
      this.consecutiveSuccess = 0;
    }
  }

  /** 手动重置（用户主动操作后） */
  reset(): void {
    this.level = 0;
    this.backoffUntil = 0;
    this.consecutiveSuccess = 0;
  }

  state(): ZhihuRateLimitState {
    this.refill(Date.now());
    return {
      tokens: this.tokens,
      ratePerSec: this.ratePerSec,
      level: this.level,
      backoffUntil: this.backoffUntil,
      consecutiveSuccess: this.consecutiveSuccess,
      inBackoff: Date.now() < this.backoffUntil,
    };
  }

  private refill(now: number): void {
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefill = now;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 全局共享限速器（所有爬虫操作共用——多任务间也限速，防自触风控） */
export const zhihuLimiter = new ZhihuRateLimiter();
