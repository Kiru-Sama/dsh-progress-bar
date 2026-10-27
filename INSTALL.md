# 安装

DSH 插件就是「一个包 + 在 profile 里登记两处」。全程不需要装任何 npm 依赖。

## 0. 找到你的 profile 目录

| 系统 | 默认位置 |
|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\desktop` |
| macOS / Linux | `~/.dsh/profiles/desktop` |

`desktop` 是默认 profile 名；如果你有多个 profile，用你实际在用的那个，
目录里能看到一个 `package.json` 和一个 `cordis.yml`。

> 不确定的话：DSH 设置页 →「打开配置文件」，弹出的目录就是 profile。

## 1. 把包放到一个固定的地方

解压到比如：

```
C:\Users\你\Documents\dsh-progress-bar
```

这个目录里应该直接能看到 `package.json`、`index.js`、`client.js`。

**不要**放在 profile 的 `node_modules` 里——第 3 步会建一个链接指过来，
这样以后更新插件只要覆盖这个目录，不用重装。

## 2. 登记到 profile 的 `package.json`

打开 `<profile>/package.json`，加**两处**：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    // ① 声明依赖，路径指向第 1 步的目录
    "dsh-progress-bar": "link:C:/Users/你/Documents/dsh-progress-bar"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // ② 加进 bundle 列表，DSH 启动时才会加载它
        "dsh-progress-bar"
      ]
    }
  }
}
```

`link:` 后面的路径用正斜杠 `/`，别用反斜杠。

## 3. 让 DSH 能找到这个包

在 `<profile>/node_modules/` 下建一个链接指向第 1 步的目录。
（包名没有 scope，所以**不需要**建 `@local/` 之类的子目录。）

**Windows（推荐 junction，不需要管理员权限）：**

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

**嫌麻烦也可以直接复制**整个 `dsh-progress-bar` 文件夹到
`<profile>/node_modules/dsh-progress-bar`——效果一样，只是以后升级要重新复制。

## 4. 重启 DeepSeek Harness

**必须完全退出再启动**，不是关窗口。新增 bundle 不会热加载。

## 5. 确认装上了

重启后，侧栏底部（输入框左边那一列的最下面）会出现一行：

```
●  0/10 · 0秒                    梁文峰
```

点它展开面板，能看到步数/耗时/余额/时段，以及两个阈值输入框。

**如果没出现**，按顺序查：

1. `<profile>/node_modules/dsh-progress-bar/package.json` 能不能打开？打不开说明第 3 步没建对。
2. profile 的 `package.json` 里两处都加了吗？`dsh.profile.bundles` 里那一项拼错会静默不加载。
3. 启动日志里搜 `did not activate`——有的话说明某个插件没激活，通常会给包名。

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

## 卸载 / 回滚

1. 从 profile 的 `package.json` 里删掉那两处（`dependencies` 与 `dsh.profile.bundles`）。
2. 删掉 `<profile>/node_modules/dsh-progress-bar`（junction 用
   `Remove-Item` 即可，它只删链接、不动源目录）。
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
- 目前只在 **Windows + DSH 桌面版**上实测过。macOS / Linux 理论上可用（步骤 3 用
  symlink），但未验证。
- 只在 `desktop` profile 下实测；多 profile 场景未验证。
