# 发版规则

每次要把改动推上 `main` 之前，走一遍这四步。写在这里是因为**会话会丢上下文**——
将来不管是我、别的 AI、还是几个月后的你，照这份做就行。

## 0. 自动 Release（推荐）

推一个 `v*` tag，[`.github/workflows/release.yml`](.github/workflows/release.yml)
会自动：

1. 校验 tag 与 `package.json` 的 `version` 一致（不一致直接失败）；
2. 跑 `node test/run.mjs`；
3. `npm pack` 出 `dsh-progress-bar-<version>.tgz`，再复制一份固定别名
   `dsh-progress-bar.tgz`；
4. 创建/更新 GitHub Release，上传两个资产。

用户拿固定地址即可安装最新版：

```text
https://github.com/Kiru-Sama/dsh-progress-bar/releases/latest/download/dsh-progress-bar.tgz
```

不要在网页上手工建 Release，除非 Actions 失败需要兜底；手工建容易漏掉固定别名。

## 1. 改 `package.json` 的 `version`

| 改动类型 | 版本 |
|---|---|
| 加功能 | minor（`1.4.0` → `1.5.0`） |
| 修 bug | patch（`1.4.0` → `1.4.1`） |
| 破坏性（改包名、改配置语义） | major（`1.4.0` → `2.0.0`） |
| 只改文档 / 注释 | patch（发出去的东西变了，就该有新号） |

## 2. 提交信息里带版本号

```
feat: 自适应退避「增强提醒」+ 侧栏开关（1.3.0）
fix: 赠金为 0 时不再显示「赠送 ¥0.00」（1.2.1）
```

从 `4f3415f` 起一直是这么写的，`git log` 可查。

## 3. 打 tag（会触发自动 Release）

```powershell
& 'F:\GitPortable\cmd\git.exe' -C <repo> tag -a vX.Y.Z -m "一句话说明这一版做了什么"
& 'F:\GitPortable\cmd\git.exe' -C <repo> -c http.sslBackend=schannel -c http.schannelCheckRevoke=false push origin --tags
```

> ⚠️ **tag 不是版本检测的前提。** 检测比的是 `main` 上 `package.json` 的 `version`
> vs 本机 `version`，跟 tag / release 完全无关。
> tag 的价值：给「用最新版」一个稳定锚点；触发自动 Release；给固定下载地址一个版本。

> 如果只想发代码、不想发 Release，推 tag 前先确认 workflow 是否要跳过；
> 当前配置是**所有 `v*` tag 都会发 Release**。

## 4. 跑测试 / 本地预览包

```bash
node test/run.mjs
npm pack --dry-run
```

31 项 Host 测试 + 客户端结构 + 包结构测试，必须全过。`npm pack --dry-run` 用来确认
发布包里带上了 `package.json`、`cordis.patch.yml`、`index.js`、`client.js`、
`locale/` 和文档，且没有把 `dist/`、`node_modules/` 打进去。

---

## 为什么必须记得改版本号

侧栏的版本检测就是拿「`main` 上 `package.json` 的 `version`」跟本机比。**忘了改，
检测端会永远显示「已是最新」，而且不会报任何错**——这条链上没有自动检查。

反过来说，这是一个可用的自检信号：

> 面板显示「已是最新」，但你明明在 GitHub 上看到有新提交 → 就是发版时漏改了。

## 顺带一提：域名被改写会查不到

如果本机挂了改写 hosts 的加速工具（Steam++ / Watt Toolkit 之类），
`api.github.com` 会被指到 `127.0.0.1` 做 TLS 中间人，Node 拒认它的证书，
面板会显示「查询失败（unable to verify…）」。这是**有意的**（不绕过证书校验），
关掉加速再点 `↻` 即可。
