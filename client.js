/**
 * Browser half of kiru-progress-bar.
 *
 * 只贡献一个界面，数据来自 Host 侧 `/progress-nudge/api` 路由：
 *
 * - `sidebar.footer.action` —— 侧栏按钮，显示「第 N/阈值 步」与已过秒数；
 *   点开是面板：两条进度条、阈值输入框（**输入即生效，没有保存键**）、
 *   暂停/恢复、恢复默认、已提醒与已汇报次数。
 *
 * 手写在 `__ModuleLoader__` 闭包格式里，所以本包**不需要构建步骤**；
 * `require()` 只能拿到平台种子（react）。样式内联在 dsh 设计 token
 * （`--dsw-alias-*`）上，自动跟随明暗主题。
 */
window.__ModuleLoader__.load({
  id: 'kiru-progress-bar',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, createElement: h } = React
    const NS = 'progress-nudge'
    const API = '/progress-nudge/api'

    const ZH = {
      title: '进度汇报提醒',
      panelTitle: '进度汇报',
      steps: '步数',
      elapsed: '距上次汇报',
      nudges: '已提醒',
      pausing: '已暂停',
      paused: '已暂停提醒（计时冻结）',
      stopped: '回合已结束，计时停止',
      resume: '恢复提醒',
      pause: '暂停提醒',
      stepLabel: '每多少步提醒一次',
      timeLabel: '间隔多少秒提醒一次',
      unitSteps: '步',
      unitSeconds: '秒',
      reset: '恢复默认',
      error: '读取失败',
      seconds: '秒',
      quickSettings: '参数（改完立即生效）',
      spoken: '已汇报',
      nudgeFired: '已提醒 Agent 汇报进度',
      lastNudge: '上次提醒',
      overdue: '已到期',
      waitStep: '等当前步骤结束后提醒',
      blocked: '已达上限，本回合不再提醒',
      balance: '可用余额',
      balanceRecharge: '充值',
      balanceBonus: '赠送',
      balanceOff: '未开启',
      balanceUnknown: '查询中…',
      balanceUnavailable: '不可用',
      balanceFailed: '查询失败',
      balanceLow: '余额不足',
      balanceRestored: '余额已恢复',
      balanceLabel: '余额低于多少提醒',
      tariff: '时段',
      tariffPeak: '高峰·原价',
      tariffOff: '低谷·半价',
      tariffNext: '下一次切换',
      tariffHolidaysHint: '未配置节假日，仅按周末与时段判断',
      refresh: '刷新',
      dismiss: '关闭',
    }
    const EN = {
      title: 'Progress nudge',
      panelTitle: 'Progress report',
      steps: 'Steps',
      elapsed: 'Since last report',
      nudges: 'Nudges',
      pausing: 'Paused',
      paused: 'Nudges paused (clock frozen)',
      stopped: 'Turn ended, clock stopped',
      resume: 'Resume',
      pause: 'Pause',
      stepLabel: 'Remind every N steps',
      timeLabel: 'Remind after N seconds',
      unitSteps: 'steps',
      unitSeconds: 's',
      reset: 'Reset to defaults',
      error: 'Failed to load',
      seconds: 's',
      quickSettings: 'Thresholds (applied live)',
      spoken: 'Reports',
      nudgeFired: 'Asked the agent to report progress',
      lastNudge: 'Last nudge',
      overdue: 'Due',
      waitStep: 'reminder lands when the current step ends',
      blocked: 'Per-turn cap reached, no more nudges this turn',
      balance: 'Balance',
      balanceOff: 'off',
      balanceUnknown: 'checking…',
      balanceUnavailable: 'unavailable',
      balanceFailed: 'query failed',
      balanceLow: 'Low balance',
      balanceRestored: 'Balance restored',
      balanceLabel: 'Warn below this balance',
      balanceRecharge: 'recharge',
      balanceBonus: 'bonus',
      tariff: 'Period',
      tariffPeak: 'peak · full price',
      tariffOff: 'off-peak · half price',
      tariffNext: 'Next switch',
      tariffHolidaysHint: 'No holidays configured; weekday/weekend only',
      refresh: 'Refresh',
      dismiss: 'Dismiss',
    }
    const IS_ZH = String(navigator.language ?? '').toLowerCase().startsWith('zh')
    const t = IS_ZH ? ZH : EN

    /** `10月12日 12:27` 这种短时间，给常驻横幅用。时间来自宿主，不是浏览器。 */
    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      try {
        return new Intl.DateTimeFormat(IS_ZH ? 'zh-CN' : undefined, {
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms))
      } catch {
        return new Date(ms).toLocaleString()
      }
    }

    /** 峰谷时段用的北京时间偏移。全按 UTC 读，避免受浏览器时区影响。 */
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

    /** 把时刻显示成北京时间的 `HH:MM`。 */
    function formatBeijingClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const d = new Date(ms + BEIJING_OFFSET_MS)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    }

    /** 「还有 1 小时 3 分」这种相对时间。 */
    function formatUntil(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const minutes = Math.round(Math.max(0, ms - Date.now()) / 60_000)
      if (minutes < 1) return IS_ZH ? '不到 1 分钟' : '<1 min'
      if (minutes < 60) return IS_ZH ? `${minutes} 分钟` : `${minutes} min`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (IS_ZH) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
      return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
    }

    async function api(method, body) {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json()
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error?.code ?? `HTTP ${response.status}`)
      }
      return payload.value
    }

    const STYLE = `
.pn-root { display: contents; }
.pn-button {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px 8px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 18px;
  /* ⚠️ 必须显式左对齐：宿主侧栏按钮继承了 text-align:center，
     否则计量文字会在自己那块空间里居中，看着离绿点很远。 */
  text-align: left;
}
.pn-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pn-button.is-paused { color: var(--dsw-alias-state-warn-label); }
.pn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
.pn-dot.is-paused { background: var(--dsw-alias-state-warn-label); }
/* 标签占满中间，把时段标签挤到最右边；过长时省略号，不会把右边的标签顶出去。
   文字贴着绿点（左对齐），只有块本身会被撑开。 */
.pn-label {
  flex: 1 1 auto; min-width: 0; text-align: left;
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pn-pop {
  position: fixed; z-index: 2147483000; width: 264px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); padding: 12px; font-size: 12px;
}
.pn-pop h4 { margin: 0 0 10px; font-size: 12px; font-weight: 600; }
.pn-row { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.pn-row span:last-child { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.pn-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2); overflow: hidden; margin: 0 0 10px; }
.pn-bar > i { display: block; height: 100%; background: var(--dsw-alias-state-business-primary); }
.pn-actions { display: flex; gap: 8px; margin-top: 10px; }
.pn-actions button {
  flex: 1; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary);
}
.pn-actions button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pn-actions button.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.pn-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px;
  color: var(--dsw-alias-label-primary); font-size: 13px;
}
.pn-card h3 { margin: 0 0 6px; font-size: 14px; }
.pn-card p { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pn-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.pn-field input {
  width: 88px; padding: 4px 6px; border-radius: 6px; text-align: right;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px;
}
.pn-foot { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.pn-foot button {
  padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-primary);
}
.pn-foot button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pn-status { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.pn-status.is-error { color: var(--dsw-alias-state-error-primary); }
.pn-status.is-warn { color: var(--dsw-alias-state-warn-label); }
.pn-status.is-ok { color: var(--dsw-alias-state-success-primary); }
/* 面板里的高峰值：同一个红，但不加光晕——密集文字里发光会糊 */
.pn-peak-text { color: #ff4d4f; font-weight: 600; }
/* 峰谷时段标签：常驻最右边。高峰红色发光（贵，提醒你），低谷绿色（省钱）。 */
.pn-tariff {
  flex: none; margin-left: auto; padding-left: 6px;
  font-size: 12px; font-weight: 600; line-height: 1;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.pn-tariff.is-peak {
  color: #ff4d4f;
  /* 两层光晕：近处收紧、远处散开，看着才有"发光"而不是"糊" */
  text-shadow:
    0 0 4px rgba(255, 77, 79, 0.9),
    0 0 9px rgba(255, 77, 79, 0.55),
    0 0 18px rgba(255, 77, 79, 0.3);
}
.pn-tariff.is-off { color: var(--dsw-alias-state-success-primary); }
.pn-mini {
  border: none; background: transparent; cursor: pointer; padding: 0 2px;
  color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1;
}
.pn-mini:hover { color: var(--dsw-alias-label-primary); }
.pn-sub {
  margin: -2px 0 6px; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
}
.pn-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 10px 0; }
.pn-banner {
  display: flex; align-items: center; gap: 8px;
  margin: 6px auto; padding: 6px 10px; max-width: 720px; width: fit-content;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 18px;
  box-shadow: 0 4px 14px rgba(0,0,0,.12);
}
/* 新提醒到达时的高亮形态：12 秒后回落成常驻的低调样式 */
.pn-banner.is-flash {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-state-business-primary);
  animation: pn-banner-in .18s ease-out;
}
.pn-banner.is-flash i { background: var(--dsw-alias-state-business-primary); }
/* 已越过阈值、提醒还欠着（等步骤边界）——用警示色告诉用户"它在等" */
.pn-banner.is-overdue {
  color: var(--dsw-alias-state-warn-label);
  border-color: var(--dsw-alias-state-warn-label);
}
.pn-banner.is-overdue i { background: var(--dsw-alias-state-warn-label); }
/* 余额刚恢复：绿色确认，说明插件已识别并把结果告知模型 */
.pn-banner.is-ok {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.pn-banner.is-ok i { background: var(--dsw-alias-state-success-primary); }
@keyframes pn-banner-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.pn-banner i {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-border-l2);
}
.pn-banner-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pn-banner-text b { font-weight: 600; }
.pn-banner-close {
  border: none; background: transparent; cursor: pointer; padding: 0 2px;
  color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 1;
}
.pn-banner-close:hover { color: var(--dsw-alias-label-primary); }
`

    function useStatus(intervalMs) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const load = useCallback(async () => {
        try {
          // 记下拿到快照的本地时刻，面板据此在两次轮询之间做秒数插值。
          setStatus({ ...(await api('status')), fetchedAt: Date.now() })
          setError(null)
        } catch (failure) {
          setError(String(failure.message ?? failure))
        }
      }, [])
      useEffect(() => {
        void load()
        const timer = window.setInterval(() => {
          if (!document.hidden) void load()
        }, intervalMs)
        document.addEventListener('visibilitychange', load)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', load)
        }
      }, [load, intervalMs])
      return { status, error, load }
    }

    const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)))

    /** 侧栏按钮 + 展开面板。槽位会传入 `{ wide }`。 */
    function createPanel() {
      return function ProgressPanel({ wide }) {
        const { status, error, load } = useStatus(4000)
        const [open, setOpen] = useState(false)
        const [anchor, setAnchor] = useState(null)
        const [now, setNow] = useState(() => Date.now())
        const [steps, setSteps] = useState('')
        const [secs, setSecs] = useState('')
        const [bal, setBal] = useState('')
        const buttonRef = useRef(null)
        /** 输入框是否已经用主机快照初始化过（之后不再被轮询覆盖）。 */
        const syncedRef = useRef(false)
        /** 输入即生效的防抖定时器。 */
        const debounceRef = useRef(null)

        // 本地秒表：用来在两次轮询之间做插值（只在时钟真的在走时使用）。
        useEffect(() => {
          const timer = window.setInterval(() => setNow(Date.now()), 1000)
          return () => window.clearInterval(timer)
        }, [])

        useEffect(() => {
          if (!open) return undefined
          const close = (event) => {
            if (buttonRef.current?.contains(event.target)) return
            if (event.target?.closest?.('.pn-pop')) return
            setOpen(false)
          }
          document.addEventListener('mousedown', close)
          return () => document.removeEventListener('mousedown', close)
        }, [open])

        const live = status?.live ?? null
        const stepTarget = status?.effective?.stepThreshold ?? 10
        const timeTarget = status?.effective?.timeThresholdSeconds ?? 120
        const enabled = status?.enabled !== false
        /** 时钟是否在走：暂停或回合结束都会是 false，此时主机给的秒数是定值。 */
        const running = enabled && live?.running === true
        const drift = running && status?.fetchedAt ? (now - status.fetchedAt) / 1000 : 0
        const seconds = Math.max(0, Math.round((live?.seconds ?? 0) + drift))
        const idle = enabled && live !== null && live.running !== true && live.steps === 0

        // 输入框只在第一次拿到快照时同步一次，之后交给用户，
        // 否则轮询会把正在输入的数字覆盖掉。点「恢复默认」时再强制同步。
        useEffect(() => {
          if (status === null) return
          if (syncedRef.current) return
          syncedRef.current = true
          setSteps(String(status.effective.stepThreshold))
          setSecs(String(status.effective.timeThresholdSeconds))
          if (status.balance) setBal(String(status.balance.thresholdCny))
        }, [status])

        const apply = async (patch) => {
          try {
            await api('config', patch)
            await load()
          } catch {
            /* 面板保持上一次状态，错误会在下一次轮询里显现 */
          }
        }

        /** 输入即生效：防抖 350ms，避免每敲一个数字就打一次接口。 */
        const commitLater = (patch) => {
          if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
          debounceRef.current = window.setTimeout(() => {
            debounceRef.current = null
            void apply(patch)
          }, 350)
        }

        const onStepsInput = (value) => {
          setSteps(value)
          const parsed = Number(value)
          if (Number.isFinite(parsed) && parsed >= 1) {
            commitLater({ stepThreshold: clamp(parsed, 1, 10000) })
          }
        }

        const onSecsInput = (value) => {
          setSecs(value)
          const parsed = Number(value)
          if (Number.isFinite(parsed) && parsed >= 5) {
            commitLater({ timeThresholdSeconds: clamp(parsed, 5, 86400) })
          }
        }

        const onBalInput = (value) => {
          setBal(value)
          const parsed = Number(value)
          if (Number.isFinite(parsed) && parsed >= 0) {
            commitLater({ balanceThresholdCny: clamp(parsed, 0, 100000) })
          }
        }

        const toggle = () => apply({ enabled: !enabled })

        /** 手动刷一次余额（面板上那个 ↻）。 */
        const refreshBalance = async () => {
          try {
            await api('balance')
            await load()
          } catch {
            /* 同上：错误由轮询显示 */
          }
        }

        // 打开面板就顺手刷一次余额——不然显示的可能是几分钟前的旧数。
        useEffect(() => {
          if (!open) return
          void refreshBalance()
          // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在「打开」这一下触发
        }, [open])

        const reset = async () => {
          try {
            await api('reset')
            syncedRef.current = false // 让输入框回到默认值
            await load()
          } catch {
            /* 同上 */
          }
        }

        const openPanel = () => {
          const rect = buttonRef.current?.getBoundingClientRect()
          setAnchor(rect ? { left: rect.left, bottom: window.innerHeight - rect.top + 8 } : null)
          setOpen((value) => !value)
        }

        const label = !enabled
          ? t.pausing
          : live === null
            ? t.title
            : `${live.steps}/${stepTarget} · ${seconds}${t.unitSeconds}`

        // 峰谷时段：常驻显示。中文用那个谐音梗（梁文峰/梁文谷），英文直说。
        const tariff = status?.tariff ?? null
        const tariffOn = tariff?.enabled === true
        const tariffTitle = tariffOn
          ? [
              `${tariff.label}｜${tariff.offPeak ? t.tariffOff : t.tariffPeak}`,
              `高峰：${tariff.peakHoursText}（北京时间）`,
              tariff.nextChangeAt ? `${t.tariffNext}：${formatBeijingClock(tariff.nextChangeAt)} → ${tariff.nextLabel}（还有 ${formatUntil(tariff.nextChangeAt)}）` : '',
              tariff.holidaysCount === 0 ? t.tariffHolidaysHint : '',
            ]
              .filter((line) => line !== '')
              .join('\n')
          : ''

        return h(
          'div',
          { className: 'pn-root' },
          h(
            'button',
            {
              ref: buttonRef,
              type: 'button',
              className: `pn-button${enabled ? '' : ' is-paused'}`,
              title: tariffTitle || t.panelTitle,
              onClick: openPanel,
            },
            h('i', { className: `pn-dot${enabled ? '' : ' is-paused'}` }),
            // 计量在中间，时段标签靠 margin-left:auto 顶到最右边
            h('span', { className: 'pn-label' }, wide === false ? `${live?.steps ?? 0}` : label),
            tariffOn
              ? h(
                  'span',
                  { className: `pn-tariff${tariff.offPeak ? ' is-off' : ' is-peak'}` },
                  tariff.label,
                )
              : null,
          ),
          open
            ? h(
                'div',
                {
                  className: 'pn-pop',
                  style: anchor
                    ? { left: `${Math.max(8, anchor.left)}px`, bottom: `${anchor.bottom}px` }
                    : { left: '16px', bottom: '16px' },
                },
                h('h4', null, t.panelTitle),
                error !== null
                  ? h('div', { className: 'pn-status is-error' }, `${t.error}: ${error}`)
                  : null,
                h(
                  'div',
                  { className: 'pn-row' },
                  h('span', null, t.steps),
                  h('span', null, `${live?.steps ?? 0} / ${stepTarget}`),
                ),
                h(
                  'div',
                  { className: 'pn-bar' },
                  h('i', {
                    style: {
                      width: `${clamp(((live?.steps ?? 0) / Math.max(1, stepTarget)) * 100, 0, 100)}%`,
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'pn-row' },
                  h('span', null, t.elapsed),
                  h('span', null, `${seconds} / ${timeTarget}${t.unitSeconds}`),
                ),
                h(
                  'div',
                  { className: 'pn-bar' },
                  h('i', {
                    style: {
                      width: `${clamp((seconds / Math.max(1, timeTarget)) * 100, 0, 100)}%`,
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'pn-row' },
                  h('span', null, t.nudges),
                  h('span', null, `${status?.stats?.nudges ?? 0} · ${t.spoken} ${status?.stats?.spoke ?? 0}`),
                ),
                // 余额（来自宿主的 deepseekAccount 服务）
                h(
                  'div',
                  { className: 'pn-row' },
                  h('span', null, t.balance),
                  h(
                    'span',
                    { className: status?.balance?.low ? 'is-warn' : '' },
                    balanceText(status?.balance),
                    ' ',
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'pn-mini',
                        title: t.refresh,
                        onClick: () => void refreshBalance(),
                      },
                      '↻',
                    ),
                  ),
                ),
                balanceBreakdown(status?.balance) !== null
                  ? h('div', { className: 'pn-sub' }, balanceBreakdown(status?.balance))
                  : null,
                // 峰谷时段（官方口径：工作日 09:00–12:00 / 14:00–18:00 为高峰）
                status?.tariff?.enabled === true
                  ? h(
                      'div',
                      { className: 'pn-row' },
                      h('span', null, t.tariff),
                      h(
                        'span',
                        { className: status.tariff.offPeak ? 'is-ok' : 'pn-peak-text' },
                        `${status.tariff.label}（${status.tariff.offPeak ? t.tariffOff : t.tariffPeak}）`,
                      ),
                    )
                  : null,
                status?.tariff?.enabled === true
                  ? h('div', { className: 'pn-sub' }, `高峰：${status.tariff.peakHoursText}（北京时间）`)
                  : null,
                status?.tariff?.enabled === true && status.tariff.nextChangeAt !== null
                  ? h(
                      'div',
                      { className: 'pn-sub' },
                      `${t.tariffNext}：${formatBeijingClock(status.tariff.nextChangeAt)} → ${status.tariff.nextLabel}（还有 ${formatUntil(status.tariff.nextChangeAt)}）`,
                    )
                  : null,
                !enabled ? h('div', { className: 'pn-status' }, t.paused) : null,
                enabled && idle ? h('div', { className: 'pn-status' }, t.stopped) : null,
                // 越过阈值但还没发出（要等步骤边界）——必须说出来，否则像坏了
                status?.pending?.due === true
                  ? h(
                      'div',
                      { className: 'pn-status is-warn' },
                      `${t.overdue} ${status.pending.overSeconds}${t.unitSeconds} · ${t.waitStep}`,
                    )
                  : null,
                status?.pending?.blocked === true
                  ? h('div', { className: 'pn-status' }, t.blocked)
                  : null,
                // 参数就在面板里调，不用去设置页翻。
                h('div', { className: 'pn-sep' }),
                h('div', { className: 'pn-status' }, t.quickSettings),
                h(
                  'div',
                  { className: 'pn-field' },
                  h('label', { htmlFor: `${NS}-p-steps` }, t.stepLabel),
                  h('input', {
                    id: `${NS}-p-steps`,
                    type: 'number',
                    min: 1,
                    max: 10000,
                    value: steps,
                    onChange: (event) => onStepsInput(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'pn-field' },
                  h('label', { htmlFor: `${NS}-p-secs` }, t.timeLabel),
                  h('input', {
                    id: `${NS}-p-secs`,
                    type: 'number',
                    min: 5,
                    max: 86400,
                    value: secs,
                    onChange: (event) => onSecsInput(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'pn-field' },
                  h('label', { htmlFor: `${NS}-p-bal` }, `${t.balanceLabel}（元）`),
                  h('input', {
                    id: `${NS}-p-bal`,
                    type: 'number',
                    min: 0,
                    step: '0.5',
                    value: bal,
                    disabled: status?.balance?.enabled === false,
                    onChange: (event) => onBalInput(event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'pn-actions' },
                  h('button', { type: 'button', onClick: toggle }, enabled ? t.pause : t.resume),
                  h('button', { type: 'button', className: 'danger', onClick: reset }, t.reset),
                ),
              )
            : null,
        )
      }
    }


    /**
     * 聊天区的提醒横幅。
     *
     * 为什么需要它：提醒是通过 `additionalContexts` 注入的合成 user 消息，
     * 只有**模型**看得见；用户那边悄无声息。这个横幅就是给用户的可见反馈。
     *
     * 两种形态：
     * - **常驻**：只要提醒过至少一次，就一直显示「上次提醒 10月12日 12:27」；
     * - **高亮**：新的提醒到达时，12 秒内换成「已提醒 Agent 汇报进度 · step 10 · #1」。
     *
     * 时间戳用的是**宿主返回的 `nudge.at`**（服务器时钟），不是浏览器本地时间，
     * 这样和会话日志、`/status` 里的时间完全对得上。
     */
    function createNudgeBanner() {
      return function ProgressNudgeBanner() {
        const { status } = useStatus(3000)
        const [flash, setFlash] = useState(false)
        const [hiddenSeq, setHiddenSeq] = useState(0)
        const seenRef = useRef(null)
        const timerRef = useRef(null)

        useEffect(() => {
          const nudge = status?.nudge ?? null
          if (nudge === null) return
          // 首次拿到快照只记基线，不把历史提醒当新事件高亮。
          if (seenRef.current === null) {
            seenRef.current = nudge.seq
            return
          }
          if (nudge.seq <= seenRef.current) return
          seenRef.current = nudge.seq
          setFlash(true)
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(() => setFlash(false), 12000)
        }, [status])

        // 卸载时清掉定时器，避免离开会话后还在 setState。
        useEffect(
          () => () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          },
          [],
        )

        const nudge = status?.nudge ?? null
        const pending = status?.pending ?? null
        const balance = status?.balance ?? null
        // 超时且提醒还欠着（只能在步骤边界投递）——这时必须让用户看到"它在等"，
        // 否则界面上就是一条越过阈值的进度条加上「已提醒 0」，看起来像坏了。
        const overdue = pending?.due === true
        // 余额低于阈值：持续显示，直到充值到阈值以上。
        const lowBalance = balance?.low === true
        // 刚充值恢复：闪一下绿色确认——告诉用户插件已识别，并且已经把这件事告知模型了。
        const recovery = balance?.lastRecovery ?? null
        const justRecovered =
          recovery !== null && typeof recovery.at === 'number' && Date.now() - recovery.at < 15000

        // 什么都没有时不占地方。
        if (nudge === null && !overdue && !lowBalance && !justRecovered) return null
        // 手动关掉之后，一直藏到下一次提醒为止；但"待发/余额不足/刚恢复"这类状态关不掉。
        if (nudge !== null && nudge.seq <= hiddenSeq && !overdue && !lowBalance && !justRecovered) {
          return null
        }

        const warn = !flash && (lowBalance || overdue)
        const confirmed = !flash && !warn && justRecovered
        const className = `pn-banner${flash ? ' is-flash' : ''}${warn ? ' is-overdue' : ''}${
          confirmed ? ' is-ok' : ''
        }`
        let content
        if (flash && nudge !== null) {
          content = [t.nudgeFired + ' · ', h('b', { key: 's' }, nudge.summary ?? '')]
        } else if (lowBalance) {
          // ⚠️ 显示的数字必须跟判定口径一致：scope=recharge 时看充值余额，
          // 否则看可用总额。之前一律显示充值余额，有赠金时数字是错的。
          const shown = balance.scope === 'recharge' ? balance.text : balance.totalText
          const what = balance.scope === 'recharge' ? t.balanceRecharge : t.balance
          content = [
            t.balanceLow + ' ',
            h('b', { key: 'b' }, shown ?? '—'),
            ` · ${what} ≤ ¥${balance.thresholdCny}`,
          ]
        } else if (justRecovered) {
          content = [
            t.balanceRestored + ' ',
            h('b', { key: 'r' }, recovery.totalText ?? '—'),
            ` · ${t.balance} > ¥${balance.thresholdCny}`,
          ]
        } else if (overdue) {
          content = [
            t.overdue + ' ',
            h('b', { key: 'o' }, `${pending.overSeconds}${t.unitSeconds}`),
            ' · ' + t.waitStep,
            nudge !== null ? `（${t.lastNudge} ${formatClock(nudge.at)}）` : '',
          ]
        } else {
          content = [t.lastNudge + ' ', h('b', { key: 't' }, formatClock(nudge.at))]
        }

        return h(
          'div',
          {
            className,
            title: nudge?.text ?? '',
          },
          h('i', null),
          h('span', { className: 'pn-banner-text' }, content),
          nudge !== null
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'pn-banner-close',
                  title: t.dismiss,
                  onClick: () => setHiddenSeq(nudge.seq),
                },
                '×',
              )
            : null,
        )
      }
    }

    /** 把余额状态翻成一句短话。
     * 主口径是**可用总额**（充值 + 赠送）——平台扣款先从赠金扣，
     * 只看充值余额会在"赠金还有一大笔"时误报。
     */
    function balanceText(balance) {
      if (balance === null || balance === undefined) return t.balanceUnknown
      if (balance.enabled !== true) return t.balanceOff
      switch (balance.status) {
        case 'ok': {
          const head = balance.low ? `⚠ ${t.balanceLow} · ` : ''
          return `${head}${balance.totalText ?? balance.text ?? '—'}`
        }
        case 'unavailable':
          return t.balanceUnavailable
        case 'failed':
          return `${t.balanceFailed}${balance.reason ? ` (${balance.reason})` : ''}`
        default:
          return t.balanceUnknown
      }
    }

    /** 充值 / 赠送的明细，作为余额行的第二行小字。 */
    function balanceBreakdown(balance) {
      if (balance?.status !== 'ok') return null
      const parts = []
      if (balance.text) parts.push(`${t.balanceRecharge} ${balance.text}`)
      if (balance.bonusText) parts.push(`${t.balanceBonus} ${balance.bonusText}`)
      return parts.length > 0 ? parts.join(' · ') : null
    }

    function apply(ctx) {
      const style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'progress-nudge: styles')

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: NS, order: 165 }, createPanel()),
      )

      // 聊天区（输入框上方）的提醒横幅。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: NS, order: 120 },
          createNudgeBanner(),
        ),
      )
    }

    const exported = {}
    exported.inject = ['slots']
    exported.apply = apply
    return exported
  },
})
