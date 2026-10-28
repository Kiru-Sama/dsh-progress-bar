/**
 * 包结构测试：验证发布包能被 DSH 桌面版/插件管理器识别为 bundle。
 *
 *   node test/package.mjs
 *
 * 只读 package.json 与文件系统，不联网、不安装、不启动 DSH。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

assert.equal(pkg.name, 'dsh-progress-bar', '包名必须是 dsh-progress-bar')
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'version 必须是 x.y.z')
assert.notEqual(pkg.private, true, '发布包不能标记 private')

const bundle = pkg.dsh?.bundle
assert.ok(bundle && typeof bundle.patch === 'string', '必须声明 dsh.bundle.patch')
assert.ok(existsSync(join(root, bundle.patch)), `bundle patch 不存在：${bundle.patch}`)
assert.ok(typeof pkg.main === 'string' && existsSync(join(root, pkg.main)), 'main 必须存在')

const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'README.md',
  'INSTALL.md',
]
for (const file of required) {
  assert.ok(existsSync(join(root, file)), `缺少发布文件：${file}`)
}

assert.ok(pkg.repository?.url?.includes('dsh-progress-bar'), '必须声明 repository')
assert.ok(pkg.engines?.dsh, '必须声明 engines.dsh')

console.log(`✅ 包结构可安装：${pkg.name}@${pkg.version}（bundle patch=${bundle.patch}）`)
