/**
 * Host half of kiru-progress-bar.
 *
 * 两件事：
 *   1. 自上次汇报起累计经过 `timeThresholdSeconds` 秒 → 提醒 Agent 汇报进度；
 *   2. 自上次汇报起累计 `stepThreshold` 步 → 提醒 Agent 汇报进度。
 *
 * 提醒不是弹窗，而是通过 post-execute 决策的 `additionalContexts` 注入一条
 * 合成 user 消息 —— 唯一能让模型真正「看见并照做」的通道。机制照抄
 * `@deepseek-ai/dsh-repeat-tool-reminder`（DSH 内置），见 DESIGN.md 第 2 节。
 *
 * 两个触发器共用一份计量：任一命中 → 发一次提醒 → 两者同时归零，
 * 否则「第 10 步刚提醒完、2 秒后时间阈值又到」会连击刷屏。
 *
 * ⚠️ 本文件**刻意不 import 任何 `@deepseek-ai/*` 包**。实测宿主不会为 profile
 * 安装的插件解析这些裸模块（挂载时报 `failed to import`），所以：
 *   - 不声明 `Config`，改成自带 `DEFAULTS` + 手工 fail-loud 校验；
 *   - 不用 `@deepseek-ai/dsh-llm` 的 `createUserMessage`，改成手写同形对象
 *     （DSH 的 `brandString` 是恒等函数，uuid 字符串可直接用）。
 * 只依赖 node 内建模块，插件因此可以在任何部署里加载。
 *
 * @module kiru-progress-bar
 */
import { randomUUID } from 'node:crypto'

export const name = 'progress-nudge'

/**
 * 行配置默认值。因为用不了 `@deepseek-ai/schemastery`，默认值与校验都在这里
 * 自己维护，行为等价：缺省补齐、非法 fail-loud。
 */
export const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 累计多少步提醒一次。 */
  stepThreshold: 10,
  /** 距上次汇报累计多少秒提醒一次。 */
  timeThresholdSeconds: 120,
  /** 两次提醒的最小间隔（秒），兜底的连击保护。 */
  minGapSeconds: 45,
  /** 单回合提醒次数上限，超过后静默。 */
  maxPerTurn: 20,
  /** 不计步、也不重置计数的工具（记录类、等用户的工具）。 */
  exclude: ['todo_write', 'ask_user_question'],
  /** 是否为 subagent 也计数并提醒。 */
  includeSubagents: false,
  /** Agent 主动对用户输出文本时，是否把计量归零（刚说过话就别再催）。 */
  resetOnSpeech: true,
  /** 提醒文案语言：zh | en。 */
  locale: 'zh',
  /**
   * 自适应退避（增强提醒）。
   *
   * 为什么需要：真机日志里发现，模型跑进「只调工具不说话」的模式后，
   * 提示频率再高也换不来一句汇报（某会话 487 次提醒里，末期合规率只有 31%）。
   * 此时**提高频率只会变成噪音**，正确做法是反过来：拉长间隔 + 加重措辞。
   * 一旦它真的汇报了，立刻复位。
   */
  escalation: {
    /** 是否启用。侧栏面板上的「增强提醒」开关控制的就是这一项。 */
    enabled: true,
    /** 连续多少次「提醒了但没换来文字」开始升级。 */
    afterNudges: 2,
    /** 每升一级，步数阈值乘以多少。 */
    stepFactor: 2,
    /** 每升一级，时间阈值乘以多少。 */
    timeFactor: 2,
    /** 最高升到第几级（0 表示不升）。 */
    maxLevel: 3,
  },
  /**
   * 余额监控。余额由**宿主的 `deepseekAccount` 服务**提供（设置页「账号与余额」
   * 显示的就是它），插件不直接碰任何 API key，也不关心中转站。
   */
  balance: {
    /** 是否开启余额监控。 */
    enabled: true,
    /** 低于这个金额就提醒。 */
    thresholdCny: 1.5,
    /**
     * 按哪个口径判定「低额」：
     * - `total`（默认）充值余额 + 赠送余额。平台扣款先从赠金扣，这才是"会不会用不了"。
     * - `recharge`   只看充值余额（赠金可能过期时这么用）。
     */
    scope: 'total',
    /** 多久查一次余额（秒）。 */
    checkSeconds: 300,
    /** 仍在阈值以下时，隔多久再提醒一次（秒）；0 表示只提醒一次。 */
    repeatSeconds: 1800,
    /** 顺带把余额写进进度汇报（仅在低于阈值时）。 */
    includeInReport: true,
  },
  /**
   * 峰谷时段指示。官方口径见文件上方「峰谷时段」注释。
   */
  tariff: {
    /** 是否显示。 */
    enabled: true,
    /**
     * 中国法定节假日（北京时间，`YYYY-MM-DD`）。官方口径里节假日全天按低谷计费，
     * 但节假日无法离线判断，只能手工列；留空就只按「周末 + 时段」算。
     */
    holidays: [],
  },
}

/** 消息来源标识。必须带插件自己的 kind，否则会被当成用户提示词污染历史。 */
const REMINDER_SOURCE = { kind: 'progress-nudge', form: 'notice' }

/** HTTP 前缀：页面面板与设置卡片走这里。 */
const API_PREFIX = '/progress-nudge/api'

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 最近工具名保留条数。 */
const RECENT_TOOLS_MAX = 8

// ---------------------------------------------------------------- 峰谷时段

/**
 * DeepSeek 官方峰谷计费（https://api-docs.deepseek.com/quick_start/pricing）：
 *
 * > Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and
 * > 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
 * > All other hours are off-peak, including weekends and Chinese public holidays in full.
 *
 * 换成北京时间正好是**工作日 09:00–12:00 与 14:00–18:00**（UTC+8），
 * 这里按北京时间定义，语义更直观，结果与官方 UTC 口径一致。
 */
const PEAK_WINDOWS_BEIJING = [
  [9, 12],
  [14, 18],
]

/** 北京时间相对 UTC 的偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 把某个时刻换算成「北京时间的墙上时间」。
 *
 * 做法是加 8 小时后一律用 `getUTC*` 读——这样**与运行机器的时区无关**，
 * 换台机器、换 TZ 环境变量，结果都一样。
 */
function beijingView(now) {
  return new Date(now + BEIJING_OFFSET_MS)
}

/** `2026-10-15` 形式的北京日期，用来比对节假日。 */
function beijingYmd(now) {
  const d = beijingView(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 北京时间的周几：0=周日。 */
function beijingWeekday(now) {
  return beijingView(now).getUTCDay()
}

/** 北京时间的「当天第几分钟」，便于和时段区间比大小。 */
function beijingMinuteOfDay(now) {
  const d = beijingView(now)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/**
 * 某个时刻处在高峰还是低谷。
 *
 * ⚠️ **中国法定节假日无法离线判断**，只能靠 `tariff.holidays` 手工列
 * （格式 `YYYY-MM-DD`，北京时间）。列表为空时按「只排除周末」处理——
 * 这是唯一诚实的做法，不能假装知道。
 *
 * 导出是为了让测试直接钉死时间计算（这段最容易出错）。
 */
export function tariffAt(now, holidays) {
  const day = beijingWeekday(now)
  if (day === 0 || day === 6) {
    return { offPeak: true, reason: 'weekend', peakWindow: null }
  }
  if (new Set(Array.isArray(holidays) ? holidays : []).has(beijingYmd(now))) {
    return { offPeak: true, reason: 'holiday', peakWindow: null }
  }
  const minute = beijingMinuteOfDay(now)
  for (const [startHour, endHour] of PEAK_WINDOWS_BEIJING) {
    if (minute >= startHour * 60 && minute < endHour * 60) {
      return { offPeak: false, reason: 'peak', peakWindow: [startHour, endHour] }
    }
  }
  return { offPeak: true, reason: 'off-hours', peakWindow: null }
}

/**
 * 下一次峰谷切换的时刻。
 *
 * 枚举未来 8 天里每个高峰窗口的起止当候选边界，取第一个「切换后状态与现在
 * 不同」的点——比按分钟轮询省事，也不会漏掉跨周末、跨节假日的情况。
 */
export function nextTariffSwitch(now, holidays) {
  const current = tariffAt(now, holidays).offPeak
  const dayMs = 24 * 60 * 60 * 1000
  // 以「北京时间的今天 0 点」为锚点
  const anchor = Math.floor((now + BEIJING_OFFSET_MS) / dayMs) * dayMs - BEIJING_OFFSET_MS
  const candidates = []
  for (let offset = 0; offset <= 8; offset += 1) {
    const dayStart = anchor + offset * dayMs
    for (const [startHour, endHour] of PEAK_WINDOWS_BEIJING) {
      candidates.push(dayStart + startHour * 3600_000)
      candidates.push(dayStart + endHour * 3600_000)
    }
  }
  candidates.sort((a, b) => a - b)
  for (const at of candidates) {
    if (at <= now) continue
    if (tariffAt(at, holidays).offPeak !== current) return { at, offPeak: !current }
  }
  return null
}

// ---------------------------------------------------------------- 文案

/** 把时间格式化成 `2026-10-12 12:27:33`，给模型看的时间必须无歧义。 */
function stamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  )
}

/** 星期几，中文用「周一」这种写法。 */
function weekday(date, locale) {
  const names = locale === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[date.getDay()]
}

const TEXT = {
  zh: {
    first: (v) =>
      `【进度汇报】现在是 ${v.now}（${v.weekday}）｜距上次汇报已累计 ${v.steps} 步 / ${v.seconds} 秒；` +
      `本回合起于 ${v.turnStart}，已跑 ${v.turnSeconds} 秒。\n` +
      `请用 2-3 句话向用户同步：① 已完成什么 ② 当前卡在哪、下一步做什么。\n` +
      `汇报完继续执行，不要停下来等回复。`,
    later: (v) =>
      `【进度汇报 · 第 ${v.count} 次】现在是 ${v.now}（${v.weekday}）｜` +
      `自上次汇报累计 ${v.steps} 步、${v.seconds} 秒；本回合起于 ${v.turnStart}，已跑 ${v.turnSeconds} 秒 / ${v.turnSteps} 步。\n` +
      `最近执行的工具：${v.tools}\n` +
      `请用 2-4 句话汇报：① 已完成并验证了什么 ② 正在做什么、卡点是什么 ③ 还差什么才算完成。\n` +
      `如果任务其实已经完成，直接收尾给结论。汇报完继续执行。`,
    time: (v) =>
      `【进度汇报 · 耗时提醒】现在是 ${v.now}（${v.weekday}）｜距上次汇报已过去 ${v.seconds} 秒（仅 ${v.steps} 步）；` +
      `本回合起于 ${v.turnStart}，已跑 ${v.turnSeconds} 秒。\n` +
      `若你正卡在一个很慢的操作上，说明它在做什么、预计还要多久；` +
      `若只是正常推进，一句话带过即可，然后继续。`,
    /**
     * 升级档文案（自适应退避）。
     *
     * 基线文案末尾那句「汇报完继续执行」等于给了模型一个跳过汇报的许可——
     * 真机日志里它就是这么跳过的。升级档把「必须先说话」写成硬要求，
     * 并且去掉任何可以理解为「继续干活就行」的措辞。
     */
    escalated: (v) =>
      v.level >= 2
        ? `【进度汇报 · 强制】现在是 ${v.now}（${v.weekday}）｜已连续 ${v.streak} 次没有向用户汇报，用户那边看不到任何进展` +
          `（本次累计 ${v.steps} 步 / ${v.seconds} 秒，本回合已跑 ${v.turnSeconds} 秒）。\n` +
          `硬性要求：调用下一个工具之前，先写 1-2 行文字说明【做完了什么 / 卡在哪 / 下一步】，然后再继续。\n` +
          `只调工具不说话 = 没完成这条要求。`
        : `【进度汇报 · 未响应】现在是 ${v.now}（${v.weekday}）｜你已经连续 ${v.streak} 次没有向用户汇报` +
          `（本次累计 ${v.steps} 步 / ${v.seconds} 秒，本回合已跑 ${v.turnSeconds} 秒）。\n` +
          `这一轮请**先输出 1-2 行文字**，再调用任何工具；只调工具不说话的，等于没汇报。`,
    /** 余额低于阈值时单独发的一条。 */
    balanceAlert: (v) =>
      `【余额不足】现在是 ${v.now}（${v.weekday}）｜${v.subjectText}，已低于你设定的 ${v.thresholdText}。\n` +
      (v.detailText ? `${v.detailText}\n` : '') +
      (v.topUpUrl ? `充值页：${v.topUpUrl}\n` : '') +
      `请用一两句话提醒用户充值，说明余额和阈值就行。提醒完继续当前工作，不要停下来等回复。`,
    /** 追加在进度汇报末尾的余额提示（仅在低于阈值时）。 */
    balanceLine: (v) =>
      `（${v.subjectText}${v.detailText ? `，${v.detailText}` : ''}，已低于阈值 ${v.thresholdText}）`,
    /**
     * 余额从「不足」回到「正常」时投递的一条。
     *
     * 缺了这条，模型会一直按「余额不足」的记忆行事——用户充完值还在被催充值。
     */
    balanceRecovered: (v) =>
      `【余额已恢复】现在是 ${v.now}（${v.weekday}）｜可用余额已回到 ${v.totalText}（${v.sourceText}），高于阈值 ${v.thresholdText}。\n` +
      `用户已经充值了。之前那条「余额不足」作废，不要再提、也不要再催充值；若刚才因此中断了什么，可以继续。`,
  },
  en: {
    first: (v) =>
      `[Progress check] It is now ${v.now} (${v.weekday}) — ${v.steps} steps / ${v.seconds}s since your last report; ` +
      `this turn started at ${v.turnStart} and has run ${v.turnSeconds}s.\n` +
      `Give the user a 2-3 sentence update: (1) what is done (2) where you are stuck and what is next.\n` +
      `Keep working after the update — do not stop and wait for a reply.`,
    later: (v) =>
      `[Progress check #${v.count}] It is now ${v.now} (${v.weekday}) — ` +
      `${v.steps} steps and ${v.seconds}s since the last report; this turn started at ${v.turnStart} ` +
      `and has run ${v.turnSeconds}s / ${v.turnSteps} steps.\n` +
      `Recent tools: ${v.tools}\n` +
      `Report in 2-4 sentences: (1) what is done and verified (2) what you are doing now and any blocker ` +
      `(3) what remains before the task is complete.\n` +
      `If the task is actually finished, wrap up with the conclusion instead. Keep working after the update.`,
    time: (v) =>
      `[Progress check · elapsed] It is now ${v.now} (${v.weekday}) — ${v.seconds}s have passed since the last report ` +
      `(only ${v.steps} steps); this turn started at ${v.turnStart} and has run ${v.turnSeconds}s.\n` +
      `If you are stuck on a slow operation, say what it is and how much longer it needs; ` +
      `if things are simply progressing, one line is enough, then continue.`,
    escalated: (v) =>
      v.level >= 2
        ? `[Progress check · MANDATORY] It is now ${v.now} (${v.weekday}) — ${v.streak} nudges in a row went unanswered; ` +
          `the user has no visibility into progress (${v.steps} steps / ${v.seconds}s, turn running ${v.turnSeconds}s).\n` +
          `Hard requirement: before calling the next tool, write 1-2 lines covering [what is done / where you are stuck / next step].\n` +
          `Calling a tool without that text counts as not done.`
        : `[Progress check · unanswered] It is now ${v.now} (${v.weekday}) — ${v.streak} nudges in a row went unanswered ` +
          `(${v.steps} steps / ${v.seconds}s, turn running ${v.turnSeconds}s).\n` +
          `This time, write 1-2 lines of text **before** calling any tool; tool calls without text do not count as a report.`,
    balanceAlert: (v) =>
      `[Low balance] It is now ${v.now} (${v.weekday}) — ${v.subjectText}, below your ${v.thresholdText} threshold.\n` +
      (v.detailText ? `${v.detailText}\n` : '') +
      (v.topUpUrl ? `Top-up page: ${v.topUpUrl}\n` : '') +
      `Tell the user to top up in one or two sentences, naming the balance and the threshold. ` +
      `Then keep working — do not stop and wait for a reply.`,
    balanceLine: (v) =>
      ` (${v.subjectText}${v.detailText ? `, ${v.detailText}` : ''}, below the ${v.thresholdText} threshold)`,
    balanceRecovered: (v) =>
      `[Balance restored] It is now ${v.now} (${v.weekday}) — the usable balance is back to ${v.totalText} ` +
      `(${v.sourceText}), above the ${v.thresholdText} threshold.\n` +
      `The user has topped up. Drop the earlier "low balance" note, stop asking them to top up, ` +
      `and continue anything that was interrupted.`,
  },
}

function template(locale) {
  return TEXT[locale] ?? TEXT.zh
}

// ---------------------------------------------------------------- 消息

/** 深冻结，避免下游误改已发布的消息。 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return Object.freeze(value)
}

/**
 * 构造一条 plugin 来源的合成 user 消息。
 *
 * 形状与 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 一致：
 * `{ id, role:'user', content, source }`（该实现见 DSH 内置的
 * repeat-tool-reminder：id 只是 `brandString(randomUUID())`，而
 * `brandString` 是恒等函数，所以普通 uuid 字符串完全等价）。
 *
 * `source.kind` 必须是插件自己的标识，否则会被渲染成用户提示词污染派生历史。
 */
function createNotice(text, summary) {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { ...REMINDER_SOURCE, summary },
    }),
  )
}

// ---------------------------------------------------------------- 校验

function validate(config) {
  const ints = [
    ['stepThreshold', 1],
    ['timeThresholdSeconds', 1],
    ['minGapSeconds', 0],
    ['maxPerTurn', 1],
  ]
  for (const [key, min] of ints) {
    const value = config[key]
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`progress-nudge: 非法配置 ${key}=${value} —— 必须是 >= ${min} 的整数`)
    }
  }
  if (config.stepThreshold < 1 && config.timeThresholdSeconds < 1) {
    throw new Error('progress-nudge: stepThreshold 与 timeThresholdSeconds 不能同时失效')
  }
  if (config.locale !== 'zh' && config.locale !== 'en') {
    throw new Error(`progress-nudge: 非法 locale=${config.locale} —— 只支持 zh | en`)
  }

  // 余额监控
  const b = config.balance
  if (b === null || typeof b !== 'object') {
    throw new Error('progress-nudge: 非法配置 balance —— 必须是对象')
  }
  if (typeof b.enabled !== 'boolean') {
    throw new Error(`progress-nudge: 非法配置 balance.enabled=${b.enabled} —— 必须是布尔值`)
  }
  if (typeof b.thresholdCny !== 'number' || !Number.isFinite(b.thresholdCny) || b.thresholdCny < 0) {
    throw new Error(`progress-nudge: 非法配置 balance.thresholdCny=${b.thresholdCny} —— 必须是 >= 0 的数字`)
  }
  for (const key of ['checkSeconds', 'repeatSeconds']) {
    const value = b[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`progress-nudge: 非法配置 balance.${key}=${value} —— 必须是 >= 0 的整数`)
    }
  }
  if (b.enabled && b.checkSeconds < 30) {
    throw new Error(`progress-nudge: balance.checkSeconds=${b.checkSeconds} 太小 —— 最少 30 秒，别把宿主余额接口打爆`)
  }
  if (b.scope !== 'total' && b.scope !== 'recharge') {
    throw new Error(`progress-nudge: 非法配置 balance.scope=${b.scope} —— 只支持 total | recharge`)
  }

  // 峰谷时段
  const tf = config.tariff
  if (tf === null || typeof tf !== 'object') {
    throw new Error('progress-nudge: 非法配置 tariff —— 必须是对象')
  }
  if (typeof tf.enabled !== 'boolean') {
    throw new Error(`progress-nudge: 非法配置 tariff.enabled=${tf.enabled} —— 必须是布尔值`)
  }
  if (!Array.isArray(tf.holidays)) {
    throw new Error('progress-nudge: 非法配置 tariff.holidays —— 必须是数组')
  }
  for (const day of tf.holidays) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error(`progress-nudge: 非法节假日 ${JSON.stringify(day)} —— 需要 YYYY-MM-DD（北京时间）`)
    }
  }

  // 自适应退避
  const esc = config.escalation
  if (esc === null || typeof esc !== 'object') {
    throw new Error('progress-nudge: 非法配置 escalation —— 必须是对象')
  }
  if (typeof esc.enabled !== 'boolean') {
    throw new Error(`progress-nudge: 非法配置 escalation.enabled=${esc.enabled} —— 必须是布尔值`)
  }
  if (!Number.isInteger(esc.afterNudges) || esc.afterNudges < 1) {
    throw new Error(`progress-nudge: 非法配置 escalation.afterNudges=${esc.afterNudges} —— 必须是 >= 1 的整数`)
  }
  if (!Number.isInteger(esc.maxLevel) || esc.maxLevel < 0 || esc.maxLevel > 10) {
    throw new Error(`progress-nudge: 非法配置 escalation.maxLevel=${esc.maxLevel} —— 必须是 0..10 的整数`)
  }
  for (const key of ['stepFactor', 'timeFactor']) {
    const value = esc[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      throw new Error(`progress-nudge: 非法配置 escalation.${key}=${value} —— 必须是 >= 1 的数字`)
    }
  }
}

// ---------------------------------------------------------------- 余额

/**
 * 查余额时要带的调用方身份。宿主用它决定返回文案的语言等。
 * @see AccountClientMetadata
 */
const ACCOUNT_CLIENT = {
  version: '0.1.0',
  locale: 'zh-CN',
  timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
}

/** `{ currency, balance }` → `¥9.48` / `$1.20`。宿主给的字符串精度很高，显示前收成两位。 */
function money(wallet) {
  const symbol = wallet.currency === 'USD' ? '$' : '¥'
  const value = Number(wallet.balance)
  const text = Number.isFinite(value) ? value.toFixed(2) : String(wallet.balance)
  return `${symbol}${text}`
}

// ---------------------------------------------------------------- HTTP helpers

function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 自定义前缀路由不在 harness 的 /api 信任栅栏后面，必须自己挡跨站请求。 */
function crossSiteRequest(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- 插件

export function apply(ctx, rowConfig) {
  // 没有平台 Config schema 兜底，缺省值在这里补齐，行配置只写部分字段也安全。
  // balance 是嵌套对象，必须单独浅合并一次，否则写一半会把另一半默认值弄丢。
  const config = {
    ...DEFAULTS,
    ...(rowConfig ?? {}),
    balance: { ...DEFAULTS.balance, ...(rowConfig?.balance ?? {}) },
    tariff: { ...DEFAULTS.tariff, ...(rowConfig?.tariff ?? {}) },
    escalation: { ...DEFAULTS.escalation, ...(rowConfig?.escalation ?? {}) },
  }
  validate(config)

  /** 运行时覆盖：页面上的即时调节，重启后回落到 config。 */
  const overrides = {}
  const effective = (key) => (key in overrides ? overrides[key] : config[key])

  /**
   * 每个 agent 一份计量。用 Map 而不是 WeakMap，因为「暂停」要能遍历所有 agent
   * 立刻停表；条目在 `agent/disposed` 时删除，不会泄漏。
   */
  const states = new Map()

  /** 给页面看的统计数据。 */
  const stats = { nudges: 0, resets: 0, spoke: 0, balanceAlerts: 0, balanceRecoveries: 0, escalatedNudges: 0 }

  // ---------------------------------------------------------------- 余额监控

  /**
   * 最近一次余额读数。`status`:
   * - `unknown`   还没查过
   * - `ok`        查到了
   * - `unavailable` 宿主没挂 `deepseekAccount` 服务（比如无头部署）
   * - `failed`    服务在，但查询失败（未登录 / 平台不可达）
   */
  let balanceState = { status: 'unknown', checkedAt: 0 }
  /** 上次向模型发余额提醒的时刻。 */
  let lastBalanceAlertAt = 0

  /** 最近一次余额提醒的详情，给界面显示用。 */
  let lastBalanceNotice = null

  /**
   * 上一次读数的「是否低额」。`null` = 还没有过有效读数（不知道），
   * 所以启动时读到低额不会被误判成「从正常掉下来」。
   */
  let lastLowSeen = null

  /** 检测到「低额 → 恢复」，攒着等下一个步骤边界投递。 */
  let pendingRecovery = null

  /** 最近一次恢复通知的详情，给界面显示用。 */
  let lastBalanceRecovery = null

  async function refreshBalance() {
    if (effective('balance').enabled !== true) return
    const account = ctx.get('deepseekAccount')
    if (account === undefined || typeof account.getBalance !== 'function') {
      balanceState = { status: 'unavailable', checkedAt: Date.now() }
      return
    }
    try {
      const outcome = await account.getBalance(ACCOUNT_CLIENT)
      if (outcome === null) {
        // 未登录，或查询过程中授权变了
        balanceState = { status: 'failed', reason: 'signed-out', checkedAt: Date.now() }
        return
      }
      if (outcome.status !== 'ready') {
        balanceState = { status: 'failed', reason: 'platform-error', checkedAt: Date.now() }
        return
      }
      // 充值钱包里挑 CNY；没有 CNY 就退回第一个，至少能显示点什么。
      const wallets = Array.isArray(outcome.value) ? outcome.value : []
      const cny = wallets.find((w) => w && w.currency === 'CNY') ?? wallets[0] ?? null
      // 赠送钱包可能不止一个（多次补偿/活动），CNY 的加在一起。
      // ⚠️ 平台扣款**先从赠金账户扣**，所以"会不会用不了"看的是总额而不是充值余额。
      const bonusWallets = Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : []
      const bonusCny = bonusWallets.filter((w) => w && w.currency === 'CNY')
      const bonusAmount = bonusCny.reduce((sum, w) => sum + (Number(w.balance) || 0), 0)
      const rechargeAmount = cny !== null && Number.isFinite(Number(cny.balance)) ? Number(cny.balance) : null
      const totalAmount = (rechargeAmount ?? 0) + bonusAmount
      let topUpUrl = ''
      try {
        const view = typeof account.getState === 'function' ? await account.getState() : null
        topUpUrl = view?.links?.topUpUrl ?? ''
      } catch {
        /* 拿不到充值链接不影响余额判断 */
      }
      const next = {
        status: 'ok',
        checkedAt: Date.now(),
        wallet: cny,
        /** 充值钱包 */
        text: cny !== null ? money(cny) : null,
        amount: rechargeAmount,
        /** 赠送钱包（CNY 合计） */
        bonusWallets,
        // 赠金为 0 时当成「没有赠金」：`赠送 ¥0.00` 只是噪音，不如不写。
        bonusText: bonusAmount > 0 ? `¥${bonusAmount.toFixed(2)}` : null,
        bonusAmount,
        /** 可用总额 = 充值 + 赠送 */
        totalText: `¥${totalAmount.toFixed(2)}`,
        totalAmount,
        topUpUrl,
      }
      // 先比较「上一次」和「这一次」的低额状态，再把新读数落地——
      // 顺序反了就拿不到翻转信息了。
      noteBalanceTransition(next)
      balanceState = next
    } catch (failure) {
      balanceState = { status: 'failed', reason: String(failure?.message ?? failure), checkedAt: Date.now() }
    }
  }

  /** 读数是不是新鲜（超过两个检查周期就算过期，宁可不报也不报旧数）。 */
  function balanceFresh() {
    const check = effective('balance').checkSeconds * 1000
    return balanceState.checkedAt > 0 && Date.now() - balanceState.checkedAt <= Math.max(check * 2, 60_000)
  }

  /**
   * 当前是否低于阈值。
   *
   * ⚠️ 默认按**可用总额**（充值 + 赠送）判定：平台扣款先从赠金扣，
   * 只看充值余额会在"赠金还有一大笔"时误报。
   * 想只看充值余额就把 `balance.scope` 设成 `recharge`。
   * 读数过期/失败/未登录都算"不知道"，不触发提醒。
   */
  function balanceLow() {
    if (effective('balance').enabled !== true) return false
    if (!balanceFresh()) return false
    return computeLow(balanceState, effective('balance')) === true
  }

  /**
   * 纯函数：给定一份读数判断是否低额。读不到返回 `null`（不知道）。
   * 单独抽出来，是为了能在读数落地**之前**比较新旧状态。
   */
  function computeLow(state, cfg) {
    if (state.status !== 'ok') return null
    const value = cfg.scope === 'recharge' ? state.amount : state.totalAmount
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return value <= cfg.thresholdCny
  }

  /**
   * 记录「低额 ↔ 正常」的状态翻转。
   *
   * 只报「变低」不够：用户充值后模型并不知道，还会继续按「余额不足」的记忆
   * 催人充值。所以「低额 → 恢复」也要留一条待投递的通知。
   */
  function noteBalanceTransition(next) {
    const nowLow = computeLow(next, effective('balance'))
    // 读不到就当没发生过，不要拿"不知道"去翻转状态
    if (nowLow === null) return
    if (lastLowSeen === true && nowLow === false) {
      pendingRecovery = {
        at: Date.now(),
        totalText: next.totalText,
        rechargeText: next.text,
        bonusText: next.bonusText,
      }
      // 恢复后清掉冷却：万一下次又掉下去，应该立刻提醒而不是等 repeatSeconds
      lastBalanceAlertAt = 0
    }
    lastLowSeen = nowLow
  }

  /**
   * 余额从「不足」回到「正常」时通知模型。
   * 和余额提醒一样，只能在步骤边界投递。
   */
  function balanceRecoveryNotice(now) {
    if (pendingRecovery === null) return undefined
    const b = effective('balance')
    if (b.enabled !== true) {
      pendingRecovery = null
      return undefined
    }
    const recovered = pendingRecovery
    pendingRecovery = null

    const locale = effective('locale')
    const t = template(locale)
    const nowDate = new Date(now)
    const sourceText = recovered.bonusText
      ? `充值 ${recovered.rechargeText ?? '—'} + 赠送 ${recovered.bonusText}`
      : `充值 ${recovered.rechargeText ?? '—'}`
    const values = {
      now: stamp(nowDate),
      weekday: weekday(nowDate, locale),
      totalText: recovered.totalText,
      sourceText,
      thresholdText: `¥${b.thresholdCny}`,
    }
    const text = t.balanceRecovered(values)
    stats.balanceRecoveries += 1
    lastBalanceRecovery = {
      seq: (lastBalanceRecovery?.seq ?? 0) + 1,
      at: now,
      totalText: recovered.totalText,
      threshold: b.thresholdCny,
      summary: `${recovered.totalText} > ¥${b.thresholdCny}`,
      message: text,
    }
    return createNotice(text, `balance restored ${recovered.totalText ?? ''}`.trim())
  }

  /** 服务还没挂上时的重试间隔——比正常轮询快得多。 */
  const BALANCE_RETRY_MS = 15_000

  if (effective('balance').enabled === true) {
    /**
     * 用自重排的 `setTimeout` 而不是 `setInterval`。
     *
     * 原因：插件激活时 `deepseekAccount` 服务**可能还没挂载**（它是异步挂的），
     * 那一刻 `ctx.get` 拿到 undefined，于是被记成 `unavailable` 并缓存——
     * 换成 `setInterval` 就要干等一整个 `checkSeconds`（默认 300 秒）才重试，
     * 界面上一直显示「不可用」。真机验证时正是踩到这个。
     * 现在服务缺失时 15 秒后重试。
     */
    let balanceTimer = null
    const scheduleBalance = (delayMs) => {
      balanceTimer = setTimeout(async () => {
        await refreshBalance()
        const next =
          balanceState.status === 'unavailable' ? BALANCE_RETRY_MS : effective('balance').checkSeconds * 1000
        scheduleBalance(next)
      }, delayMs)
      // ⚠️ 必须 unref：否则这个定时器会一直吊着事件循环，插件卸载后进程也退不掉
      // （测试直接挂死就是这个原因）。
      if (typeof balanceTimer.unref === 'function') balanceTimer.unref()
    }
    // 先查一次，别等第一个周期。
    scheduleBalance(0)
    // 服务是异步挂载的：等它出现时立刻补一次，不用等重试窗口。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['deepseekAccount'], () => {
        if (balanceState.status === 'unavailable') void refreshBalance()
      })
    }
    ctx.effect(() => () => clearTimeout(balanceTimer), 'progress-nudge: balance polling')
  }

  /**
   * 最近一次被计量的 agent 的 state。
   *
   * 注意这里存的是 **state 引用**而不是快照：秒数必须在**读取时**现算。
   * 早先的版本把秒数算好存进 `live` 缓存，结果两次工具调用之间（比如 Agent
   * 深度思考的那几分钟）接口一直吐旧值，界面上就卡在「0 秒」——这就是截图里
   * 那个 bug 的后半截。
   */
  let liveState = null

  /** 读取时实时计算当前计量（不再返回缓存快照）。 */
  function snapshotLive() {
    if (liveState === null) return null
    const now = Date.now()
    return {
      steps: liveState.steps,
      seconds: secondsOf(liveState, now),
      /** 时钟是否在走。false = 已暂停或回合已结束。 */
      running: liveState.anchorAt !== null,
      nudgeCount: liveState.nudgeCount,
      turnSteps: liveState.turnSteps,
      turnSeconds: turnSecondsOf(liveState, now),
      recentTools: liveState.recentTools.slice(),
    }
  }

  /**
   * 最近一次提醒的详情。页面据此在聊天区弹横幅——提醒本身只进 Agent 的
   * 上下文，用户是看不见的，所以必须单独给用户一份可见反馈。
   */
  let lastNudge = null

  /** 每次计数变化自增，页面据此判断「有没有新东西」。 */
  let seq = 0

  function stateFor(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        steps: 0,
        /** 距上次汇报累计的「工作时间」毫秒；停表期间不增长。 */
        ms: 0,
        /** 计时锚点；null 表示时钟停摆。 */
        anchorAt: null,
        nudgeCount: 0,
        /** 上次提醒的墙钟时刻，只用于 minGap 保护。 */
        lastNudgeAt: 0,
        turnSteps: 0,
        turnMs: 0,
        turnAnchorAt: null,
        /** 当前回合编号，用来识别新回合。 */
        turn: undefined,
        recentTools: [],
        root: undefined,
        /**
         * 自上次「模型对用户说话」以来，已经投递了几次提醒。
         *
         * 这是自适应退避的驱动量：模型一直闷头干活不汇报 → 这个数一直涨 →
         * 阈值被抬高、措辞变强；一旦它真的汇报了，立刻归零。
         */
        silentStreak: 0,
      }
      states.set(agent, state)
    }
    return state
  }

  /** 当前「距上次汇报」秒数 = 已冻结部分 + 正在走的那一段。 */
  function secondsOf(state, now) {
    const running = state.anchorAt === null ? 0 : Math.max(0, now - state.anchorAt)
    return Math.round((state.ms + running) / 1000)
  }

  /** 本回合合计毫秒数。 */
  function turnElapsedMsOf(state, now) {
    const running = state.turnAnchorAt === null ? 0 : Math.max(0, now - state.turnAnchorAt)
    return state.turnMs + running
  }

  /** 本回合合计秒数。 */
  function turnSecondsOf(state, now) {
    return Math.round(turnElapsedMsOf(state, now) / 1000)
  }

  /**
   * 确保时钟在走。
   *
   * ⚠️ 时钟按**墙钟**推进，而不是"只在两次工具调用之间"。原来那种做法有个
   * 致命盲区：Agent 说完一句话 → 归零停表 → 接着深度思考 3 分钟 → 期间一次
   * 工具都没调 → 界面上一直显示「0 秒」，看起来像是坏的，时间触发也永远
   * 覆盖不到这段思考。
   *
   * 现在停表只由两件事触发：**暂停** 与 **回合结束**。
   */
  function ensureRunning(state, now) {
    if (state.anchorAt === null) {
      state.anchorAt = now
      state.turnAnchorAt = now
    }
  }

  /** 当前「距上次汇报」的毫秒数（已结算 + 正在走的一段）。 */
  function elapsedMsOf(state, now) {
    const running = state.anchorAt === null ? 0 : Math.max(0, now - state.anchorAt)
    return state.ms + running
  }

  /** 停表（暂停 / 回合结束）：把已走的一段结算掉，然后挂起。累计值保留。 */
  function freeze(state) {
    if (state.anchorAt !== null) {
      const now = Date.now()
      state.ms += Math.max(0, now - state.anchorAt)
      state.turnMs += Math.max(0, now - (state.turnAnchorAt ?? now))
    }
    state.anchorAt = null
    state.turnAnchorAt = null
  }

  /** 冻住所有 agent 的时钟（暂停时用）。 */
  function freezeAll() {
    for (const state of states.values()) freeze(state)
    const newest = states.size > 0 ? [...states.values()].at(-1) : null
    if (newest !== null) publish(newest)
  }

  /** 根会话判断：拿不到 agents 服务时不阻拦，全部视为根。 */
  function isRoot(state, agent) {
    if (state.root === undefined) {
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.roots !== 'function') {
        state.root = true
      } else {
        try {
          state.root = agents.roots().includes(agent)
        } catch {
          state.root = true
        }
      }
    }
    return state.root
  }

  function excluded(toolName) {
    return effective('exclude').includes(toolName)
  }

  // ---------------------------------------------------------------- 自适应退避

  /**
   * 自适应退避的等级（增强提醒）。
   *
   * 输入是「这一条提醒之后，连续有多少条没换来文字」。等级越高：
   *   - 阈值被放大（提醒更稀疏）——高频提醒在模型不听时只会变成噪音
   *   - 文案换成硬要求（禁用「汇报完继续执行」那种可跳过的措辞）
   *
   * 关闭时永远返回 0，行为退回原样。
   */
  function escalationLevelOf(streak) {
    const cfg = effective('escalation')
    if (cfg.enabled !== true) return 0
    const after = Math.max(1, cfg.afterNudges)
    const raw = Math.floor(streak / after)
    return Math.min(Math.max(0, cfg.maxLevel), Math.max(0, raw))
  }

  /**
   * 这一轮实际生效的阈值（随等级放大）。
   *
   * 注意读的是 `state.silentStreak`（**这一条之前**的沉默连击数）——
   * 所以等级只影响「下一次什么时候触发」，不会让本次触发条件自己抬高。
   */
  function escalatedThresholds(state) {
    const cfg = effective('escalation')
    const level = escalationLevelOf(state.silentStreak)
    const stepBase = effective('stepThreshold')
    const timeBase = effective('timeThresholdSeconds')
    if (level === 0) {
      return { stepThreshold: stepBase, timeThresholdSeconds: timeBase, level: 0 }
    }
    return {
      stepThreshold: Math.round(stepBase * Math.pow(cfg.stepFactor, level)),
      timeThresholdSeconds: Math.round(timeBase * Math.pow(cfg.timeFactor, level)),
      level,
    }
  }

  function publish(state) {
    liveState = state
    seq += 1
  }

  /**
   * 余额提醒的措辞。
   *
   * 主语必须跟着口径走：`recharge` 口径下如果还写「可用余额只剩 ¥x」，
   * 而赠金明明还有一大笔，那句话就是误导。
   */
  function balanceWording() {
    const b = effective('balance')
    const recharge = balanceState.text ?? '—'
    const bonus = balanceState.bonusText
    const total = balanceState.totalText ?? recharge
    if (b.scope === 'recharge') {
      return {
        subjectText: `充值余额只剩 ${recharge}`,
        detailText: `（${bonus ? `另有赠送 ${bonus}，` : ''}可用合计 ${total}）`,
      }
    }
    return {
      subjectText: `可用余额只剩 ${total}`,
      detailText: bonus ? `（充值 ${recharge} + 赠送 ${bonus}）` : '',
    }
  }

  /**
   * 余额低于阈值时单独发一条。
   *
   * 不受步数/时间阈值影响——钱不够是要立刻说的。但交付时机仍受同一条硬约束
   * （只能在步骤边界），所以它是挂在同一次 post-execute 上一起送出去的。
   */
  function balanceNotice(now) {
    const b = effective('balance')
    if (b.enabled !== true) return undefined
    if (!balanceLow()) return undefined
    // 从没提醒过 → 发；提醒过 → 按 repeatSeconds 去重；repeatSeconds=0 → 只发一次。
    if (lastBalanceAlertAt !== 0) {
      if (b.repeatSeconds === 0) return undefined
      if (now - lastBalanceAlertAt < b.repeatSeconds * 1000) return undefined
    }

    const locale = effective('locale')
    const t = template(locale)
    const nowDate = new Date(now)
    const values = {
      now: stamp(nowDate),
      weekday: weekday(nowDate, locale),
      ...balanceWording(),
      thresholdText: `¥${b.thresholdCny}`,
      topUpUrl: balanceState.topUpUrl ?? '',
    }
    const text = t.balanceAlert(values)
    lastBalanceAlertAt = now
    stats.balanceAlerts += 1
    lastBalanceNotice = {
      seq: (lastBalanceNotice?.seq ?? 0) + 1,
      at: now,
      amount: balanceState.amount,
      bonusAmount: balanceState.bonusAmount,
      totalAmount: balanceState.totalAmount,
      text: balanceState.totalText ?? null,
      threshold: b.thresholdCny,
      topUpUrl: values.topUpUrl,
      summary: `${balanceState.totalText ?? '?'} ≤ ¥${b.thresholdCny}`,
      message: text,
    }
    return createNotice(text, `balance ${balanceState.totalText ?? ''}`.trim())
  }

  /**
   * 一次工具执行后推进计量并决定投递哪些提醒。
   *
   * 返回消息数组（可能同时有进度提醒与余额提醒），没有就返回空数组。
   * 所有守卫集中在这里，调用方不用重复判断。
   */
  function observe(exec) {
    if (!effective('enabled')) return []
    const agent = exec.agent
    if (agent === undefined || agent === null) return []
    if (excluded(exec.name)) return []

    const state = stateFor(agent)
    if (!isRoot(state, agent) && !effective('includeSubagents')) return []

    const now = Date.now()
    ensureRunning(state, now)
    state.steps += 1
    state.turnSteps += 1
    state.recentTools.push(exec.name)
    if (state.recentTools.length > RECENT_TOOLS_MAX) state.recentTools.shift()
    publish(state)

    const notices = []

    // ---- 进度提醒（受阈值与冷却约束）----
    const withinCap = state.nudgeCount < effective('maxPerTurn')
    const pastGap = now - state.lastNudgeAt >= effective('minGapSeconds') * 1000
    if (withinCap && pastGap) {
      // 自适应退避：连续没汇报就抬阈值（详见 escalationLevelOf）
      const gate = escalatedThresholds(state)
      const elapsedMs = elapsedMsOf(state, now)
      const bySteps = state.steps >= gate.stepThreshold
      const byTime = elapsedMs >= gate.timeThresholdSeconds * 1000
      if (bySteps || byTime) {
        const seconds = Math.round(elapsedMs / 1000)
        const count = state.nudgeCount + 1
        const locale = effective('locale')
        const t = template(locale)
        const nowDate = new Date(now)
        const turnElapsedMs = turnElapsedMsOf(state, now)
        // 这一条投递之后，连续有多少条没换来文字（文案里要报给模型听）
        const streak = state.silentStreak + 1
        const level = escalationLevelOf(streak)
        const values = {
          // 真实系统时间：模型估不准自己的耗时，必须把钟递到它手上。
          now: stamp(nowDate),
          weekday: weekday(nowDate, locale),
          // 本回合从什么时候开始的（反推），以及已经跑了多久。
          turnStart: stamp(new Date(now - turnElapsedMs)),
          steps: state.steps,
          seconds,
          count,
          turnSteps: state.turnSteps,
          turnSeconds: Math.round(turnElapsedMs / 1000),
          tools: state.recentTools.join(', ') || '-',
          streak,
          level,
        }

        // 升级档优先：连续没汇报时，普通文案里的「汇报完继续执行」会被当成
        // 跳过许可（真机日志里就是这么跳过的），所以要换成硬要求版本。
        let text
        if (level > 0) text = t.escalated(values)
        else if (byTime && !bySteps) text = t.time(values)
        else if (count === 1) text = t.first(values)
        else text = t.later(values)

        // 余额低的时候顺带提一句（省一次打断）。
        if (effective('balance').includeInReport === true && balanceLow()) {
          text += t.balanceLine({
            ...balanceWording(),
            thresholdText: `¥${effective('balance').thresholdCny}`,
          })
        }

        // 共用计量：提醒后「距上次汇报」的两个量一起归零；时钟继续走
        // （turnMs 已在 tick 里结算过，重新锚定不会丢时间）。
        state.steps = 0
        state.ms = 0
        state.anchorAt = now
        state.turnAnchorAt = now
        state.lastNudgeAt = now
        state.nudgeCount = count
        // 投递成功才计入「沉默连击」；被 maxPerTurn/minGap 挡掉的不算。
        state.silentStreak = streak
        stats.nudges += 1
        if (level > 0) stats.escalatedNudges += 1
        publish(state)

        const reason = byTime && !bySteps ? `time ${seconds}s` : `step ${values.steps}`
        lastNudge = {
          seq: (lastNudge?.seq ?? 0) + 1,
          at: now,
          count,
          level,
          streak,
          reason,
          trigger: byTime && !bySteps ? 'time' : 'steps',
          seconds,
          steps: values.steps,
          turnSeconds: values.turnSeconds,
          summary: `${reason} · #${count}`,
          text,
        }
        notices.push(createNotice(text, lastNudge.summary))
      }
    }

    // ---- 余额提醒（独立于阈值，只受 repeatSeconds 去重）----
    const balance = balanceNotice(now)
    if (balance !== undefined) notices.push(balance)

    // ---- 余额恢复（用户充值后告诉模型：别再催了）----
    const recovery = balanceRecoveryNotice(now)
    if (recovery !== undefined) notices.push(recovery)

    return notices
  }

  /**
   * 清零。`running` 决定清零之后时钟是继续走还是停住：
   * - 新回合开始 → true（接下来 Agent 要思考/干活，这段必须计时）
   * - 回合结束   → false（停表，面板停在 0）
   */
  function reset(state, running) {
    const now = Date.now()
    state.steps = 0
    state.ms = 0
    state.turnSteps = 0
    state.turnMs = 0
    state.nudgeCount = 0
    state.anchorAt = running ? now : null
    state.turnAnchorAt = running ? now : null
    state.lastNudgeAt = 0
    state.recentTools = []
    publish(state)
  }

  /** 把本插件要附的上下文放到下游上下文之前（保留下游的 source 与元数据）。 */
  function prepend(ours, theirs) {
    return [...ours, ...(theirs ?? [])]
  }

  // 计数发生在 post-execute：被拒的调用同样流经这里，而模型死磕被拒的调用
  // 恰恰是值得提醒的情况。
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const notices = observe(exec)
    const downstream = await next()
    if (notices.length === 0) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: prepend(notices, downstream.additionalContexts),
      }
    }
    return { ...downstream, additionalContexts: prepend(notices, downstream.additionalContexts) }
  })

  // 新回合开始 / 新的用户提示词：清零并从此刻重新起表。
  // ⚠️ 必须是"起表"而不是"停表"：用户刚发消息，接下来的思考时间是要计的。
  // 判据优先用 payload 里的 `turn` 编号（比扫消息更准），message 判据作为兜底。
  // 我们自己注入的消息 kind 是 progress-nudge，不会自触发。
  ctx.on('agent/pre-step', ({ agent, messages, turn }, next) => {
    const state = stateFor(agent)
    const newTurn = state.turn !== undefined && turn !== undefined && turn !== state.turn
    const userPrompt = Array.isArray(messages)
      ? messages.some((message) => message.source?.kind === 'user')
      : false
    if (turn !== undefined) state.turn = turn
    if (newTurn || userPrompt) {
      reset(state, true)
      stats.resets += 1
    }
    return next()
  })

  // 回合结束：时钟停摆并归零，面板立刻回到 0。这是 `agent/turn-stopping`
  // （普通事件，没有 next），不是瀑布。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = states.get(agent)
    if (state !== undefined) reset(state, false)
  })

  // agent 释放时清掉条目，Map 才不会泄漏。
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  /**
   * Agent 主动对用户输出文本 → 计量归零。
   *
   * 只认 `text-delta`：思考是 `reasoning-delta`、执行是 `tool-call-delta`，
   * 都不该重置。语义是「它刚跟人说过话了」，再催汇报就是刷屏。
   * 这条是普通事件（没有 next）。
   */
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (effective('resetOnSpeech') !== true) return
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta') return
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') return

    const state = states.get(agent)
    if (state === undefined) return
    if (!isRoot(state, agent) && !effective('includeSubagents')) return

    // 「汇报了」→ 自适应退避立刻复位（silentStreak 归零，等级回 0）。
    // ⚠️ 必须在下面那个「还有没有东西可清」的守卫**之前**：
    // 提醒刚投递完 steps/ms 就被清成 0，模型紧接着汇报时正好会被那个守卫
    // 挡掉——那就会出现"明明汇报了，退避却降不下来"的怪象。
    const resetStreak = state.silentStreak > 0
    state.silentStreak = 0

    // 一次「说话」只重置一次：判断标准是"还有没有东西可清"。
    // 不能用 anchorAt 判断——现在说话后时钟是继续走的，用它会变成每来一个
    // token 就重置一次并 publish 一次。
    if (state.steps === 0 && state.ms === 0) {
      if (resetStreak) publish(state)
      return
    }

    state.steps = 0
    state.ms = 0
    // 说话后**继续走表**（从这里重新计时），不是停表。
    // 之前写成 anchorAt = null，结果"说完话开始思考"的那几分钟完全不计时，
    // 界面上就一直卡在「0/10 · 0秒」——已确认的 bug。
    state.anchorAt = Date.now()
    state.turnAnchorAt = Date.now()
    // ⚠️ 这里**不能**清 lastNudgeAt。清了就等于把 minGapSeconds 防连击一起废掉：
    // 日志里出现过「说一次话，36 秒后又来一次提醒」（阈值是 45 秒），就是这个原因。
    // 说话只重置「距上次汇报」的计量，不重置「距上次提醒」的冷却。
    stats.spoke += 1
    publish(state)
  })

  // 面板与设置卡片的数据接口，只在有 web server 的部署里挂载。
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            const method = new URL(req.url ?? '/', 'http://localhost').pathname.slice(
              `${API_PREFIX}/`.length,
            )
            try {
              if (crossSiteRequest(req)) {
                respond(res, 403, { ok: false, error: { code: 'cross-site' } })
                return
              }
              if (req.method !== 'POST') {
                respond(res, 405, { ok: false, error: { code: 'post-only' } })
                return
              }
              const body = await readBody(req)

              if (method === 'status') {
                respond(res, 200, { ok: true, value: snapshot() })
                return
              }

              // 手动刷一次余额（面板上的「刷新」或排查时用）。
              if (method === 'balance') {
                await refreshBalance()
                respond(res, 200, { ok: true, value: snapshotBalance() })
                return
              }

              if (method === 'config') {
                const patch = {}
                if (typeof body.stepThreshold === 'number') patch.stepThreshold = clampInt(body.stepThreshold, 1, 10000)
                if (typeof body.timeThresholdSeconds === 'number') patch.timeThresholdSeconds = clampInt(body.timeThresholdSeconds, 5, 86400)
                if (typeof body.minGapSeconds === 'number') patch.minGapSeconds = clampInt(body.minGapSeconds, 0, 3600)
                if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
                const wasEnabled = effective('enabled')
                // 余额阈值也允许在页面上即时调。
                if (typeof body.balanceThresholdCny === 'number' && Number.isFinite(body.balanceThresholdCny)) {
                  const next = { ...effective('balance'), thresholdCny: Math.max(0, Math.round(body.balanceThresholdCny * 100) / 100) }
                  if (next.thresholdCny === config.balance.thresholdCny) delete overrides.balance
                  else overrides.balance = next
                }
                if (typeof body.balanceEnabled === 'boolean') {
                  const next = { ...effective('balance'), enabled: body.balanceEnabled }
                  if (next.enabled === config.balance.enabled) delete overrides.balance
                  else overrides.balance = next
                }
                // 侧栏「增强提醒」开关
                if (typeof body.escalationEnabled === 'boolean') {
                  const next = { ...effective('escalation'), enabled: body.escalationEnabled }
                  if (next.enabled === config.escalation.enabled) delete overrides.escalation
                  else overrides.escalation = next
                }
                // 把值改回默认值时不留覆盖标记，`overridden` 才真正表示
                // 「和默认值不一样」，而不是「碰过这个字段」。
                for (const [key, value] of Object.entries(patch)) {
                  if (key === 'balance') continue
                  if (value === config[key]) delete overrides[key]
                  else overrides[key] = value
                }
                // 暂停 → 立刻停表（已累计的值保留）；恢复 → anchorAt 仍是 null，
                // 下一次工具调用会重新锚定，所以暂停期间的时间不会被补算。
                if (wasEnabled && !effective('enabled')) freezeAll()
                respond(res, 200, { ok: true, value: snapshot() })
                return
              }

              if (method === 'reset') {
                // 注意：Object.assign(target, {}) 什么也清不掉，必须逐键删除。
                for (const key of Object.keys(overrides)) delete overrides[key]
                respond(res, 200, { ok: true, value: snapshot(), note: 'runtime overrides cleared' })
                return
              }

              respond(res, 404, { ok: false, error: { code: 'unknown-method', method } })
            } catch (failure) {
              respond(res, 400, {
                ok: false,
                error: { code: 'bad-request', message: String(failure?.message ?? failure) },
              })
            }
          },
        }),
      'progress-nudge: routes',
    )
  })

  function clampInt(value, min, max) {
    const rounded = Math.round(value)
    if (!Number.isFinite(rounded)) return min
    return Math.min(max, Math.max(min, rounded))
  }

  /**
   * 阈值是否已被跨越、提醒是否"欠着没发"。
   *
   * 存在的理由：提醒只能在**步骤边界**投递（`additionalContexts` 只能挂在
   * post-execute 决策上）。一个跑 4 分钟的命令期间，计量早就超过 120 秒，
   * 但提醒必须等命令返回才发得出去——这段时间界面上如果什么都不说，
   * 看起来就像插件坏了。`pending` 让界面能明确显示「已到期 · 等当前步骤结束」。
   */
  function snapshotPending() {
    if (liveState === null) return null
    const now = Date.now()
    const elapsed = elapsedMsOf(liveState, now)
    // 用**升级后**的阈值：界面上的「已到期」必须和实际触发条件一致，
    // 否则退避抬高阈值时界面会一直喊「已到期」而提醒迟迟不来。
    const gate = escalatedThresholds(liveState)
    const timeLimit = gate.timeThresholdSeconds * 1000
    const byTime = elapsed >= timeLimit
    const bySteps = liveState.steps >= gate.stepThreshold
    const blocked =
      liveState.nudgeCount >= effective('maxPerTurn') ||
      now - liveState.lastNudgeAt < effective('minGapSeconds') * 1000
    return {
      /** 已越过阈值、且没被上限/冷却挡住 —— 只差一个步骤边界就能发出去。 */
      due: (byTime || bySteps) && !blocked,
      byTime,
      bySteps,
      /** 被 maxPerTurn 或 minGapSeconds 挡着，暂时不会发。 */
      blocked,
      elapsedSeconds: Math.round(elapsed / 1000),
      /** 超出时间阈值多少秒（没超就是 0）。 */
      overSeconds: Math.max(0, Math.round((elapsed - timeLimit) / 1000)),
    }
  }

  function snapshot() {
    return {
      seq,
      enabled: effective('enabled'),
      effective: {
        stepThreshold: effective('stepThreshold'),
        timeThresholdSeconds: effective('timeThresholdSeconds'),
        minGapSeconds: effective('minGapSeconds'),
        maxPerTurn: effective('maxPerTurn'),
        includeSubagents: effective('includeSubagents'),
        resetOnSpeech: effective('resetOnSpeech'),
        locale: effective('locale'),
        exclude: effective('exclude').slice(),
      },
      defaults: {
        stepThreshold: config.stepThreshold,
        timeThresholdSeconds: config.timeThresholdSeconds,
        minGapSeconds: config.minGapSeconds,
      },
      overridden: Object.keys(overrides),
      live: snapshotLive(),
      pending: snapshotPending(),
      escalation: snapshotEscalation(),
      nudge: lastNudge,
      balance: snapshotBalance(),
      tariff: snapshotTariff(),
      stats: { ...stats },
    }
  }

  /**
   * 给界面看的自适应退避状态。
   *
   * `stepThreshold` / `timeThresholdSeconds` 是**当前实际生效**的阈值
   * （已按等级放大）；面板上的输入框仍然改的是基线值。
   */
  function snapshotEscalation() {
    const cfg = effective('escalation')
    const state = liveState
    const streak = state === null ? 0 : state.silentStreak
    const level = escalationLevelOf(streak)
    const gate = state === null
      ? { stepThreshold: effective('stepThreshold'), timeThresholdSeconds: effective('timeThresholdSeconds') }
      : escalatedThresholds(state)
    return {
      enabled: cfg.enabled === true,
      afterNudges: cfg.afterNudges,
      maxLevel: cfg.maxLevel,
      /** 连续多少次提醒没换来文字 */
      silentStreak: streak,
      /** 当前等级，0 = 正常 */
      level,
      /** 实际生效的阈值（面板进度条按它显示） */
      stepThreshold: gate.stepThreshold,
      timeThresholdSeconds: gate.timeThresholdSeconds,
      /** 这一级大概是怎么算出来的，界面可以显示「已升级」 */
      active: level > 0,
    }
  }

  /**
   * 给界面看的峰谷状态。
   *
   * 官方口径（2026-10 查证，见文件上方注释）：高峰 = 工作日 09:00–12:00 与
   * 14:00–18:00（北京时间），低谷半价；周末与法定节假日全天低谷。
   */
  function snapshotTariff() {
    const cfg = effective('tariff')
    if (cfg.enabled !== true) return { enabled: false }
    const now = Date.now()
    const state = tariffAt(now, cfg.holidays)
    const next = nextTariffSwitch(now, cfg.holidays)
    const en = effective('locale') === 'en'
    const labelOf = (offPeak) => (en ? (offPeak ? 'Off-peak' : 'Peak') : offPeak ? '梁文谷' : '梁文峰')
    return {
      enabled: true,
      offPeak: state.offPeak,
      reason: state.reason,
      /** 当前高峰窗口 [起,止]（北京时间整点），非高峰时为 null。 */
      peakWindow: state.peakWindow,
      /** 显示用短标签：中文是那个谐音梗，英文直说。 */
      label: labelOf(state.offPeak),
      /** 折扣系数：低谷 0.5，高峰 1。 */
      discount: state.offPeak ? 0.5 : 1,
      /** 官方高峰窗口（北京时间），界面上写清楚。 */
      peakHoursText: '工作日 09:00–12:00 / 14:00–18:00',
      nextChangeAt: next?.at ?? null,
      nextOffPeak: next?.offPeak ?? null,
      nextLabel: next === null ? null : labelOf(next.offPeak),
      /** 手工配置的节假日天数（0 表示只按周末 + 时段算）。 */
      holidaysCount: cfg.holidays.length,
    }
  }

  /**
   * 给界面看的余额状态。
   * 刻意不把 `topUpUrl` 之外的东西暴露成可读文本，也不回传任何凭证。
   */
  function snapshotBalance() {
    const b = effective('balance')
    return {
      enabled: b.enabled === true,
      thresholdCny: b.thresholdCny,
      scope: b.scope,
      status: balanceState.status,
      reason: balanceState.reason ?? null,
      checkedAt: balanceState.checkedAt || null,
      /** 充值钱包的显示文本，比如 `¥2.85`。 */
      text: balanceState.text ?? null,
      amount: typeof balanceState.amount === 'number' ? balanceState.amount : null,
      /** 赠送钱包（CNY 合计）。平台扣款先从赠金扣，所以它很关键。 */
      bonusText: balanceState.bonusText ?? null,
      bonusAmount: typeof balanceState.bonusAmount === 'number' ? balanceState.bonusAmount : null,
      bonusWallets: (balanceState.bonusWallets ?? []).map((w) => ({ currency: w.currency, balance: w.balance })),
      /** 可用总额 = 充值 + 赠送。 */
      totalText: balanceState.totalText ?? null,
      totalAmount: typeof balanceState.totalAmount === 'number' ? balanceState.totalAmount : null,
      topUpUrl: balanceState.topUpUrl ?? '',
      /** 当前是否低于阈值（口径见 scope）。 */
      low: balanceLow(),
      /** 读数是否够新。 */
      fresh: balanceFresh(),
      lastNotice: lastBalanceNotice,
      /** 最近一次「充值后恢复」的详情，界面用它闪一下绿色确认。 */
      lastRecovery: lastBalanceRecovery,
      alerts: stats.balanceAlerts,
      recoveries: stats.balanceRecoveries,
    }
  }
}
