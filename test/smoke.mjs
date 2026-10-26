/**
 * 冒烟测试：不需要真实 harness，用假的 ctx 驱动 index.js 的两个监听器。
 *
 * 跑法（需要在包根临时放一个 schemastery 桩，跑完删掉）：
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict'

const { DEFAULTS, apply, name, tariffAt, nextTariffSwitch, compareVersions, extractVersion, getJson } =
  await import('../index.js')

console.log(`插件名: ${name}`)
assert.equal(name, 'progress-nudge', 'name 导出应是 progress-nudge')
assert.ok(DEFAULTS && DEFAULTS.stepThreshold === 10, 'DEFAULTS 应导出且默认 10 步')

/** 造一个假 ctx，记录监听器。 */
function makeCtx() {
  const listeners = new Map()
  const routes = []
  return {
    listeners,
    routes,
    services: {},
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    get(key) {
      return this.services[key]
    },
    inject(keys, callback) {
      const fake = { webServer: { register: (def) => { routes.push(def); return () => {} } } }
      callback(fake)
    },
    effect(fn) {
      return fn()
    },
  }
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    stepThreshold: 10,
    timeThresholdSeconds: 120,
    minGapSeconds: 0,
    maxPerTurn: 20,
    exclude: ['todo_write', 'ask_user_question'],
    includeSubagents: false,
    locale: 'zh',
    ...overrides,
  }
}

/** 模拟一次工具执行经过 post-execute 瀑布。 */
async function runTool(ctx, agent, toolName, downstream = {}) {
  const handler = ctx.listeners.get('tools/post-execute')[0]
  const exec = { agent, name: toolName, arguments: {} }
  return handler(exec, {}, async () => downstream)
}

function textOf(decision) {
  const contexts = decision.additionalContexts ?? []
  if (contexts.length === 0) return null
  return contexts[0].content[0].text
}

// ---------------------------------------------------------------- 1. 步数触发
{
  const ctx = makeCtx()
  apply(ctx, baseConfig())
  const agent = {}

  for (let i = 1; i <= 9; i += 1) {
    const out = await runTool(ctx, agent, 'read')
    assert.equal(out.additionalContexts, undefined, `第 ${i} 步不应该提醒`)
  }
  const tenth = await runTool(ctx, agent, 'read')
  const text = textOf(tenth)
  assert.ok(text !== null, '第 10 步应该提醒')
  assert.match(text, /进度汇报/, '文案应含「进度汇报」')
  assert.match(text, /10 步/, '文案应报告 10 步')
  assert.match(text, /汇报完继续执行/, '文案必须要求继续执行')

  const message = tenth.additionalContexts[0]
  assert.equal(message.role, 'user', '注入消息应是 user 角色')
  assert.equal(message.source.kind, 'progress-nudge', 'source.kind 必须是插件自己的标识')
  assert.equal(message.source.form, 'notice', 'source.form 应是 notice')
  assert.ok(typeof message.id === 'string' && message.id.length > 8, '消息应有 id')
  assert.ok(Object.isFrozen(message), '消息应被冻结')

  // 提醒后两个触发器一起归零
  const after = await runTool(ctx, agent, 'read')
  assert.equal(after.additionalContexts, undefined, '提醒后计数应归零')

  console.log('✅ 1. 步数触发（第 10 步提醒、归零、消息形状）')
}

// ---------------------------------------------------------------- 2. 排除工具
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 3 }))
  const agent = {}
  for (let i = 0; i < 5; i += 1) {
    const out = await runTool(ctx, agent, 'todo_write')
    assert.equal(out.additionalContexts, undefined, '被排除的工具不应计数')
  }
  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'read')
  const third = await runTool(ctx, agent, 'read')
  assert.ok(textOf(third) !== null, '被排除的工具应透明，不影响真实计数')
  console.log('✅ 2. exclude 工具透明（不计步、也不重置）')
}

// ---------------------------------------------------------------- 3. 时间触发
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 1000, timeThresholdSeconds: 1 }))
  const agent = {}
  const first = await runTool(ctx, agent, 'read')
  assert.equal(first.additionalContexts, undefined, '刚起步不应该因时间触发')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const second = await runTool(ctx, agent, 'read')
  const text = textOf(second)
  assert.ok(text !== null, '超过时间阈值应提醒')
  assert.match(text, /耗时提醒/, '应使用时间型文案')
  console.log('✅ 3. 时间触发（时间型文案）')
}

// ---------------------------------------------------------------- 4. 共用计量 / 防连击
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 2, timeThresholdSeconds: 1, minGapSeconds: 60 }))
  const agent = {}
  await runTool(ctx, agent, 'read')
  const hit = await runTool(ctx, agent, 'read')
  assert.ok(textOf(hit) !== null, '第 2 步应触发')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const soon = await runTool(ctx, agent, 'read')
  assert.equal(soon.additionalContexts, undefined, 'minGapSeconds 内不应再次提醒')
  console.log('✅ 4. 共用计量 + minGap 防连击')
}

// ---------------------------------------------------------------- 5. 新用户消息清零
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 5 }))
  const agent = {}
  for (let i = 0; i < 4; i += 1) await runTool(ctx, agent, 'read')
  const preStep = ctx.listeners.get('agent/pre-step')[0]
  await preStep({ agent, messages: [{ source: { kind: 'user' } }] }, async () => ({}))
  for (let i = 0; i < 4; i += 1) {
    const out = await runTool(ctx, agent, 'read')
    assert.equal(out.additionalContexts, undefined, '新回合后计数应从 0 重新累计')
  }
  console.log('✅ 5. 新用户消息清零计数')
}

// ---------------------------------------------------------------- 6. 上限与暂停
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 1, maxPerTurn: 2 }))
  const agent = {}
  assert.ok(textOf(await runTool(ctx, agent, 'read')) !== null, '第 1 次')
  assert.ok(textOf(await runTool(ctx, agent, 'read')) !== null, '第 2 次')
  assert.equal((await runTool(ctx, agent, 'read')).additionalContexts, undefined, '超过 maxPerTurn 应静默')
  console.log('✅ 6. maxPerTurn 上限')
}

// ---------------------------------------------------------------- 7. 路由挂载
{
  const ctx = makeCtx()
  apply(ctx, baseConfig())
  assert.equal(ctx.routes.length, 1, '应注册一条前缀路由')
  assert.equal(ctx.routes[0].kind, 'prefix', 'kind 应为 prefix')
  assert.equal(ctx.routes[0].path, '/progress-nudge/api', '路径应为 /progress-nudge/api')
  console.log('✅ 7. HTTP 前缀路由已注册')
}

// ---------------------------------------------------------------- 8. 非法配置快速失败
{
  for (const bad of [{ stepThreshold: 0 }, { timeThresholdSeconds: -1 }, { locale: 'jp' }]) {
    const ctx = makeCtx()
    assert.throws(() => apply(ctx, baseConfig(bad)), /progress-nudge/, `非法配置应抛错: ${JSON.stringify(bad)}`)
  }
  console.log('✅ 8. 非法配置 fail-loud')
}

// ---------------------------------------------------------------- 9. 路由端到端
{
  const { EventEmitter } = await import('node:events')
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 4 }))
  const agent = {}

  // 先跑两步，让快照里有数据
  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'grep')

  const route = ctx.routes[0]
  const call = (method, payload, headers = { host: 'localhost' }) =>
    new Promise((resolve) => {
      const req = new EventEmitter()
      req.method = 'POST'
      req.url = `/progress-nudge/api/${method}`
      req.headers = { 'content-type': 'application/json', ...headers }
      req.destroy = () => {}
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(name, value) {
          this.headers[name] = value
        },
        end(body) {
          resolve({ status: this.statusCode, body: JSON.parse(body) })
        },
      }
      const promise = route.handler(req, res)
      void promise
      const raw = JSON.stringify(payload ?? {})
      req.emit('data', Buffer.from(raw))
      req.emit('end')
    })

  const status = await call('status')
  assert.equal(status.status, 200, '/status 应返回 200')
  assert.equal(status.body.ok, true, '信封 ok 应为 true')
  assert.equal(status.body.value.effective.stepThreshold, 4, '应回显生效阈值')
  assert.equal(status.body.value.live.steps, 2, '应回显已走 2 步')
  assert.deepEqual(status.body.value.overridden, [], '初始没有运行时覆盖')

  const patched = await call('config', { stepThreshold: 7 })
  assert.equal(patched.body.value.effective.stepThreshold, 7, '运行时覆盖应生效')
  assert.ok(patched.body.value.overridden.includes('stepThreshold'), '应记录被覆盖的键')
  assert.equal(patched.body.value.defaults.stepThreshold, 4, '默认值应保持不变')

  const cleared = await call('reset')
  assert.equal(cleared.body.value.effective.stepThreshold, 4, 'reset 应恢复默认')

  const forbidden = await call('status', {}, { host: 'localhost', origin: 'https://evil.example' })
  assert.equal(forbidden.status, 403, '跨站请求应被拒')

  const unknown = await call('nope')
  assert.equal(unknown.status, 404, '未知方法应 404')

  console.log('✅ 9. 路由端到端（status / config 覆盖 / reset / 跨站拦截 / 404）')
}

// ---------------------------------------------------------------- 10. 缺省值补齐
{
  // 没有平台 Config schema 兜底：行配置只写一部分（甚至不写）也必须安全。
  const ctx = makeCtx()
  apply(ctx, { stepThreshold: 3 })
  const agent = {}
  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'read')
  const third = await runTool(ctx, agent, 'read')
  assert.ok(textOf(third) !== null, '只给 stepThreshold 时其余字段应走默认值')

  const full = makeCtx()
  apply(full, undefined)
  assert.ok(full.routes[0] !== undefined, '完全不传 config 也应正常激活')
  console.log('✅ 10. 缺省值补齐（部分配置 / 无配置）')
}

// ---------------------------------------------------------------- 11. 零外部依赖
{
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^\s*import\s.+?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  // 真正的约束是「每一个 import 都是 node: 内建」，不是「只能有某一个内建」。
  // 之前把期望写死成 ['node:crypto']，加个 node:fs 就误报——那是测试的错，不是代码的错。
  const outsiders = imports.filter((spec) => !spec.startsWith('node:'))
  assert.deepEqual(
    outsiders,
    [],
    `index.js 只能 import node 内建模块，发现外部依赖: ${outsiders.join(', ')}`,
  )
  assert.ok(
    imports.includes('node:crypto'),
    '必须仍用 node:crypto 生成消息 id（不借宿主的 brandString）',
  )
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(client), 'client.js 不应有顶层 import（只走 __ModuleLoader__）')
  console.log(`✅ 11. 零外部依赖（只 import node 内建：${imports.join(', ')}）`)
}

// ---------------------------------------------------------------- 12. 暂停 = 时钟冻结
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { EventEmitter } = await import('node:events')

function routeCall(ctx, method, payload, headers = { host: 'localhost' }) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = `/progress-nudge/api/${method}`
    req.headers = { 'content-type': 'application/json', ...headers }
    req.destroy = () => {}
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(body) })
      },
    }
    void ctx.routes[0].handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(payload ?? {})))
    req.emit('end')
  })
}

{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  const agent = {}

  await runTool(ctx, agent, 'read')
  await sleep(1100)
  await runTool(ctx, agent, 'read') // 累计约 1.1 秒
  const before = (await routeCall(ctx, 'status')).body.value
  assert.equal(before.live.running, true, '工作时时钟应在走')
  const stepsBefore = before.live.steps

  await routeCall(ctx, 'config', { enabled: false })
  const paused = (await routeCall(ctx, 'status')).body.value
  assert.equal(paused.enabled, false, '暂停应生效')
  assert.equal(paused.live.running, false, '暂停后 running 应为 false')

  const frozenAt = paused.live.seconds
  await sleep(1500) // 暂停期间干等 1.5 秒
  await runTool(ctx, agent, 'read') // 暂停期间的工具调用也不该计数
  const stillPaused = (await routeCall(ctx, 'status')).body.value
  assert.equal(stillPaused.live.seconds, frozenAt, '暂停期间秒数必须纹丝不动')
  assert.equal(stillPaused.live.steps, stepsBefore, '暂停期间步数也不该增长')

  await routeCall(ctx, 'config', { enabled: true })
  await runTool(ctx, agent, 'read')
  const resumed = (await routeCall(ctx, 'status')).body.value
  assert.equal(resumed.live.running, true, '恢复后时钟应继续走')
  assert.ok(
    resumed.live.seconds - frozenAt <= 1,
    `恢复后不应补算暂停期间的时间（冻结 ${frozenAt}s → 恢复后 ${resumed.live.seconds}s）`,
  )
  console.log('✅ 12. 暂停 = 时钟冻结（干等 1.5 秒不动，恢复后不补算）')
}

// ---------------------------------------------------------------- 13. 回合结束归零并停表
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  const agent = {}
  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'grep')
  const mid = (await routeCall(ctx, 'status')).body.value
  assert.equal(mid.live.steps, 2, '回合中应累计 2 步')
  assert.equal(mid.live.running, true, '回合中时钟应在走')

  ctx.listeners.get('agent/turn-stopping')[0]({ agent })
  const ended = (await routeCall(ctx, 'status')).body.value
  assert.equal(ended.live.steps, 0, '回合结束应归零')
  assert.equal(ended.live.seconds, 0, '回合结束秒数应归零')
  assert.equal(ended.live.running, false, '回合结束应停表')

  // 新回合（turn 编号变化）也要重置——但**要起表**，因为接下来是思考时间
  await runTool(ctx, agent, 'read')
  const preStep = ctx.listeners.get('agent/pre-step')[0]
  await preStep({ agent, messages: [], turn: 1 }, async () => ({}))
  await preStep({ agent, messages: [], turn: 2 }, async () => ({}))
  const newTurn = (await routeCall(ctx, 'status')).body.value
  assert.equal(newTurn.live.steps, 0, '新回合应重置')
  assert.equal(newTurn.live.running, true, '新回合必须起表：用户刚发消息，接下来的思考要计时')
  console.log('✅ 13. 回合结束停表 / 新回合归零并起表')
}

// ---------------------------------------------------------------- 14. 主动输出文本 → 计量归零
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  const agent = {}
  const stream = ctx.listeners.get('agent/assistant-stream')[0]

  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'grep')
  assert.equal((await routeCall(ctx, 'status')).body.value.live.steps, 2, '先累计 2 步')

  // 思考：不该重置
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '嗯…' } } })
  assert.equal((await routeCall(ctx, 'status')).body.value.live.steps, 2, '思考不应重置步数')

  // 工具调用增量：不该重置
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'tool-call-delta', argumentsDelta: '{}' } } })
  assert.equal((await routeCall(ctx, 'status')).body.value.live.steps, 2, '工具调用不应重置步数')

  // 空白文本：不该重置
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '   ' } } })
  assert.equal((await routeCall(ctx, 'status')).body.value.live.steps, 2, '空白文本不应重置')

  // 真的对用户说话：重置计量，但时钟继续走（不是停表）
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '进度快报：' } } })
  const spoken = (await routeCall(ctx, 'status')).body.value
  assert.equal(spoken.live.steps, 0, '主动输出文本应重置步数')
  assert.equal(spoken.live.seconds, 0, '主动输出文本应归零计时')
  assert.equal(spoken.live.running, true, '主动输出后时钟必须继续走（停表会让思考时间全丢）')
  assert.equal(spoken.stats.spoke, 1, '应记录一次「说过话」')
  // 一次说话只该重置一次，不能每个 token 都重置
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '接着说' } } })
  assert.equal((await routeCall(ctx, 'status')).body.value.stats.spoke, 1, '同一段话的后续 token 不该重复计数')

  // 关掉开关后不再重置
  const off = makeCtx()
  apply(off, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999, resetOnSpeech: false }))
  const agent2 = {}
  await runTool(off, agent2, 'read')
  await runTool(off, agent2, 'grep')
  off.listeners.get('agent/assistant-stream')[0]({
    agent: agent2,
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: '说话' } },
  })
  assert.equal((await routeCall(off, 'status')).body.value.live.steps, 2, 'resetOnSpeech=false 时不应重置')
  console.log('✅ 14. 主动输出文本重置（思考/工具调用/空白都不重置）')
}

// ---------------------------------------------------------------- 15. 改回默认值清掉覆盖标记
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 10, timeThresholdSeconds: 120 }))
  const changed = await routeCall(ctx, 'config', { stepThreshold: 7 })
  assert.ok(changed.body.value.overridden.includes('stepThreshold'), '改动后应有覆盖标记')
  assert.equal(changed.body.value.effective.stepThreshold, 7)

  const reverted = await routeCall(ctx, 'config', { stepThreshold: 10 })
  assert.deepEqual(reverted.body.value.overridden, [], '改回默认值应清掉覆盖标记，而不是留着')
  assert.equal(reverted.body.value.effective.stepThreshold, 10, '生效值应回到默认')
  console.log('✅ 15. 改回默认值会清掉覆盖标记（overridden 只表示「和默认不同」）')
}

// ---------------------------------------------------------------- 16. 说话重置计量，但不动防连击冷却
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 1, timeThresholdSeconds: 99999, minGapSeconds: 60 }))
  const agent = {}
  const first = await runTool(ctx, agent, 'read')
  assert.ok(textOf(first) !== null, '第 1 步应触发提醒')

  // 说话会重置「距上次汇报」的计量……
  const stream = ctx.listeners.get('agent/assistant-stream')[0]
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '进度快报' } } })
  const afterSpeech = (await routeCall(ctx, 'status')).body.value
  assert.equal(afterSpeech.live.steps, 0, '说话应重置步数')

  // ……但**不能**把 minGap 冷却一起清掉。日志里 36s/42s 的连击就是这个 bug。
  const next = await runTool(ctx, agent, 'read')
  assert.equal(
    next.additionalContexts,
    undefined,
    '说话重置计量后仍必须受 minGapSeconds 约束（否则会出现 36 秒连击）',
  )
  console.log('✅ 16. 说话只重置计量，不重置 minGap 冷却（修掉日志里的 36s 连击）')
}

// ---------------------------------------------------------------- 17. nudge 快照（给界面用）
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 2 }))
  const agent = {}
  await runTool(ctx, agent, 'read')
  const before = (await routeCall(ctx, 'status')).body.value
  assert.equal(before.nudge, null, '还没提醒过时 nudge 应为 null')

  await runTool(ctx, agent, 'grep')
  const after = (await routeCall(ctx, 'status')).body.value
  assert.ok(after.nudge !== null, '提醒后应带 nudge 快照给界面')
  // 提醒必须把真实系统时间递给模型——模型估不准自己用了多久
  assert.match(
    after.nudge.text,
    /现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（周[一二三四五六日]）/,
    `提醒文案必须带真实系统时间，实际: ${after.nudge.text}`,
  )
  assert.match(
    after.nudge.text,
    /本回合起于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
    `应给出本回合开始时间，实际: ${after.nudge.text}`,
  )
  assert.ok(
    typeof after.nudge.at === 'number' && after.nudge.at > 0,
    '快照应带时间戳给常驻横幅用',
  )
  assert.equal(after.nudge.seq, 1, '第一次提醒 seq=1')
  assert.equal(after.nudge.trigger, 'steps', '应标明是步数触发')
  assert.equal(after.nudge.steps, 2, '应记录触发时的步数')
  assert.equal(typeof after.nudge.text, 'string', '应带上完整提醒文案')
  assert.ok(after.nudge.summary.includes('step'), 'summary 应可读')

  await runTool(ctx, agent, 'read')
  await runTool(ctx, agent, 'read')
  const second = (await routeCall(ctx, 'status')).body.value
  assert.equal(second.nudge.seq, 2, 'seq 必须递增，界面靠它判断「有新提醒」')
  console.log('✅ 17. nudge 快照（seq 递增 + 触发原因 + 文案）')
}

// ---------------------------------------------------------------- 18. 思考时间必须被计时（bug 回归）
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999, minGapSeconds: 0 }))
  const agent = {}
  // 用户刚发消息 → 新回合
  await ctx.listeners.get('agent/pre-step')[0](
    { agent, messages: [{ source: { kind: 'user' } }], turn: 1 },
    async () => ({}),
  )
  const started = (await routeCall(ctx, 'status')).body.value
  assert.equal(started.live.running, true, '新回合开始就该起表')

  // 复现截图：Agent 说完话 → 深度思考，期间一次工具都不调
  const stream = ctx.listeners.get('agent/assistant-stream')[0]
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Now the full suite:' } } })
  await sleep(1300)

  const thinking = (await routeCall(ctx, 'status')).body.value
  assert.equal(thinking.live.steps, 0, '还没调工具，步数应为 0')
  assert.equal(thinking.live.running, true, '说话之后时钟必须还在走')
  assert.ok(
    thinking.live.seconds >= 1,
    `说话后思考 1.3 秒，界面必须显示 ≥1 秒（截图里卡在 0 秒就是这个 bug），实际 ${thinking.live.seconds}`,
  )
  console.log('✅ 18. 思考时间被计时（说话不再把时钟冻在 0 秒）')
}

// ---------------------------------------------------------------- 19. 时间触发能覆盖「纯思考」那一段
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 1, minGapSeconds: 0 }))
  const agent = {}
  await runTool(ctx, agent, 'read')
  const stream = ctx.listeners.get('agent/assistant-stream')[0]
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '说话' } } })
  await sleep(1200) // 纯思考，没有工具调用
  const out = await runTool(ctx, agent, 'read')
  assert.ok(
    textOf(out) !== null,
    '思考那 1.2 秒必须被计入，并在下一次工具调用时触发时间型提醒',
  )
  console.log('✅ 19. 时间触发覆盖纯思考段（旧实现这段完全不计时）')
}

// ---------------------------------------------------------------- 20. pending：越过阈值但还没发出
{
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 1, minGapSeconds: 0 }))
  const agent = {}
  await runTool(ctx, agent, 'read') // 起表

  const fresh = (await routeCall(ctx, 'status')).body.value.pending
  assert.equal(fresh.due, false, '刚起步不该 due')
  assert.equal(fresh.byTime, false)

  await sleep(2500) // 模拟"一个长命令正在跑"，期间没有工具边界 → 提醒发不出去
  const overdue = (await routeCall(ctx, 'status')).body.value.pending
  assert.equal(overdue.byTime, true, '应判定为时间越界')
  assert.equal(overdue.due, true, '越界且没被挡住时 due 应为 true —— 界面据此显示「已到期」')
  assert.ok(overdue.overSeconds >= 1, `应报出超出多少秒，实际 ${overdue.overSeconds}`)

  // 被 minGap 挡住时 due 必须是 false（提醒确实发不出去，界面不该骗人）
  const gapped = makeCtx()
  apply(gapped, baseConfig({ stepThreshold: 1, timeThresholdSeconds: 9999, minGapSeconds: 60 }))
  const agent2 = {}
  await runTool(gapped, agent2, 'read') // 立刻发一次（步数阈值 1）
  await sleep(1100)
  const blocked = (await routeCall(gapped, 'status')).body.value.pending
  assert.equal(blocked.blocked, true, 'minGap 冷却中应标记 blocked')
  assert.equal(blocked.due, false, '被冷却挡住时不该说「马上会提醒」')
  console.log('✅ 20. pending：越过阈值但等步骤边界时，界面能提前说明')
}

// ---------------------------------------------------------------- 21. 余额监控
{
  const account = (amount) => ({
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: amount }],
      bonusWallets: [{ currency: 'CNY', balance: '0.00' }],
    }),
    getState: async () => ({ links: { topUpUrl: 'https://example.com/topup' } }),
  })
  const textsOf = (out) => (out.additionalContexts ?? []).map((m) => m.content[0].text)

  // 低于阈值 → 在工具边界投递一条余额提醒
  const ctx = makeCtx()
  ctx.services.deepseekAccount = account('1.20')
  apply(
    ctx,
    baseConfig({
      stepThreshold: 999,
      timeThresholdSeconds: 9999,
      balance: { enabled: true, thresholdCny: 1.5, checkSeconds: 30, repeatSeconds: 1800, includeInReport: true },
    }),
  )
  await sleep(60) // 等首次 refreshBalance 落地
  const agent = {}
  const texts = textsOf(await runTool(ctx, agent, 'read'))
  const alert = texts.find((s) => s.includes('余额不足'))
  assert.ok(alert !== undefined, `应包含余额提醒，实际: ${JSON.stringify(texts)}`)
  assert.match(alert, /¥1\.20/, '提醒里要有真实余额')
  assert.match(alert, /¥1\.5/, '提醒里要有阈值')
  assert.match(alert, /example\.com\/topup/, '提醒里要带充值链接')
  assert.match(alert, /现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '余额提醒也要带系统时间')
  assert.equal((await routeCall(ctx, 'status')).body.value.balance.low, true, '快照应标记 low')

  // 去重：紧接着的下一次工具调用不该再发
  const again = textsOf(await runTool(ctx, agent, 'read'))
  assert.equal(again.filter((s) => s.includes('余额不足')).length, 0, 'repeatSeconds 内不该重复发')

  // 余额充足 → 不发
  const rich = makeCtx()
  rich.services.deepseekAccount = account('42.00')
  apply(rich, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  await sleep(60)
  assert.equal(textsOf(await runTool(rich, {}, 'read')).length, 0, '余额充足时不该提醒')
  assert.equal((await routeCall(rich, 'status')).body.value.balance.low, false)

  // 宿主没有这个服务 → 记为 unavailable，不崩也不提醒
  const bare = makeCtx()
  apply(bare, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  await sleep(60)
  assert.equal(textsOf(await runTool(bare, {}, 'read')).length, 0, '没有账户服务时不该提醒')
  assert.equal(
    (await routeCall(bare, 'status')).body.value.balance.status,
    'unavailable',
    '应记为 unavailable',
  )
  console.log('✅ 21. 余额监控（低额提醒 / 去重 / 充足不打扰 / 无服务不崩）')
}

// ---------------------------------------------------------------- 22. 低额时进度汇报顺带带上余额
{
  const ctx = makeCtx()
  ctx.services.deepseekAccount = {
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '0.80' }], bonusWallets: [] }),
    getState: async () => ({ links: { topUpUrl: '' } }),
  }
  apply(
    ctx,
    baseConfig({
      stepThreshold: 1,
      timeThresholdSeconds: 9999,
      minGapSeconds: 0,
      balance: { enabled: true, thresholdCny: 1.5, checkSeconds: 30, repeatSeconds: 0, includeInReport: true },
    }),
  )
  await sleep(60)
  const out = await runTool(ctx, {}, 'read')
  const progress = (out.additionalContexts ?? [])
    .map((m) => m.content[0].text)
    .find((s) => s.includes('进度汇报'))
  assert.ok(progress !== undefined, '应有进度汇报')
  assert.match(progress, /可用余额只剩 ¥0\.80，已低于阈值 ¥1\.5/, `进度汇报里应顺带提余额，实际: ${progress}`)
  console.log('✅ 22. 低额时进度汇报顺带带上余额')
}

// ---------------------------------------------------------------- 23. 非法余额配置 fail-loud
{
  for (const bad of [
    { balance: { thresholdCny: -1 } },
    { balance: { checkSeconds: 5 } },
    { balance: { thresholdCny: 'x' } },
    { balance: { enabled: 'yes' } },
  ]) {
    const ctx = makeCtx()
    assert.throws(
      () => apply(ctx, baseConfig(bad)),
      /balance/,
      `非法余额配置应抛错: ${JSON.stringify(bad)}`,
    )
  }
  console.log('✅ 23. 非法余额配置 fail-loud')
}

// ---------------------------------------------------------------- 24. 赠金与口径
{
  // 构造「充值低于阈值、但总额远高于阈值」的场面：
  // 充值 1.00、赠送 92.52、阈值 1.5 —— 只有 recharge 口径才该判低额。
  const build = (scope) => {
    const c = makeCtx()
    c.services.deepseekAccount = {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '1.0000000000' }],
        bonusWallets: [{ currency: 'CNY', balance: '92.5200000000' }],
      }),
      getState: async () => ({ links: { topUpUrl: 'https://platform.deepseek.com/top_up' } }),
    }
    apply(
      c,
      baseConfig({
        stepThreshold: 999,
        timeThresholdSeconds: 9999,
        balance: {
          enabled: true,
          thresholdCny: 1.5,
          checkSeconds: 30,
          repeatSeconds: 1800,
          includeInReport: true,
          scope,
        },
      }),
    )
    return c
  }

  const total = build('total')
  await sleep(60)
  const snapshot = (await routeCall(total, 'status')).body.value.balance
  assert.equal(snapshot.text, '¥1.00', '充值余额应收成两位小数')
  assert.equal(snapshot.bonusText, '¥92.52', '赠金要单独显示')
  assert.equal(snapshot.totalText, '¥93.52', '可用总额 = 充值 + 赠金')
  assert.equal(snapshot.low, false, '总额充足时不该判低额（只看充值会误报）')
  assert.equal((await runTool(total, {}, 'read')).additionalContexts, undefined, '不该提醒')

  // 只看充值余额的口径：这时才应该判低额
  const recharge = build('recharge')
  await sleep(60)
  assert.equal(
    (await routeCall(recharge, 'status')).body.value.balance.low,
    true,
    'recharge 口径下充值余额低于阈值应判低额',
  )
  const alert = (await runTool(recharge, {}, 'read')).additionalContexts?.[0]?.content?.[0]?.text ?? ''
  assert.match(alert, /充值余额只剩 ¥1\.00/, `recharge 口径的主语必须是"充值余额"，实际: ${alert}`)
  assert.match(alert, /另有赠送 ¥92\.52，可用合计 ¥93\.52/, `应交代赠金与总额，实际: ${alert}`)
  assert.ok(!/可用余额只剩 ¥93\.52/.test(alert), '不能说"可用余额只剩 ¥93.52"这种误导话术')
  // 赠金为 0 时不该写「赠送 ¥0.00」——那是噪音（用户截图里就出现过）
  {
    const c = makeCtx()
    c.services.deepseekAccount = {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '10.68' }],
        bonusWallets: [{ currency: 'CNY', balance: '0.0000000' }],
      }),
      getState: async () => ({ links: { topUpUrl: '' } }),
    }
    apply(
      c,
      baseConfig({
        stepThreshold: 999,
        timeThresholdSeconds: 9999,
        balance: { enabled: true, thresholdCny: 100, checkSeconds: 30, repeatSeconds: 1800, includeInReport: true, scope: 'total' },
      }),
    )
    await sleep(60)
    const snap = (await routeCall(c, 'status')).body.value.balance
    assert.equal(snap.bonusText, null, '赠金为 0 时不该当成有赠金')
    assert.equal(snap.totalText, '¥10.68', '总额 = 充值 + 0，不受影响')
    const alert = (await runTool(c, {}, 'read')).additionalContexts?.[0]?.content?.[0]?.text ?? ''
    assert.ok(!/赠送 ¥0\.00/.test(alert), `低额文案里不该出现「赠送 ¥0.00」，实际: ${alert}`)
  }

  console.log('✅ 24. 赠金与口径（默认按可用总额；主语随口径变化；赠金为 0 不显示）')
}

// ---------------------------------------------------------------- 25. 峰谷时段（官方口径）
{
  // 官方：高峰 = 01:00–04:00 与 06:00–10:00 UTC，周一至周五，剔除中国法定节假日。
  // 换算成北京时间即工作日 09:00–12:00 与 14:00–18:00。
  // 全部用 Date.UTC 构造固定时刻，与运行机器的时区无关。
  const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi) // 北京时间 → 时刻
  const FRI = [2026, 10, 16] // 2026-10-16 是周五
  const SAT = [2026, 10, 17]

  const cases = [
    ['周五 10:00（高峰窗口内）', bj(...FRI, 10), false],
    ['周五 09:00（高峰刚开）', bj(...FRI, 9), false],
    ['周五 11:59（高峰末尾）', bj(...FRI, 11, 59), false],
    ['周五 12:00（午休转低谷）', bj(...FRI, 12), true],
    ['周五 08:59（高峰前一分钟）', bj(...FRI, 8, 59), true],
    ['周五 14:00（下午高峰）', bj(...FRI, 14), false],
    ['周五 18:00（转低谷）', bj(...FRI, 18), true],
    ['周五 23:00（夜间低谷）', bj(...FRI, 23), true],
    ['周六 10:00（周末全天低谷）', bj(...SAT, 10), true],
    ['周日 15:00（周末全天低谷）', bj(2026, 10, 18, 15), true],
  ]
  for (const [name, at, expected] of cases) {
    assert.equal(tariffAt(at, []).offPeak, expected, `${name} 应判定为 ${expected ? '低谷' : '高峰'}`)
  }

  // 下一次切换点
  assert.equal(
    nextTariffSwitch(bj(...FRI, 10), []).at,
    bj(...FRI, 12),
    '周五 10:00 的下一次切换应是当天 12:00（转低谷）',
  )
  assert.equal(nextTariffSwitch(bj(...FRI, 10), []).offPeak, true)
  assert.equal(
    nextTariffSwitch(bj(...FRI, 12, 30), []).at,
    bj(...FRI, 14),
    '午休中的下一次切换应是 14:00（转高峰）',
  )
  assert.equal(nextTariffSwitch(bj(...FRI, 12, 30), []).offPeak, false)
  assert.equal(
    nextTariffSwitch(bj(...FRI, 8), []).at,
    bj(...FRI, 9),
    '周五 08:00 的下一次切换应是 09:00（转高峰）',
  )
  // 周五晚 → 下一次高峰是下周一 09:00（周末全是低谷）
  assert.equal(
    nextTariffSwitch(bj(...FRI, 20), []).at,
    bj(2026, 10, 19, 9),
    '周五 20:00 后，下一次转高峰应是下周一 09:00',
  )

  // 手工节假日：官方口径里节假日全天低谷
  assert.equal(tariffAt(bj(...FRI, 10), ['2026-10-16']).offPeak, true, '配成节假日后应整天低谷')
  assert.equal(tariffAt(bj(...FRI, 10), ['2026-10-16']).reason, 'holiday')
  assert.equal(tariffAt(bj(...FRI, 10), ['2026-10-15']).offPeak, false, '非当天的节假日不该影响')

  console.log('✅ 25. 峰谷时段（工作日 09–12/14–18 高峰；周末、午休、夜间低谷；节假日可配）')
}

// ---------------------------------------------------------------- 26. 账户服务后挂载
{
  // 真机踩到过：插件激活那一刻 deepseekAccount 还没挂上，被记成 unavailable。
  // 这里验证「服务出现后能恢复」——面板打开与 ↻ 走的都是这条路。
  const ctx = makeCtx()
  apply(ctx, baseConfig({ stepThreshold: 999, timeThresholdSeconds: 9999 }))
  await sleep(60)
  assert.equal(
    (await routeCall(ctx, 'status')).body.value.balance.status,
    'unavailable',
    '服务未挂载时应记为 unavailable，而不是崩掉或谎报余额',
  )

  ctx.services.deepseekAccount = {
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '5.00' }], bonusWallets: [] }),
    getState: async () => ({ links: { topUpUrl: '' } }),
  }
  const recovered = (await routeCall(ctx, 'balance')).body.value
  assert.equal(recovered.status, 'ok', '服务出现后刷新应恢复为 ok')
  assert.equal(recovered.totalText, '¥5.00', '恢复后应读到真实余额')
  console.log('✅ 26. 账户服务后挂载时可恢复（unavailable → ok）')
}

// ---------------------------------------------------------------- 27. 充值后也要告诉模型
{
  // 用户充值后，模型如果还按「余额不足」的记忆行事，就会继续催充值。
  // 所以「低额 → 恢复」必须也投递一条通知。
  let amount = '1.00'
  const ctx = makeCtx()
  ctx.services.deepseekAccount = {
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: amount }], bonusWallets: [] }),
    getState: async () => ({ links: { topUpUrl: 'https://platform.deepseek.com/top_up' } }),
  }
  apply(
    ctx,
    baseConfig({
      stepThreshold: 999,
      timeThresholdSeconds: 9999,
      minGapSeconds: 0,
      balance: {
        enabled: true,
        thresholdCny: 1.5,
        checkSeconds: 30,
        repeatSeconds: 1800,
        includeInReport: true,
        scope: 'total',
      },
    }),
  )
  await sleep(60)
  const agent = {}
  const textsOf = (out) => (out.additionalContexts ?? []).map((m) => m.content[0].text)

  // 1) 低额 → 先给模型一条「余额不足」
  const before = textsOf(await runTool(ctx, agent, 'read'))
  assert.ok(before.some((s) => s.includes('余额不足')), `应先是低额提醒，实际: ${JSON.stringify(before)}`)

  // 2) 用户充值到 11.45，手动刷一次（面板打开 / ↻ 走的就是这条路）
  amount = '11.45'
  await routeCall(ctx, 'balance')

  // 3) 下一次工具调用要把「恢复」告诉模型
  const after = textsOf(await runTool(ctx, agent, 'read'))
  const recovery = after.find((s) => s.includes('余额已恢复'))
  assert.ok(recovery !== undefined, `充值后应给模型一条恢复通知，实际: ${JSON.stringify(after)}`)
  assert.match(recovery, /¥11\.45/, '恢复通知要带新的可用余额')
  assert.match(recovery, /高于阈值 ¥1\.5/, '要说明已经高于阈值')
  assert.match(recovery, /不要再提|不要再催/, '要明确让模型停止催充值')
  assert.match(recovery, /现在是 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '恢复通知也要带系统时间')

  const snapshot = (await routeCall(ctx, 'status')).body.value.balance
  assert.equal(snapshot.low, false, '恢复后 low 应为 false')
  assert.equal(snapshot.recoveries, 1, '恢复次数应记为 1')
  assert.equal(snapshot.lastRecovery.totalText, '¥11.45', '快照要留下恢复详情给界面')

  // 4) 只发一次，不许重复刷
  const twice = textsOf(await runTool(ctx, agent, 'read'))
  assert.equal(twice.filter((s) => s.includes('余额已恢复')).length, 0, '恢复通知不该重复发')

  // 5) 再次掉下去应该能立刻提醒（恢复时已清掉 repeatSeconds 冷却）
  amount = '0.50'
  await routeCall(ctx, 'balance')
  const dropped = textsOf(await runTool(ctx, agent, 'read'))
  assert.ok(
    dropped.some((s) => s.includes('余额不足')),
    `恢复后再次低额应能立刻重新提醒（否则会被 1800 秒冷却吞掉），实际: ${JSON.stringify(dropped)}`,
  )
  console.log('✅ 27. 充值后通知模型（低额 → 恢复 → 再降可立刻重新提醒）')
}

// ---------------------------------------------------------------- 28. 自适应退避（增强提醒）
{
  // 用默认的 afterNudges=2：前两条提示不升级，第 2 条之后开始升级。
  // （afterNudges=1 的语义是「第一条就算升级」，普通档永远不出现，不适合当默认。）
  const ctx = makeCtx()
  apply(
    ctx,
    baseConfig({
      stepThreshold: 1,
      timeThresholdSeconds: 9999,
      minGapSeconds: 0,
      escalation: { enabled: true, afterNudges: 2, stepFactor: 2, timeFactor: 2, maxLevel: 3 },
    }),
  )
  const agent = {}
  const textsOf = (out) => (out.additionalContexts ?? []).map((m) => m.content[0].text)
  const escOf = async () => (await routeCall(ctx, 'status')).body.value.escalation
  const fire = async () => textsOf(await runTool(ctx, agent, 'read'))

  // 第 1 条：还不到 N，普通文案
  const n1 = await fire()
  assert.equal(n1.length, 1, '第 1 步应提醒')
  assert.ok(n1[0].includes('进度汇报') && !n1[0].includes('未响应'), `第 1 条应是普通文案，实际: ${n1[0]}`)
  let esc = await escOf()
  assert.equal(esc.level, 0, '第 1 条还不该升级')
  assert.equal(esc.silentStreak, 1)

  // 第 2 条：streak=2 → 等级 1 → 「未响应」，阈值翻倍
  const n2 = await fire()
  assert.ok(n2[0].includes('未响应'), `连续 2 次未汇报应升级，实际: ${n2[0]}`)
  assert.ok(n2[0].includes('先输出 1-2 行文字'), '升级档要明确要求先说话')
  assert.ok(!n2[0].includes('汇报完继续执行'), '升级档不能留「继续执行」这种可跳过的措辞')
  esc = await escOf()
  assert.equal(esc.level, 1)
  assert.equal(esc.stepThreshold, 2, '步数阈值应翻倍')
  assert.equal(esc.timeThresholdSeconds, 19998, '时间阈值应翻倍')

  // 阈值已抬高：1 步不触发
  assert.equal((await fire()).length, 0, '抬高后 1 步不该触发')
  // 第 3 条（2 步触发）：streak=3 → 仍是 1 级
  const n3 = await fire()
  assert.ok(n3[0].includes('未响应'), `streak=3 仍是 1 级，实际: ${n3[0]}`)
  // 第 4 条（2 步）：streak=4 → 级别 2 → 「强制」
  assert.equal((await fire()).length, 0, '1 步不该触发')
  const n4 = await fire()
  assert.ok(n4[0].includes('强制'), `streak=4 应升到「强制」，实际: ${n4[0]}`)
  esc = await escOf()
  assert.equal(esc.level, 2)
  assert.equal(esc.stepThreshold, 4, '步数阈值应 ×4')

  // 模型汇报 → 立刻复位
  const stream = ctx.listeners.get('agent/assistant-stream')[0]
  stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '已经修好了…' } } })
  esc = await escOf()
  assert.equal(esc.silentStreak, 0, '模型汇报后沉默连击应归零')
  assert.equal(esc.level, 0, '模型汇报后等级应回 0')
  assert.equal(esc.stepThreshold, 1, '复位后阈值回到基线')

  // 复位后立即按基线触发，且文案回到普通档
  const n5 = await fire()
  assert.equal(n5.length, 1, '复位后 1 步就该能提醒')
  assert.ok(n5[0].includes('进度汇报'), '复位后应回到普通文案')
  assert.ok(!n5[0].includes('未响应') && !n5[0].includes('强制'), '复位后不该还是升级文案')

  console.log('✅ 28. 自适应退避（未汇报→「未响应/强制」+抬阈值；汇报后立刻复位回普通档）')
}

// ---------------------------------------------------------------- 29. 退避开关
{
  const ctx = makeCtx()
  apply(
    ctx,
    baseConfig({
      stepThreshold: 1,
      timeThresholdSeconds: 9999,
      minGapSeconds: 0,
      escalation: { enabled: true, afterNudges: 1, stepFactor: 2, timeFactor: 2, maxLevel: 3 },
    }),
  )
  const agent = {}
  const textsOf = (out) => (out.additionalContexts ?? []).map((m) => m.content[0].text)

  // 第一次先升级
  textsOf(await runTool(ctx, agent, 'read'))
  assert.equal((await routeCall(ctx, 'status')).body.value.escalation.level, 1)

  // 关掉「增强提醒」
  await routeCall(ctx, 'config', { escalationEnabled: false })
  const esc = (await routeCall(ctx, 'status')).body.value.escalation
  assert.equal(esc.enabled, false, '开关应关闭')
  assert.equal(esc.level, 0, '关闭后立即回到 0 级')
  assert.equal(esc.stepThreshold, 1, '关闭后阈值回到基线')

  // 关闭状态下即使继续沉默也不升级
  const n = textsOf(await runTool(ctx, agent, 'read'))
  assert.ok(n[0].includes('进度汇报'), '关闭后应始终使用普通文案')
  assert.ok(!n[0].includes('未响应'), '关闭后不该出现升级文案')

  // 再打开，覆盖标记应清掉（回到默认）
  await routeCall(ctx, 'config', { escalationEnabled: true })
  const back = (await routeCall(ctx, 'status')).body.value
  assert.equal(back.escalation.enabled, true, '开关应能重新打开')
  assert.ok(!back.overridden.includes('escalation'), '值与默认一致时不该留覆盖标记')

  console.log('✅ 29. 「增强提醒」开关（关掉立即回基线且不再升级；再打开清掉覆盖标记）')
}

// ---------------------------------------------------------------- 30. 版本号比较与响应解析
{
  const cases = [
    ['1.3.0', '1.2.1', 1],
    ['1.2.1', '1.3.0', -1],
    ['1.3.0', '1.3.0', 0],
    ['v1.3.0', '1.3.0', 0], // 前缀 v 要能吃掉
    ['1.10.0', '1.9.0', 1], // 数字比较，不是字符串比较
    ['1.2', '1.2.0', 0], // 缺段按 0 补
    ['2.0.0', '1.99.99', 1],
    ['1.3.0', '1.3.0-beta', 1], // 同号正式版 > 预发布
  ]
  for (const [left, right, expected] of cases) {
    assert.equal(compareVersions(left, right), expected, `compareVersions(${left}, ${right}) 应为 ${expected}`)
  }

  // 两种响应形状都要认
  assert.equal(extractVersion({ version: '1.4.0' }), '1.4.0', '原始 package.json 形状')
  assert.equal(
    extractVersion({ content: Buffer.from(JSON.stringify({ version: '1.5.0' })).toString('base64') }),
    '1.5.0',
    'GitHub contents API 形状（base64）',
  )
  assert.equal(extractVersion({}), null, '没有版本字段应返回 null，不能瞎猜')
  assert.equal(extractVersion({ content: '不是base64的json' }), null, '坏的 base64 应返回 null')
  assert.equal(extractVersion(null), null)

  console.log('✅ 30. 版本号比较（数字段比较 / v 前缀 / 预发布）+ 两种响应形状')
}

// ---------------------------------------------------------------- 31. 版本检测端到端
{
  const { createServer } = await import('node:http')
  // 起一个本地服务器冒充 GitHub——这样三条路径（有新版 / 同版本 / 失败）都能真跑
  let mode = 'newer'
  const server = createServer((req, res) => {
    if (mode === 'fail') {
      res.statusCode = 500
      res.end('boom')
      return
    }
    const version = mode === 'newer' ? '9.9.9' : '0.0.1'
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/package.json`

  try {
    const ctx = makeCtx()
    apply(ctx, baseConfig({ updateCheck: { enabled: true, intervalSeconds: 3600, url } }))

    // 1) 远端更新 → available
    const newer = (await routeCall(ctx, 'update')).body.value
    assert.equal(newer.status, 'ok', '查询应成功')
    assert.equal(newer.latest, '9.9.9', '应读到远端版本')
    assert.equal(newer.available, true, '远更新时应标记可更新')
    assert.equal(newer.current, newer.current.toLowerCase(), 'current 应是字符串版本号')
    assert.match(newer.current, /^\d+\.\d+\.\d+/, `本机版本应是 package.json 里的版本，实际 ${newer.current}`)

    // 2) 远端更旧 → 不可更新（等价于「已是最新」）
    mode = 'same'
    const older = (await routeCall(ctx, 'update')).body.value
    assert.equal(older.available, false, '远端更旧时不该提示更新')

    // 3) 请求失败 → 状态 failed，不崩、不猜
    mode = 'fail'
    const failed = (await routeCall(ctx, 'update')).body.value
    assert.equal(failed.status, 'failed', '失败应如实记录')
    assert.equal(failed.latest, null, '失败时不该保留旧值假装成功')
    assert.equal(failed.available, false, '失败时不能提示可更新')

    // 主快照里也要带上 update 字段
    const snapshot = (await routeCall(ctx, 'status')).body.value
    assert.equal(snapshot.update.current, newer.current, 'status 里应带版本信息')

    // 关掉后不再出网
    await routeCall(ctx, 'config', { updateCheckEnabled: false })
    const disabled = (await routeCall(ctx, 'update')).body.value
    assert.equal(disabled.status, 'disabled', '关闭后应标记 disabled')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // getJson 对非 200 要 reject（否则会把错误页当 JSON 解析）
  const bad = createServer((req, res) => {
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(() => getJson(`http://127.0.0.1:${bad.address().port}/x`, 3000), /HTTP 404/)
  } finally {
    await new Promise((resolve) => bad.close(resolve))
  }

  console.log('✅ 31. 版本检测端到端（有新版 / 更旧 / 请求失败 / 关闭 + 非 200 会 reject）')
}

console.log('\n全部通过 ✅')
