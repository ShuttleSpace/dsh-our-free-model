# Magpie 宿主插件（`magpie` 分支）

本分支让本仓库同时是 **Magpie 插件**。`main` 保持上游原样，Magpie 适配全部落在
`magpie/` 与 `package.json` 的少量字段里，因此后续同步上游只需合并 `main`。

参考实现是独立的 [`mu-zi-lee/magpie-our-free-model`](https://github.com/mu-zi-lee/magpie-our-free-model)，
但它把上游快照 vendor 进自己的仓库；本分支不再复制一份 OFM，而是直接复用本仓库的
`packages/standalone` 运行时，所以只有一层适配代码。

## 入口

Magpie 按 `exports["./server"]` → `main` → `exports["."]` 的顺序查找服务端入口。
`package.json` 因此只新增：

```json
"exports": {
  ".": "./index.js",
  "./server": "./magpie/index.mjs"
}
```

DSH 仍从 `index.js` 加载，两个宿主互不影响。

## 结构

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `magpie/index.mjs` | Magpie 的 Bun 宿主 | 插件入口，只导出一个函数 |
| `magpie/managed.mjs` | Bun | `config` / `auth` / `provider` 钩子、模型发现、请求转发 |
| `magpie/models.mjs` | 两端共用 | 目录行与 Magpie 模型之间的映射 |
| `magpie/runtime.mjs` | Bun | 启动并持有 Node 子进程 |
| `magpie/runner.mjs` | Node 子进程 | 调用 `startStandalone`，回答 `models` / `admit` / `console` |
| `magpie/handoff.mjs` | Node 子进程 | 一次性 `/open/…` 链接，用本机 API Key 换管理会话 Cookie |
| `magpie/installation-state.mjs` | Bun（插件宿主） | 安装登记、生命周期锁、卸载清理 |
| `magpie/uninstall.mjs` | Magpie 卸载入口 | `magpie.uninstall` 声明，只调用清理逻辑 |
| `magpie/node.mjs` | Bun | 选择系统 Node，缺失时下载并校验官方发行包 |

服务必须跑在 Node 而不是 Bun：渠道 Worker 需要 `node:sqlite`。子进程通过 stdin/stdout
上的逐行 JSON 通信，宿主退出时 stdin 关闭，子进程随之停止。

## 安装与使用

```sh
magpie plugin add ./dsh-our-free-model          # 本地目录
magpie plugin add github:Ebony-Vinyl/dsh-our-free-model#magpie
```

在 Magpie 的 **供应商 → Our Free Model** 里点“启用模型 / 打开账号管理控制台”，
浏览器会打开本机管理页。完成 EAC 授权或渠道登录后回到 Magpie 刷新模型，即可在
Agent 里选择 `our-free-model/<模型 id>`。

- 数据目录默认是 `<Magpie 配置目录>/our-free-model`，与 DSH 的 `~/.our-free-model`
  分开，避免两个宿主抢同一个 `service.lock`。
- 服务只监听回环地址；管理页也只能在本机打开。远程/服务器场景请用 SSH 端口转发。
- 首次启动如果系统没有 Node 22.19+ / 24+，会从 nodejs.org 下载固定版本
  （24.21.0，SHA-256 已 pin），缓存到数据目录的 `runtime/` 下。

## 选项

Magpie 的插件 `options` 通过 `managed` 传入：

```json
{
  "managed": {
    "dataDir": "/absolute/path/our-free-model",
    "port": 0,
    "nodePath": "/usr/local/bin/node",
    "autoInstallNode": true,
    "refresh": true
  }
}
```

- `dataDir`：必须是专用子目录，不能是系统根目录、主目录、Magpie 配置目录或源码目录。
- `port`：推理监听端口，`0` 表示随机。
- `nodePath`：显式指定 Node；设置后不会自动下载。
- `autoInstallNode`：`false` 时缺少 Node 直接报错。
- `refresh`：`false` 时启动不做模型清单刷新，只用手动刷新。

## 与参考实现的差异

已迁移：单供应商、动态模型发现、上下文/输出上限、视觉与思考档位、请求转发、
本机管理页一次性入口、模型停用后的准入检查、Node 运行时自动准备。

未迁移（有意保留在参考仓库，或后续再加）：

- Cloudflare 临时远程控制台（`cloudflared` 下载与隧道）。本分支只提供本机控制台。
- `our-free-zen` / `our-free-kilo` / `our-free-local` 三个兼容供应商。本仓库的
  匿名、Kilo、EAC 与账号渠道已经合并进同一个目录，一个供应商即可覆盖。
- DSH 桌面端、公告推送、自更新/热重载、宿主 Agent 续跑与局域网中继。

## 卸载与清理

`package.json` 的 `magpie.uninstall` 指向 `magpie/uninstall.mjs`。Magpie 卸载插件时会
加载它，即使供应商已停用；该入口不会启动服务、下载 Node 或读取凭据。

- 首次启动服务前，`registerInstallation` 在数据目录写入
  `.dsh-ofm-magpie-owner.json`，并在 Magpie 配置目录登记
  `dsh-our-free-model-magpie-owned.json`。
- 卸载只清理登记过的数据目录，且只删除本插件写入的条目：
  `settings.json`、`stats.json`、`availability.json`、`catalog.json`、
  `channel-credentials.json`、`eac-user.json`、`workbench.json`、
  `workbench-library.json`、`upgrade-state.json`、`updates.json`、`service.lock`，
  以及 `subscriptions/`、`clients/`、`egress/`、`magpie/`、`engine-runtime/`、
  `desktop-updates/`、`upgrade-stage/`、`rollback/`、`runtime/`、`channel-pack/`、
  `temporary/`。其他文件保留；目录非空时整个目录也保留。
- 同时删除 `plugin-auth.json` 里的 `our-free-model`（以及被 Magpie 重命名时的
  `our-free-model-plugin`）和它们的 `#…` 多账号条目。
- 以下情况会保留文件并中止卸载：服务仍在运行（`service.lock` 指向活进程）、
  登记或所有权标记损坏/不匹配、数据目录被移动或换成符号链接。
- 没有登记记录的老布局，只有 `settings.json` 同时含 `forwardKey` 和整数
  `standalonePort` 时才视为本插件的数据。

## 打包分发

`npm run pack:magpie` 把插件打包成 `dist/our-free-model-magpie.zip`：从
`magpie/index.mjs` 与 `magpie/runner.mjs`（外加渠道 Worker）走真实的 import 图，
只收集合成的 `.mjs/.js`，再补上运行时真正读取的非代码资源——根
`package.json`、`icon.svg`、`vendor/magpie/engine.json`、渠道包的
`qoder-auth-wasm.wasm`、`src/providers/registry.json` 以及构建好的控制台
`packages/standalone/web/`。不包含 DSH 桌面端、`frontend/` 源码、`node_modules`、
测试、`.git` 以及 65 MB 的引擎二进制（`magpie` 字段默认关闭引擎，引擎按需在
运行时下载）。Zip 自写、纯 Node、无第三方依赖。

## 同步上游

```sh
git fetch origin
git checkout magpie
git merge origin/main
npm run test:magpie-host
```

预期只有 `package.json` 会冲突（`exports`、`files`、`scripts`、`magpie` 字段）。
保持这些改动最小，冲突时保留双方：上游新增的导出/文件照抄，`"./server"` 与
`"magpie"` 字段保留。`magpie/` 目录本身与上游文件不重叠。

上游改动涉及 `packages/standalone/service.mjs`、`src/core/runtime.js`、`src/effort.js`
时，合并后要重跑 `npm run test:magpie-host`：插件依赖
`runtime.publicModelRows()`、`runtime.state().catalog` 和 `effortsFor()` 这三个接口。
如果上游在数据目录新增了文件或子目录，同步更新
`magpie/installation-state.mjs` 的 `ownedFiles` / `ownedDirs` 和本文档的清单，
否则卸载会保留这些新文件。
