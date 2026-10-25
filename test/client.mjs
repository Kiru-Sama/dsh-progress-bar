/**
 * Client 半边渲染测试：不开浏览器、不依赖真实 react，也能验证 client.js
 * 能加载、能注册槽位、能渲染出预期的控件。
 *
 *   node test/client.mjs
 *
 * 做法：用最小 React 桩把组件函数跑一遍，拿到元素树再做结构断言。
 * hooks 只记录、不执行副作用（本测试只关心"渲染出什么"）。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// ---------------------------------------------------------------- React 桩

const hookState = { slots: [], cursor: 0 }
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    return { type, props: { ...(props ?? {}), children: flat } }
  },
  useState(initial) {
    const i = hookState.cursor++
    if (hookState.slots.length <= i) hookState.slots.push(typeof initial === 'function' ? initial() : initial)
    const setter = (next) => {
      hookState.slots[i] = typeof next === 'function' ? next(hookState.slots[i]) : next
    }
    return [hookState.slots[i], setter]
  },
  useEffect() {
    // 不占 state 槽位：本测试只做结构断言，不跑副作用。
  },
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    const i = hookState.cursor++
    if (hookState.slots.length <= i) hookState.slots.push({ current: initial })
    return hookState.slots[i]
  },
}

function render(Component, props) {
  hookState.cursor = 0
  hookState.slots.length = 0 // 每次"新渲染"都要清空，否则上一次的 state 会泄漏进来
  return Component(props ?? {})
}

/** 深度优先收集元素树（含文本节点）。 */
function collect(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  out.push(node)
  if (typeof node === 'object' && node.props) collect(node.props.children, out)
  return out
}

const textOf = (node) =>
  collect(node)
    .filter((n) => typeof n === 'string' || typeof n === 'number')
    .join(' ')

// ---------------------------------------------------------------- 环境桩

let captured = null
const windowStub = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
}
const navigatorStub = { language: 'zh-CN' }
const injectedStyle = []
const documentStub = {
  head: { appendChild: (el) => injectedStyle.push(el) },
  createElement: () => ({ style: {}, textContent: '', remove() {} }),
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
}
const fetchStub = async () => ({ json: async () => ({ ok: true, value: {} }) })

// ---------------------------------------------------------------- 加载 client.js

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', 'fetch', 'document', 'navigator', source)(
  windowStub,
  fetchStub,
  documentStub,
  navigatorStub,
)

assert.ok(captured !== null, 'client.js 应调用 __ModuleLoader__.load')
assert.equal(captured.id, 'kiru-progress-bar', '模块 id 必须等于包名')

const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`client.js 只能 require react，实际: ${name}`)
})
assert.deepEqual(mod.inject, ['slots'], 'client 应 inject slots')

// ---------------------------------------------------------------- 假 ctx

const registered = new Map()
const ctx = {
  effect(fn) {
    fn()
  },
  slots: {
    inject(_name, fn) {
      fn()
    },
    register(options, Component) {
      registered.set(options.name, { options, Component })
      return () => {}
    },
  },
}

mod.apply(ctx)

assert.ok(registered.has('sidebar.footer.action'), '应注册侧栏槽位')
assert.ok(registered.has('conversation.composer.dock'), '应注册聊天区横幅槽位')
assert.equal(registered.size, 2, `应注册两个槽位，实际 ${registered.size}`)
assert.equal(registered.get('sidebar.footer.action').options.id, 'progress-nudge')
assert.equal(registered.get('sidebar.footer.action').options.order, 165)
assert.equal(registered.get('conversation.composer.dock').options.id, 'progress-nudge')
assert.ok(
  injectedStyle.some((el) => el.textContent.includes('.pn-button')),
  '样式表应被注入',
)
assert.ok(
  injectedStyle.some((el) => el.textContent.includes('.pn-banner')),
  '横幅样式应被注入',
)

// ---- 聊天区横幅 ----
// state 槽位顺序：status(0), error(1), flash(2), hiddenSeq(3)；ref 用 4、5。
const Banner = registered.get('conversation.composer.dock').Component
const sampleNudge = {
  seq: 3,
  at: Date.UTC(2026, 9, 12, 4, 27), // 2026-10-12
  summary: 'step 10 · #2',
  text: '【进度汇报】…',
}

hookState.cursor = 0
hookState.slots.length = 0
assert.equal(Banner({}), null, '还没提醒过时横幅不应渲染')

// 常驻形态：只要提醒过，就一直显示「上次提醒 <时间>」
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { nudge: sampleNudge }
const persistent = Banner({})
const persistentNodes = collect(persistent)
assert.ok(
  persistentNodes.some((n) => n.props?.className === 'pn-banner'),
  '有历史提醒时应常驻渲染横幅',
)
const persistentText = textOf(persistent)
assert.ok(persistentText.includes('上次提醒'), `常驻横幅应写「上次提醒」，实际: ${persistentText}`)
assert.ok(/\d{1,2}月\d{1,2}日/.test(persistentText), `常驻横幅应显示日期，实际: ${persistentText}`)
assert.ok(persistentText.includes(':'), `常驻横幅应显示时间，实际: ${persistentText}`)
assert.ok(!persistentText.includes('step 10'), '未高亮时不应显示摘要')

// 高亮形态：flash = true 时换成「已提醒 … · 摘要」
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { nudge: sampleNudge }
hookState.slots[2] = true
const flashing = Banner({})
const flashingText = textOf(flashing)
assert.ok(flashingText.includes('已提醒 Agent 汇报进度'), '高亮时应说明发生了什么')
assert.ok(flashingText.includes('step 10 · #2'), '高亮时应显示提醒摘要')

// 手动关闭后藏起来，直到下一次提醒
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { nudge: sampleNudge }
hookState.slots[3] = sampleNudge.seq // hiddenSeq === seq
assert.equal(Banner({}), null, '关掉之后应藏到下一次提醒')

// ---- 越界未发（pending.due）：没有历史提醒也要显示 ----
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { nudge: null, pending: { due: true, overSeconds: 224 } }
const overdueTree = Banner({})
const overdueText = textOf(overdueTree)
assert.ok(overdueText.includes('已到期'), `越界时应提示已到期，实际: ${overdueText}`)
assert.ok(overdueText.includes('224'), `应报出超出秒数，实际: ${overdueText}`)
assert.ok(overdueText.includes('等当前步骤结束后提醒'), '应说明为什么还没发')
assert.ok(
  collect(overdueTree).some((n) => n.props?.className?.includes('is-overdue')),
  '越界状态应带 is-overdue 样式',
)
assert.ok(
  !collect(overdueTree).some((n) => n.type === 'button'),
  '没有历史提醒时，越界横幅不该有关闭按钮（避免被当成"没有提醒"）',
)

// 越界时即使手动关过，也必须继续显示（它是"待发"状态，不是历史）
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { nudge: sampleNudge, pending: { due: true, overSeconds: 130 } }
hookState.slots[3] = sampleNudge.seq
assert.ok(textOf(Banner({})).includes('已到期'), '越界优先于手动关闭')

// ---------------------------------------------------------------- 余额：低额与恢复
{
  // 低额横幅显示的数字必须跟判定口径一致（有赠金时充值余额 ≠ 可用总额）
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[0] = {
    nudge: null,
    balance: { enabled: true, status: 'ok', low: true, scope: 'total', text: '¥0.50', totalText: '¥0.80', thresholdCny: 1.5 },
  }
  const lowTree = Banner({})
  const lowText = textOf(lowTree)
  assert.ok(lowText.includes('余额不足'), `低额应提示，实际: ${lowText}`)
  assert.ok(lowText.includes('¥0.80'), `scope=total 时应显示可用总额，实际: ${lowText}`)
  assert.ok(!lowText.includes('¥0.50'), `不该显示充值余额（口径是 total），实际: ${lowText}`)
  assert.ok(lowText.includes('可用余额 ≤ ¥1.5'), `应写明口径与阈值，实际: ${lowText}`)

  // scope=recharge 时反过来显示充值余额
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[0] = {
    nudge: null,
    balance: { enabled: true, status: 'ok', low: true, scope: 'recharge', text: '¥0.50', totalText: '¥0.80', thresholdCny: 1.5 },
  }
  const rechargeText = textOf(Banner({}))
  assert.ok(rechargeText.includes('¥0.50'), `scope=recharge 时应显示充值余额，实际: ${rechargeText}`)
  assert.ok(rechargeText.includes('充值 ≤ ¥1.5'), `口径标签应跟着变，实际: ${rechargeText}`)

  // 刚充值恢复 → 绿色确认
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[0] = {
    nudge: null,
    balance: {
      enabled: true,
      status: 'ok',
      low: false,
      scope: 'total',
      text: '¥11.45',
      totalText: '¥11.45',
      thresholdCny: 1.5,
      lastRecovery: { seq: 1, at: Date.now(), totalText: '¥11.45', threshold: 1.5 },
    },
  }
  const restoredTree = Banner({})
  const restoredText = textOf(restoredTree)
  assert.ok(restoredText.includes('余额已恢复'), `充值后应给绿色确认，实际: ${restoredText}`)
  assert.ok(restoredText.includes('¥11.45'), `确认里应带新的余额，实际: ${restoredText}`)
  assert.ok(restoredText.includes('可用余额 > ¥1.5'), `应说明已高于阈值，实际: ${restoredText}`)
  assert.ok(
    collect(restoredTree).some((n) => n.props?.className?.includes('is-ok')),
    '恢复确认应带 is-ok 配色',
  )

  // 恢复确认只闪一小会儿，过期后横幅应当消失
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[0] = {
    nudge: null,
    balance: {
      enabled: true,
      status: 'ok',
      low: false,
      scope: 'total',
      totalText: '¥11.45',
      thresholdCny: 1.5,
      lastRecovery: { seq: 1, at: Date.now() - 60_000, totalText: '¥11.45', threshold: 1.5 },
    },
  }
  assert.equal(Banner({}), null, '恢复确认过期后不该继续占地方')
}

// ---------------------------------------------------------------- 渲染断言

const Panel = registered.get('sidebar.footer.action').Component

// 峰谷标签常驻在按钮上（中文是那个谐音梗）
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = {
  effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
  live: { steps: 3, seconds: 12, running: true },
  tariff: {
    enabled: true,
    offPeak: false,
    label: '梁文峰',
    peakHoursText: '工作日 09:00–12:00 / 14:00–18:00',
    nextChangeAt: Date.now() + 3600_000,
    nextLabel: '梁文谷',
    holidaysCount: 0,
  },
  stats: {},
}
const peakPanel = Panel({ wide: true })
const peakText = textOf(peakPanel)
assert.ok(peakText.includes('梁文峰'), `高峰时应常驻显示「梁文峰」，实际: ${peakText}`)
assert.ok(
  collect(peakPanel).some((n) => n.props?.className?.includes('pn-tariff') && n.props.className.includes('is-peak')),
  '高峰时标签应带 is-peak 配色',
)
assert.ok(
  String(collect(peakPanel).find((n) => n.type === 'button')?.props?.title ?? '').includes('工作日 09:00–12:00'),
  '按钮 tooltip 应写明官方高峰窗口',
)

// 时段标签必须在**最右边**：按钮里它要排在计量文字之后
{
  const button = collect(peakPanel).find((n) => n.type === 'button')
  const children = (button.props.children ?? []).flat().filter(Boolean)
  const labelIndex = children.findIndex((c) => c.props?.className === 'pn-label')
  const tariffIndex = children.findIndex((c) => c.props?.className?.includes('pn-tariff'))
  assert.ok(labelIndex >= 0 && tariffIndex >= 0, '按钮里应同时有计量与时段标签')
  assert.ok(tariffIndex > labelIndex, `时段标签应排在计量之后（最右），实际 label@${labelIndex} tariff@${tariffIndex}`)
}

// 高峰=红色发光，低谷=绿色
{
  // 直接在整份源码里找规则——别按索引切片，STYLE 与 api 的先后顺序一改切片就空了。
  const peakRule = (/\.pn-tariff\.is-peak\s*\{[^}]*\}/.exec(source) ?? [''])[0]
  assert.ok(peakRule.includes('#ff4d4f'), `高峰应使用红色，实际规则: ${peakRule}`)
  assert.ok(/text-shadow/.test(peakRule), '高峰应带发光光晕（text-shadow）')
  const offRule = (/\.pn-tariff\.is-off\s*\{[^}]*\}/.exec(source) ?? [''])[0]
  assert.ok(/state-success-primary/.test(offRule), `低谷应使用成功色（绿），实际规则: ${offRule}`)
  assert.ok(
    /\.pn-tariff\s*\{[^}]*margin-left:\s*auto/.test(source),
    '时段标签应靠 margin-left:auto 顶到最右边',
  )
  // 宿主侧栏按钮继承了 text-align:center，会把计量文字挤到中间 —— 必须显式左对齐
  const labelRule = (/\.pn-label\s*\{[^}]*\}/.exec(source) ?? [''])[0]
  assert.ok(/text-align:\s*left/.test(labelRule), `计量必须贴着绿点左对齐，实际规则: ${labelRule}`)
  const buttonRule = (/\.pn-button\s*\{[^}]*\}/.exec(source) ?? [''])[0]
  assert.ok(/text-align:\s*left/.test(buttonRule), `按钮也要显式左对齐，实际规则: ${buttonRule}`)
}

// 低谷换成「梁文谷」+ 绿色
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = {
  effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
  live: { steps: 3, seconds: 12, running: true },
  tariff: {
    enabled: true,
    offPeak: true,
    label: '梁文谷',
    peakHoursText: '工作日 09:00–12:00 / 14:00–18:00',
    nextChangeAt: Date.now() + 1800_000,
    nextLabel: '梁文峰',
    holidaysCount: 0,
  },
  stats: {},
}
const offPanel = Panel({ wide: true })
assert.ok(textOf(offPanel).includes('梁文谷'), `低谷时应显示「梁文谷」，实际: ${textOf(offPanel)}`)
assert.ok(
  collect(offPanel).some(
    (n) => n.props?.className?.includes('pn-tariff') && n.props.className.includes('is-off'),
  ),
  '低谷时标签应带 is-off 配色',
)

// 关掉时段指示时不该显示
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[0] = { effective: { stepThreshold: 10, timeThresholdSeconds: 120 }, live: null, tariff: { enabled: false }, stats: {} }
assert.ok(!textOf(Panel({ wide: true })).includes('梁文'), '关闭时段指示后不该出现峰谷标签')

const panel = render(Panel, { wide: true })
const panelNodes = collect(panel)
const buttons = panelNodes.filter((n) => n.type === 'button')
assert.equal(buttons.length, 1, '折叠状态下应只有 1 个按钮')
assert.ok(textOf(panel).length > 0, '按钮上应有文字')

// 展开面板：state 槽位顺序是 status, error, open, anchor, now, steps, secs
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[2] = true // open = true
// 给一份带余额的快照，顺带验证余额行
hookState.slots[0] = {
  effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
  live: { steps: 3, seconds: 12, running: true },
  balance: { enabled: true, status: 'ok', text: '¥8.35', amount: 8.35, low: false, thresholdCny: 1.5 },
  tariff: {
    enabled: true,
    offPeak: false,
    label: '梁文峰',
    peakHoursText: '工作日 09:00–12:00 / 14:00–18:00',
    nextChangeAt: Date.now() + 3600_000,
    nextLabel: '梁文谷',
    holidaysCount: 0,
  },
  stats: { nudges: 1, spoke: 2 },
}
const panelOpen = Panel({ wide: true })
const openNodes = collect(panelOpen)
const openButtons = openNodes.filter((n) => n.type === 'button')
// 1 个侧栏按钮 + 「暂停/恢复」+「恢复默认」+ 余额行的 ↻ + 「增强提醒」开关
assert.equal(openButtons.length, 5, `展开面板应为 1 个侧栏按钮 + 4 个面板按钮，实际 ${openButtons.length}`)
assert.ok(
  openButtons.some((n) => n.props?.title === '刷新'),
  '余额行应有刷新按钮',
)
assert.ok(
  openButtons.some((n) => String(n.props?.title ?? '').includes('连续几次提醒都没换来汇报')),
  '应有「增强提醒」开关（tooltip 说明作用）',
)
const inputs = openNodes.filter((n) => n.type === 'input')
assert.equal(inputs.length, 3, `面板应有三个输入框（步数/秒数/余额阈值），实际 ${inputs.length}`)
assert.equal(inputs[0].props.type, 'number')
assert.equal(inputs[1].props.type, 'number')
assert.equal(inputs[2].props.type, 'number')
assert.ok(typeof inputs[0].props.onChange === 'function', '步数输入框应绑定 onChange')
assert.ok(typeof inputs[1].props.onChange === 'function', '时间输入框应绑定 onChange')
assert.ok(typeof inputs[2].props.onChange === 'function', '余额阈值输入框应绑定 onChange')
assert.ok(textOf(panelOpen).includes('余额低于多少提醒'), '面板里应有余额阈值标签')
assert.ok(textOf(panelOpen).includes('每多少步提醒一次'), '面板里应有步数阈值标签')
assert.ok(textOf(panelOpen).includes('间隔多少秒提醒一次'), '面板里应有时间阈值标签')
assert.ok(textOf(panelOpen).includes('恢复默认'), '面板里应有恢复默认按钮')
assert.ok(textOf(panelOpen).includes('改完立即生效'), '面板应说明输入即生效')
assert.ok(!textOf(panelOpen).includes('保存'), '不该再有保存按钮（输入即生效）')
assert.ok(textOf(panelOpen).includes('余额'), '面板里应有余额行')
assert.ok(textOf(panelOpen).includes('¥8.35'), '余额行应显示宿主给的余额')
assert.ok(!textOf(panelOpen).includes('余额不足'), '余额充足时不该显示「余额不足」')
assert.ok(textOf(panelOpen).includes('时段'), '面板里应有峰谷时段行')
assert.ok(textOf(panelOpen).includes('梁文峰'), '面板里应显示当前时段标签')
assert.ok(textOf(panelOpen).includes('高峰·原价'), '面板应说明高峰是原价')
assert.ok(textOf(panelOpen).includes('下一次切换'), '面板应给出下一次切换')
assert.ok(textOf(panelOpen).includes('梁文谷'), '面板应预告下一次切到哪')

// ---------------------------------------------------------------- 增强提醒（自适应退避）
{
  // 未升级：显示「正常」，进度按基线阈值
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[2] = true
  hookState.slots[0] = {
    effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
    live: { steps: 3, seconds: 40, running: true },
    escalation: { enabled: true, active: false, level: 0, silentStreak: 1, afterNudges: 2, stepThreshold: 10, timeThresholdSeconds: 120 },
    stats: {},
  }
  const idleText = textOf(Panel({ wide: true }))
  assert.ok(idleText.includes('增强提醒'), `面板应有增强提醒行，实际: ${idleText}`)
  assert.ok(idleText.includes('正常：按设定阈值提醒'), `未升级时应说明是正常档，实际: ${idleText}`)
  assert.ok(idleText.includes('3 / 10'), `进度应按基线阈值显示，实际: ${idleText}`)

  // 已升级到 2 级：显示等级、沉默次数、放大后的阈值，且进度条按放大阈值
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[2] = true
  hookState.slots[0] = {
    effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
    live: { steps: 3, seconds: 40, running: true },
    escalation: {
      enabled: true,
      active: true,
      level: 2,
      silentStreak: 4,
      afterNudges: 2,
      stepThreshold: 40,
      timeThresholdSeconds: 480,
    },
    stats: {},
  }
  const escalatedTree = Panel({ wide: true })
  const escalatedText = textOf(escalatedTree)
  assert.ok(escalatedText.includes('已升级 2'), `应显示当前等级，实际: ${escalatedText}`)
  assert.ok(escalatedText.includes('4 连续未汇报'), `应显示连续未汇报次数，实际: ${escalatedText}`)
  assert.ok(escalatedText.includes('40步'), `应显示放大后的步数阈值，实际: ${escalatedText}`)
  assert.ok(escalatedText.includes('480秒'), `应显示放大后的时间阈值，实际: ${escalatedText}`)
  assert.ok(escalatedText.includes('3 / 40'), `进度条必须按放大后的阈值，实际: ${escalatedText}`)
  assert.ok(
    collect(escalatedTree).some((n) => n.props?.className?.includes('pn-sub') && n.props.className.includes('is-warn')),
    '升级状态应带警示配色',
  )

  // 开关关闭：写明「关着：始终按固定阈值提醒」
  hookState.cursor = 0
  hookState.slots.length = 0
  hookState.slots[2] = true
  hookState.slots[0] = {
    effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
    live: { steps: 3, seconds: 40, running: true },
    escalation: { enabled: false, active: false, level: 0, silentStreak: 0, stepThreshold: 10, timeThresholdSeconds: 120 },
    stats: {},
  }
  const offEscText = textOf(Panel({ wide: true }))
  assert.ok(offEscText.includes('关着：始终按固定阈值提醒'), `关闭时应明说，实际: ${offEscText}`)
  assert.ok(offEscText.includes('3 / 10'), `关闭后退避不生效，仍按基线阈值，实际: ${offEscText}`)
}


// 余额低于阈值：面板要标警示
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[2] = true
hookState.slots[0] = {
  effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
  live: { steps: 0, seconds: 0, running: true },
  balance: { enabled: true, status: 'ok', text: '¥1.20', amount: 1.2, low: true, thresholdCny: 1.5 },
  stats: {},
}
const lowPanel = textOf(Panel({ wide: true }))
assert.ok(lowPanel.includes('余额不足'), `低额时面板应提示，实际: ${lowPanel}`)

// 宿主没有账户服务时的显示
hookState.cursor = 0
hookState.slots.length = 0
hookState.slots[2] = true
hookState.slots[0] = {
  effective: { stepThreshold: 10, timeThresholdSeconds: 120 },
  live: { steps: 0, seconds: 0, running: true },
  balance: { enabled: true, status: 'unavailable' },
  stats: {},
}
assert.ok(textOf(Panel({ wide: true })).includes('不可用'), '服务不可用时应明说')

// 用到的文案键必须都在字典里定义（否则界面上会出现 undefined）
{
  const zh = source.slice(source.indexOf('const ZH = {'), source.indexOf('const EN = {'))
  const defined = new Set([...zh.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]))
  const used = new Set([...source.matchAll(/\bt\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
  const missing = [...used].filter((key) => !defined.has(key))
  assert.deepEqual(missing, [], `用到但未定义的文案键: ${missing.join(', ')}`)
  console.log(`  文案键检查：用了 ${used.size} 个，均已定义`)
}

console.log('✅ client.js：加载 / 槽位注册 / 面板渲染结构 全部通过（无保存键、无设置页卡片）')
