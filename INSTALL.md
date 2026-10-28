# 安装

DSH 桌面版直接装，不需要改 profile、不需要手工建链接：

```
设置 → 插件 → 添加插件 → 从本地目录 → 选这个仓库的根目录
```

装完 `文件 → 退出`，再重新启动 DeepSeek Harness。

> 旧版本文档写的是“手工 link”。现在桌面版插件管理器已经支持本地目录，
> 手工 link 只保留给开发调试/多 profile 的旧流程，普通安装不用看。

## 1. 把包放到一个固定的地方

解压/克隆到比如：

```
C:\Users\你\Documents\dsh-progress-bar
```

这个目录里应该直接能看到 `package.json`、`index.js`、`client.js`。
**不要**放进 `<profile>/node_modules/`——桌面版会自己建立依赖。

## 2. 从本地目录添加

打开 DSH：

1. `设置 → 插件`
2. `添加插件`
3. 来源选 **从本地目录**
4. 选择第 1 步的目录（选到能看到 `package.json` 的那一层）
5. 确认安装

管理器会自己把 `dsh-progress-bar` 写进 profile 的依赖和
`dsh.profile.bundles`，不需要你手改 JSON。

### 如果提示 already-installed

说明这个 profile 里已经有一份 `dsh-progress-bar`，通常是旧的手工 link。
先按“移除旧 link”清掉，再重新添加：

```powershell
# 1) 从 profile 的 package.json 删掉 dsh-progress-bar 的两处：
#    dependencies.dsh-progress-bar
#    dsh.profile.bundles 里的 "dsh-progress-bar"
# 2) 删掉旧链接（只删链接，不动源目录）
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-progress-bar"
# 3) 完全退出 DSH，再重新打开，然后重新“从本地目录”添加
```

### 如果提示 not-a-bundle

检查包的 `package.json` 里是否有：

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

并且 `cordis.patch.yml` 真的存在。当前版本已经带好，正常不会出现。

### 如果提示 not-a-package

选错目录了。要选**包根目录**（里面有 `package.json`），不是它的父目录，
也不是 `node_modules`。

### 方式 B：GitHub Release tgz（复制一条 URL）

仓库打了 `v*` tag 后，GitHub Actions 会自动生成两个 Release 资产：

```text
dsh-progress-bar.tgz       # 固定别名，永远指向最新版
dsh-progress-bar-2.0.1.tgz # 带版本号，钉死版本时用
```

在 DSH 的“添加插件”输入框里直接粘贴固定地址：

```text
https://github.com/Kiru-Sama/dsh-progress-bar/releases/latest/download/dsh-progress-bar.tgz
```

要钉死版本：

```text
https://github.com/Kiru-Sama/dsh-progress-bar/releases/download/v2.0.1/dsh-progress-bar-2.0.1.tgz
```

这种方式不需要先把仓库下载到本地；装完同样要 `文件 → 退出` 再启动。
如果 Release 还没发布，用上面的“本地目录”方式即可。

## 3. 重启并确认

**必须 `文件 → 退出` 完全退出再启动**，不是关窗口。新增 bundle 不会热加载。

重启后，侧栏底部（输入框左边那一列的最下面）会出现：

```
●  0/10 · 0秒                    梁文峰
```

点它展开面板，能看到步数/耗时/余额/时段，以及两个阈值输入框。

**如果没出现**：

1. `设置 → 插件` 里能看到 `dsh-progress-bar` 吗？没看到说明第 2 步没装成功；
2. 看安装时管理器给的错误码：`already-installed` / `not-a-bundle` / `not-a-package`，
   分别按上面的排查；
3. 启动日志里搜 `did not activate`，有的话会点名哪个插件没激活。

## 手工 link（开发/旧版回退，普通用户不用）

只有这两种情况才需要：

- 你要改插件源码，希望改完直接生效；
- 你的 DSH 版本没有桌面插件管理器，只能用 `dsh plugin`。

### 0. 找到 profile

| 系统 | 默认位置 |
|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\desktop` |
| macOS / Linux | `~/.dsh/profiles/desktop` |

### 1. 登记到 profile 的 `package.json`

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-progress-bar": "link:C:/Users/你/Documents/dsh-progress-bar"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-progress-bar"
      ]
    }
  }
}
```

`link:` 后面的路径用正斜杠 `/`。

### 2. 建链接

**Windows（junction，不需要管理员权限）：**

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
New-Item -ItemType Junction `
  -Path   "$profile\node_modules\dsh-progress-bar" `
  -Target "C:\Users\你\Documents\dsh-progress-bar"
```

**macOS / Linux：**

```bash
ln -s /Users/你/Documents/dsh-progress-bar \
      ~/.dsh/profiles/desktop/node_modules/dsh-progress-bar
```

### 3. 完全退出并重启

和桌面版安装一样，`文件 → 退出` 后重新打开。

## 配置

所有配置都有默认值，**不改也能用**。默认值在插件自己的
`cordis.patch.yml` 里，改那个文件后重启即可生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `stepThreshold` | `10` | 累计多少步提醒一次 |
| `timeThresholdSeconds` | `120` | 距上次汇报累计多少秒提醒一次 |
| `minGapSeconds` | `45` | 两次提醒最小间隔（兜底防连击） |
| `maxPerTurn` | `20` | 单回合提醒上限 |
| `exclude` | `["todo_write","ask_user_question"]` | 不计步的工具 |
| `includeSubagents` | `false` | 是否也管 subagent |
| `resetOnSpeech` | `true` | Agent 主动说话时归零计数 |
| `locale` | `zh` | 文案语言 `zh` / `en` |
| `balance.enabled` | `true` | 余额监控 |
| `balance.thresholdCny` | `1.5` | 低于多少提醒 |
| `balance.scope` | `total` | `total`=充值+赠送；`recharge`=只看充值 |
| `balance.checkSeconds` | `300` | 查余额间隔（最小 30） |
| `balance.repeatSeconds` | `1800` | 仍低额时多久再提醒；`0`=只提醒一次 |
| `tariff.enabled` | `true` | 显示峰谷时段 |
| `tariff.holidays` | `[]` | 中国法定节假日 `YYYY-MM-DD`，全天按低谷算 |

步数、秒数、余额阈值这三项**也能在侧栏面板里直接改，输入即生效**，不用重启。

> ⚠️ **同一个 profile 里不要放两行相同 id 的配置**。两份实例会各自注册
> `/progress-nudge/api` 前缀路由，重复路由会让整棵插件树启动失败。

## 更新 / 回滚

侧栏面板会提示 GitHub 上的新版本（`updateCheck`）。更新时二选一：

- **本地目录**：覆盖原目录（`git pull` / 解压新版），`文件 → 退出` 后重启；
- **Release tgz**：在“添加插件”里重新粘贴 latest 地址。若提示 `already-installed`，
  先在 `设置 → 插件` 移除旧版，再添加新版，然后完全退出重启。

回滚就换成带版本号的地址，例如：

```text
https://github.com/Kiru-Sama/dsh-progress-bar/releases/download/vX.Y.Z/dsh-progress-bar-X.Y.Z.tgz
```

把 `X.Y.Z` 换成要回滚的版本；该版本必须已经发过 Release。

> **配置放在哪**：默认值在**插件包内**的 `cordis.patch.yml` 里，**不在** profile 的
> `cordis.patch.yml`。想改长期生效的默认值，就改插件目录里那份（重启生效）——
> 但**更新/重装插件会覆盖它**，改之前先备份。
>
> ⚠️ 侧栏面板里调的值**只对当前运行有效**：它存在内存里，重启就回到
> `cordis.patch.yml` 的值。要长期生效必须改文件。

## 卸载 / 回滚

### 桌面版

`设置 → 插件` 里移除 `dsh-progress-bar`，然后 `文件 → 退出` 重启。

### 手工 link / 管理器不可用

1. 从 profile 的 `package.json` 里删掉两处：`dependencies` 与 `dsh.profile.bundles`；
2. 删掉 `<profile>/node_modules/dsh-progress-bar`（junction 用 `Remove-Item`，
   只删链接、不动源目录）；
3. 重启 DSH。

插件不改动 DSH 本体任何文件，删掉即彻底干净。

## 已知限制

- **提醒只能在步骤边界投递**。工具执行期间 agent 循环是阻塞的，模型读不到任何东西；
  所以一个跑 5 分钟的命令，提醒要等命令返回才发得出去。跨越阈值但还没到边界时，
  界面会用「已到期 N 秒 · 等当前步骤结束后提醒」明确告诉你它在等。
- **余额依赖宿主登录**。余额读的是 DSH 自己的 `deepseekAccount` 服务（设置页
  「账号与余额」显示的那个）。没登录、或用第三方中转站时，面板会显示「不可用」，
  不会报错也不会瞎编数字。
- **峰谷时段是 DeepSeek 官方 API 的计费口径**（工作日北京时间 09:00–12:00、
  14:00–18:00 为高峰，其余半价）。**中国法定节假日无法离线判断**，需要手工填
  `tariff.holidays`，否则只按周末 + 时段算，面板上会注明这一点。
- 目前只在 **Windows + DSH 桌面版**上实测过。macOS / Linux 理论上可用（手工 link
  用 symlink），但未验证。
- 只在 `desktop` profile 下实测；多 profile 场景未验证。
- **侧栏面板调的阈值不持久**。改完立即生效，但重启回到插件包内 `cordis.patch.yml`
  的值。要固定下来就改那个文件（会被更新覆盖，先备份）。
- **版本检测需要能连 `api.github.com`**。如果本机挂了改写 hosts 的加速工具
  （Steam++ / Watt Toolkit 之类），面板会显示「查询失败（unable to verify…）」——
  这是刻意不绕过证书校验的结果，不是 bug。
