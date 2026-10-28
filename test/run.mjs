/**
 * 统一测试入口：
 *
 *   node test/run.mjs
 *
 * - smoke.mjs  —— Host 半边逻辑（触发、冻结、归零、路由），用假 ctx 驱动
 * - client.mjs —— Client 半边结构（加载、槽位注册、面板/设置卡片渲染），用自制 React 桩
 * - package.mjs —— 发布包结构（bundle patch、main、必须文件），不联网
 *
 * 两个测试都**不需要任何外部依赖**，与插件的零依赖设计保持一致：
 * `index.js` 只 import node 内建模块，`client.js` 只从模块表 require react。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tests = ['smoke.mjs', 'client.mjs', 'package.mjs']

let failed = 0
for (const name of tests) {
  console.log(`\n===== ${name} =====`)
  const result = spawnSync(process.execPath, [join(root, 'test', name)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(failed === 0 ? '\n全部测试通过 ✅' : `\n有 ${failed} 个测试文件失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
