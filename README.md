# 🐳 朗读桥 · dsh-aloud

**让 DSH 里的对话，用你自己电脑的声音念出来。**

她在会话里说完一轮 → 宿主插件把这段话排进本地队列 → 你浏览器里的扩展取走 → `chrome.tts` 念出来。

声音从**你的电脑**出来，不经过任何云端语音服务，**不产生语音流量、不花钱**。

> 参考了 [Yuuyuko-uu/dsh-tts-bridge](https://github.com/Yuuyuko-uu/dsh-tts-bridge) 的思路（「宿主出文本、浏览器负责发声」的分工），代码为独立实现：发声用浏览器原生 `chrome.tts`，不依赖任何网页端，也就不受对方朗读配额和页面状态影响。

---

## 组成

| | 是什么 | 干什么 |
|---|---|---|
| **① DSH 插件** `dsh-aloud` | 住在 DSH 宿主里 | 监听 `session/event`，每轮 `turn/end` 把助手文本洗一遍排进队列，并开几个回环 HTTP 接口 |
| **② 浏览器扩展** `extension/` | 住在 Chrome / Edge 里 | 定时取一条，用 `chrome.tts` 念，念完回执 |

两边通过 `http://127.0.0.1:<DSH 端口>` 通信，只走回环。

---

## 需要什么

- DSH（桌面版或 `dsh web` 均可），带 Web 界面（宿主必须有 `webServer` 服务）
- Chromium 内核浏览器（Chrome / Edge / Brave）。Firefox 的扩展机制不同，需另写
- **不需要**任何 TTS API key

---

## 安装

### 第一步：装宿主插件

```sh
# 本地目录（推荐先这样试）
dsh plugin --profile <你的profile> add C:\src\dsh-aloud

# 或从 GitHub 装
dsh plugin --profile <你的profile> add github:8ga-tech/dsh-aloud
```

装完**不需要再手写 `insert` 行** —— 这一点是实机验证时发现的：

> `dsh plugin add` 除了装包，还会把包名写进 profile 的 `dsh.profile.bundles`；
> 而被列为 bundle 的包，**其自带的 `cordis.patch.yml` 会自动插入这一行**。
> 我第一次验证时手写了一模一样的 `- insert:`，结果会撞成重复 id。

要改配置，在 profile 的 `cordis.patch.yml` 里加一条**配置覆盖行**即可：

```yaml
- id: aloud
  name: 'dsh-aloud'
  config:
    maxChars: 800
    maxItems: 60
```

> 桌面版的 profile 由 Electron 独占，CLI 不能改；请用 GUI 的插件管理页安装，
> 需要改配置时再手动往 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` 加上面的覆盖行。

重启 DSH（或 profile 开了 `patchReload: live` 就等它热加载）。启动日志里应出现：

```
[aloud] aloud: 已订阅 session/event（每轮结束自动入队）
[aloud] aloud: HTTP 接口已挂在 /dsh-aloud（GET /dsh-aloud/next 取一条）
```

验证一下（端口换成你 DSH 实际监听的端口）：

```sh
curl http://127.0.0.1:43120/dsh-aloud/health
# {"ok":true,"plugin":"dsh-aloud","pending":0,"size":0,"watching":false}

curl -X POST http://127.0.0.1:43120/dsh-aloud/say \
     -H 'content-type: application/json' -d '{"text":"你好，这是测试"}'
curl http://127.0.0.1:43120/dsh-aloud/next
```

### 第二步：装浏览器扩展

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选本仓库的 **`extension/`** 文件夹
4. 点扩展图标，把「DSH 地址」填成你 DSH 的地址（默认 `http://127.0.0.1:43120`），点**保存**
5. 点「试念一句」——听到声音就成功了
6. 勾上「自动朗读」，之后她每说完一轮，扩展就会自动念

> 端口从哪里看：DSH 启动日志里的 `dsh web: http://127.0.0.1:端口/?token=...`。

---

## 接口（给扩展 / 脚本）

前缀默认 `/dsh-aloud`，可在配置里改。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 探活，返回队列长度与是否在监听 |
| GET | `/next` | 取一条待念的（取走即标记已取） |
| GET | `/list?scope=all` | 看队列里有什么 |
| POST | `/ack` | 念完回执 `{"id":"..."}` |
| POST | `/say` | 手动投喂 `{"text":"..."}` |
| POST | `/clear` | 清空待念队列 |

都带 `Access-Control-Allow-Origin: *`（该服务本身不写 CORS，是本插件加的）。

---

## 配置

写在 profile 的 `cordis.patch.yml` 对应行下面：

```yaml
- insert:
    - id: aloud
      name: 'dsh-aloud'
      config:
        enabled: true
        prefix: /dsh-aloud
        maxChars: 600        # 单条最多念多少字，超出按标点截断
        maxItems: 40         # 队列上限
        watchLogs: false     # 兜底：轮询会话日志（默认关，session/event 已够用）
        sessionsDir: ''      # watchLogs 时用，留空 = $DSH_HOME/sessions
        pollMs: 3000
```

朗读前会**洗文本**（纯逻辑，有 19 个单测覆盖）：

- 围栏代码块整块丢弃，行内代码保留内容
- 图片丢弃，链接只留文字
- 标题/引用/列表/markdown 强调记号全部去掉
- 纯链接行、纯符号行丢弃
- 超长按标点截断并加省略号
- 同一段话只念一次（内容指纹去重，不靠游标）

---

## 已知边界

- **宿主不能替浏览器发声**。`chrome.tts` 只能在扩展里调；插件只负责出文本。
- `turn/end` 事件本身**不带正文**，所以是在 `assistant/message` 时按 turn 累积、以最后一条为准。
- 路由前缀不能和别的插件重复（`webServer.register` 遇到重复会 **throw**）。
- 端口不要写死，扩展里按你实际的 DSH 端口填。
- 扩展从 https 页面访问 `http://127.0.0.1` 的混合内容限制属浏览器策略，若你那边的页面是 https 可能需要在浏览器里放行。
- 语音音色/语速由操作系统与浏览器决定，插件不控制。

---

## 开发

```sh
npm test          # 19 个单测：队列/文本清洗 + 会话日志解析
npm run test:e2e  # 扩展侧实机测试台（需要一个装好本插件的 DSH 在跑）
```

`tests/extension-harness.mjs` 会用一套**仿造的 `chrome.*` API** 把 `extension/background.js`
真跑起来，打到运行中的 DSH，验证：

```
PASS  background.js 载入并注册了消息监听
PASS  扩展调通了宿主 /next
PASS  调用了 chrome.tts.speak
PASS  念的是洗过 markdown 的文本
PASS  回执后宿主队列已清空
PASS  宿主不可达时不抛错
PASS  并在 lastError 里留下可读原因
```

唯一测不到的是「真的有声音出来」——那需要真实浏览器的扬声器。

结构：

```
lib/queue.js   队列与文本清洗（纯函数，可直接测）
lib/watch.js   会话日志监听（兜底来源）
lib/index.js   cordis 插件：session/event 订阅 + HTTP 接口
extension/     MV3 浏览器扩展（background + popup）
tests/         单测 + 扩展实机测试台
```

## 实测记录

在 DSH 0.2.0-rc.2 上做过一次完整的实机验证（一次性 profile，headless 启动）：

| 检查 | 结果 |
|---|---|
| 插件被 loader 载入、路由注册 | `GET /dsh-aloud/health` → `{"ok":true,"plugin":"dsh-aloud",...}` |
| 中文往返 + markdown 清洗 | 投喂 `**你好**，…` → 取回 `你好，…`（20 字，星号已去） |
| 未知路由 | `GET /dsh-aloud/nope` → 404 |
| 扩展后台完整链路 | 7/7 通过（见上） |

**装法上的一个坑（实测得出）**：`dsh plugin add` 除了装包，还会把包名写进 profile 的
`dsh.profile.bundles`；被列为 bundle 的包其自带的 `cordis.patch.yml` **会自动插入**，
所以**不要再手写 `- insert:`**，否则会撞成重复 id。要改配置就加「配置覆盖行」。

## 许可

MIT
