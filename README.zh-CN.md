# MPEP

[English](README.md) | 简体中文

一个轻量化的优化 pi 的外壳界面的插件集合。

完全依赖于 pi 自身的扩展机制，零源码修改，轻量装卸。

> **强烈建议在 pi 的全屏模式（在 `/settings` 的 TUI mode 中选择 full screen）下配合使用该插件，以获得最好效果。**
>
> 以此参照设置最佳
>
> ![Fullscreen settings](assets/fullscreen-settings.png)

### 界面优化

紧凑工具输出、详情展开、 Markdown 渲染增强等。

执行中界面优化

![Executing view](assets/executing-view.png)

本轮结束后会自动折叠（说完、Abort、中途插话都一样）

![Auto collapse](assets/auto-collapse.png)

可双击展开

![Double click expand](assets/double-click-expand.png)

### 用户消息圆角气泡

将用户发送文本时默认横跨全屏的带底色实心长条色块，替换为轻盈精致的彩色圆角边框包裹，消除生硬底色，视觉更通透现代。可在 `/m-mng` 中随时独立开关。

### AI 依赖清单

给 AI 提供 `list_write` 和 `list_read` 工具。条目按建单顺序显示，具有稳定编号、完整说明段落和 AI 显式指定的 `dependsOn` 前置依赖。只有全部前置事项完成后才能划掉条目；重复编号、不存在的依赖和循环依赖会被拒绝。

在 Pi **全屏模式**下，输入框上边框右侧的 **list** 是悬浮窗入口，单击展开，再次单击收起；也可用 `/m-list`。Pi 0.85.1 的普通模式没有组件级鼠标分派，因此普通模式不显示这个入口，但 AI 清单工具仍可使用。窗口优先使用 64 个字符列，内容向上增长，顶到终端顶部后在窗口内滚动，不影响聊天记录滚动或输入框焦点。已完成标题显示删除线，说明和依赖仍可查看。

清单状态保存在 Pi 会话记录中，不依赖聊天摘要，也不写入项目文件。在同一会话中浏览历史不会回退任务状态。全部完成后仍保留，只有建立下一份清单时才替换；AI 不能覆盖尚未完成的清单。

每次上下文压缩成功后，插件会在新上下文末尾补入一次**完整清单快照**，包含所有已完成项、说明和依赖。快照对模型可见、在聊天界面隐藏，不会主动启动额外回复。后续更新以清单工具返回的实时状态为准。全文会占用上下文 token，不会被偷偷缩略或截断。

`list_write` 支持 `create`、`append`、`update`、`complete`；`list_read` 始终返回完整清单，包括已完成条目。插件校验依赖规则，实际工作是否完成仍由 AI 判断。可在 `/m-mng` 中独立开关。

### 轮次导航

在右侧添加轮次导航，可以快速查看每轮的用户指令并点击转跳

![Turn navigator](assets/turn-navigator.png)

### 状态栏

状态栏在 pi 原生的基础上进行一定改善

模型、项目、Git 和 Token 用量信息等各类数据显示。

![Statusline](assets/statusline.png)

### 用量统计

Token 用量、费用、每日汇总和模型价格编辑。

![Usage and costs](assets/usage-costs.png)

![Daily usage](assets/usage-daily.png)

### 主题分发

内置 `mpep-blue` 蓝色主题。首次加载时自动安装到 `~/.pi/agent/themes/` 并选中该主题。安装是一次性的：如果主题文件已存在，则不会覆盖你手动选择的主题。

通过 `/m-mng` 禁用该插件即等于卸载：删除主题文件，并还原安装前使用的主题（无记录时回退到 pi 默认的 `dark`）。

### Responses WebSocket 传输

可选的 Responses API 传输。模型、鉴权、请求构造和响应解析仍由 Pi 负责。本扩展不修改 Pi 核心，也不替换全局 `fetch`。

它在 `/m-mng` 中默认启用，但没有模型显式打开时不会做任何事。在 Pi 的 `models.json`（`~/.pi/agent/models.json`；设置了 `PI_CODING_AGENT_DIR` 时跟随该目录）里写 `"ws": true`。下面的示例只用 `//` 注释；允许行尾逗号。

自定义模型：

```jsonc
{
  "providers": {
    "example-provider": {
      "baseUrl": "https://example.invalid/v1",
      "apiKey": "YOUR_API_KEY",
      "api": "openai-responses",
      "models": [
        {
          "id": "example-model",
          // Other model fields stay Pi's. Only ws is read here.
          "api": "openai-responses",
          "ws": true,
        },
      ],
    },
  },
}
```

对于内置 provider 已经提供的模型，用 `modelOverrides` 标记，不必在 `models[]` 中重复定义。下面的 provider 和模型 id 是占位值，需要替换成已有名称；该模型解析后的 API 必须已经是 `openai-responses`：

```jsonc
{
  "providers": {
    "example-provider": {
      "modelOverrides": {
        "builtin-model": {
          "ws": true,
        },
      },
    },
  },
}
```

- 只有解析后的模型 `api` 为 `openai-responses`，且最终生效的 `ws` 为 `true` 时才使用 WebSocket。`ws: false` 或没有 `ws` 字段时，保持 Pi 原来的传输。其他 API 即使写了 `ws` 也不会被改动。
- 同一模型 id 上，`modelOverrides` 里显式的 `ws` 优先于 `models[]`，包括 `ws: false`。
- 修改 `models.json`，或执行 `/m-mng enable responses-ws` 与 `/m-mng disable responses-ws` 之后，需要重启或 `/reload` 才会生效。
- 新启动的子代理也默认加载此插件，各自使用独立连接池，仍遵守插件总开关和模型的启用条件。已运行的子进程需要重启才能应用这个加载变更。
- 每次请求仍发送 Pi 构造的完整上下文，不会自动改成 `previous_response_id` 优化。
- WebSocket 事件会桥接成本地 SSE，交给 Pi 原来的解析器。网络层的 WebSocket 错误不会再退回网络 HTTP/SSE。
- 空闲连接只在 provider、会话、WebSocket URL、最终握手头和代理都相同时复用。并发请求各用各的连接。`cacheRetention: "none"` 保留 Pi 原有的提示词缓存行为，但不再禁止 WebSocket 连接复用。
- 默认不按闲置时长回收连接。连接年龄达到 55 分钟时轮换：闲置连接到龄关闭；正在响应的连接允许完成本轮后再关闭，下一次请求按需建立替代连接。会话关闭和 `/reload` 会关闭本扩展持有的连接。
- 建立新 WebSocket 的默认超时为 60 秒，可由单次请求的 `websocketConnectTimeoutMs` 覆盖。读取响应时，每次等待下一个 SDK 事件的默认超时为 10 分钟，可由 `timeoutMs` 覆盖；这不是任务总时长限制，也不是闲置连接回收时间。
- 协议心跳每 60 秒发送一次 Ping，等待对应 Pong 的时间为 60 秒，连续 3 次未回应才终止失效连接。Ping/Pong 不发送 `response.create`，不算模型响应进度，也不能延长服务端的连接寿命。
- 已建立的连接在意外且 SDK 可恢复的故障后自动重连，最多 5 次：初始退避 1.875 秒、逐次翻倍、上限 30 秒，并保留 SDK 自带的 75%～100% 随机抖动。中断的响应会明确报错，不自动重发已经发送的请求，也不续传该响应；恢复的连接可供后续请求使用。正在重连的连接不会被交给请求使用；此时到来的其他请求可能另建连接。
- 取消、销毁、会话关闭／重载和正常到龄关闭都属于主动关闭，会阻止后续恢复尝试。SDK 的公开 API 无法取消已经开始的退避计时；该计时可能稍后结束，但不会再建立连接。握手重定向仍保持关闭。
- 若其他扩展已经注册了该 provider，本扩展会拒绝接管、保持原注册不变，并发出通知。
- `onResponse` 拿到的是本地合成 SSE 的元数据（状态 `200`，头 `X-MPEP-Transport: websocket`），不是真实的 HTTP create 响应，也不是 WebSocket 升级响应。

已针对 Node.js 安装版 Pi 0.85.1 完成本地 loopback 合成验证，覆盖原生 provider 集成、取消、超时、连接隔离和 HTTP CONNECT 代理；仅包含生产依赖的插件副本也已通过 Pi 的真实扩展加载器验证，包括没有本地 Pi SDK，以及存在本地伪代理模块的场景。扩展从宿主安装目录解析 Pi 的公开代理辅助模块；宿主没有该模块时会明确报兼容性错误，不会绕过代理设置。独立可执行文件发行版以及真实官方／中转 API 尚未验证。服务端必须支持 Responses WebSocket。

### 快捷键优化

- 取消了Ctrl+C清空输入框文本的行为。
- 支持鼠标自由选中文本的情况下进行Ctrl+C复制而不是退出pi，并且对没选中内容时候按下Ctrl+C做了二次确认防止误触推出pi。
- 支持鼠标自由选中文本的情况下进行文本的直接删除（Backspace / Delete）和覆写（Ctrl+V）。
- 支持鼠标自由选中文本的情况下行文本的剪切操作（Ctrl+X）。
- Ctrl+- / Ctrl+_进行撤销操作，Windows端额外支持Ctrl+Z。

注：TPS插件源自于[Pi](https://github.com/earendil-works/pi)官方仓库实现；子代理插件的部分设计参考自[omp](https://github.com/can1357/oh-my-pi)

### 安装与更新

```bash
pi install git:github.com/mocha114514/better-pi-appearance
pi update git:github.com/mocha114514/better-pi-appearance
```

### 卸载

```bash
pi remove git:github.com/mocha114514/better-pi-appearance
```

然后手动删除 `~/.pi/agent/mpep-cache/` 即可彻底清理。

### 常用指令

| 指令                 | 用途                                |
| -------------------- | ----------------------------------- |
| `/m-mng`             | 启用和禁用扩展，包括 `responses-ws` |
| `/m-mng list`        | 查看插件状态                        |
| `/m-lgg`             | 中文/英文选择                       |
| `/m-usg` / `/-usg n` | 查看用量与费用统计                  |

### 数据位置

- 配置、插件开关和用量数据统一保存在 **`~/.pi/agent/mpep-cache/`**，与安装目录分离。设置 `PI_CODING_AGENT_DIR` 时会跟随该目录；项目级安装也使用同一用户数据目录。

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
