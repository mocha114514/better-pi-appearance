# MPEP

English | [简体中文](README.zh-CN.md)

A lightweight extension suite that polishes Pi's shell interface.

Built entirely on Pi's own extension mechanism — zero source modification, easy to attach and remove.

> **Fullscreen mode strongly recommended** (set TUI mode to full screen in `/settings`) for the best experience.
>
> Use this as a reference for the recommended settings.
>
> <img src="assets/fullscreen-settings.png" alt="Fullscreen settings"  />

### Interface Optimization

Compact tool output, expandable details, Markdown rendering enhancements, and more.

While a response is executing:

![Executing view](assets/executing-view.png)

When a round ends — finished, aborted, or interrupted — the process collapses automatically:

![Auto collapse](assets/auto-collapse.png)

Double-click to expand:

![Double click expand](assets/double-click-expand.png)

### User Message Bubble Border

Replaces the full-width solid background block of user messages with a clean, modern colored rounded border, eliminating visual harshness and keeping the background transparent. Can be toggled independently via `/m-mng`.

### Turn Navigator

Adds a navigator on the right side to quickly review each round's user prompt and jump to it with a click.

![Turn navigator](assets/turn-navigator.png)

### Statusline

An improved version of Pi's native statusline.

Shows model, project, Git and token usage information, among other data.

![Statusline](assets/statusline.png)

### Usage

Token usage, costs, daily totals and model price editing.

![Usage and costs](assets/usage-costs.png)

![Daily usage](assets/usage-daily.png)

### Theme Distributor

Ships the bundled `mpep-blue` theme. On first load it installs the theme into `~/.pi/agent/themes/` and selects it automatically. The installation is one-shot: if the theme file already exists, your manual theme choice is never overridden.

Disabling the plugin through `/m-mng` uninstalls it: the theme file is removed and the previously selected theme is restored (falls back to Pi's default `dark`).

### Responses WebSocket

Optional transport for the Responses API. Pi still owns the model list, auth, request building, and response parsing. This extension does not modify Pi core and does not patch global `fetch`.

It is enabled by default in `/m-mng`, but it does nothing until a model opts in. Set `"ws": true` in Pi's `models.json` (`~/.pi/agent/models.json`, or under `PI_CODING_AGENT_DIR` when that is set). Examples below use `//` comments; trailing commas are allowed.

Custom model entry:

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

For a model already supplied by a built-in provider, use `modelOverrides` rather than duplicating it in `models[]`. Replace the placeholder provider and model ids below with the existing ones; the model must already resolve to `openai-responses`:

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

- WebSocket is used only when the resolved model `api` is `openai-responses` and the effective `ws` value is `true`. `ws: false`, or no `ws` field, keeps Pi's original transport. Any other API is left untouched.
- For the same model id, an explicit `modelOverrides` `ws` wins over `models[]`, including `ws: false`.
- Edits to `models.json`, and `/m-mng enable responses-ws` or `/m-mng disable responses-ws`, apply only after a restart or `/reload`.
- Each request still sends the full context Pi built. There is no automatic `previous_response_id` optimization.
- WebSocket events are bridged to a local SSE stream for Pi's original parser. A network WebSocket error is never retried as a network HTTP/SSE request.
- An idle socket is reused only when provider, session, WebSocket URL, final handshake headers, and proxy all match. Concurrent requests use separate sockets. `cacheRetention: "none"` keeps Pi's prompt-cache behavior but does not disable WebSocket reuse.
- There is no default idle-time eviction. Connections retire after 55 minutes of age: an idle connection closes at that deadline, while an active response is allowed to finish before its connection retires. The next request opens a replacement only when needed. Shutdown and `/reload` close sockets this extension owns.
- Establishing a new WebSocket has a 60-second default budget (`websocketConnectTimeoutMs` overrides it per request). While reading a response, each wait for the next SDK event has a 10-minute default budget (`timeoutMs` overrides it); this is not a total task-duration or parked-connection idle limit.
- Protocol heartbeats send a Ping every 60 seconds and allow 60 seconds for its matching Pong. Three consecutive missed replies terminate the unhealthy socket. Ping/Pong never sends `response.create`, does not count as model-response progress, and cannot extend the server's connection lifetime.
- Established connections recover from unexpected, SDK-recoverable failures with at most 5 reconnect attempts: an initial 1.875-second backoff, exponential doubling, a 30-second cap, and the SDK's native 75%–100% jitter. An interrupted response fails explicitly; no already-sent request is replayed or response resumed. A recovered connection can serve later requests. A socket still reconnecting is not leased; an overlapping request may open a separate socket.
- Cancellation, disposal, shutdown/reload, and normal age retirement intentionally close connections and prevent further recovery attempts. The SDK's public API cannot cancel an already-running backoff timer: that timer may settle afterward, without opening another connection. Handshake redirects remain disabled.
- If another extension already registered that provider, this one refuses it, leaves that registration unchanged, and notifies you.
- `onResponse` receives synthetic local-SSE metadata (`200`, `X-MPEP-Transport: websocket`). That is not the HTTP create response and not the WebSocket upgrade response.

Verified with local loopback synthetic tests against the Node.js installation of Pi 0.85.1, including native-provider integration, cancellation, timeouts, connection isolation, an HTTP CONNECT proxy, and production-only package copies loaded through Pi's actual extension loader (with no local Pi SDK and with an extension-local decoy helper). The extension resolves Pi's public proxy helper from the host installation; hosts without that helper report a compatibility error rather than bypassing proxy settings. Standalone executable distributions and real official/intermediary APIs have not been verified. The server must support Responses WebSocket.

### Keyboard Shortcuts

- Ctrl+C no longer clears the input box text.
- With mouse-selected text, Ctrl+C copies it instead of quitting Pi; pressing Ctrl+C with nothing selected asks for confirmation first to prevent accidental exits.
- With mouse-selected text, direct deletion (Backspace / Delete) and overwrite (Ctrl+V) are supported.
- With mouse-selected text, line cutting (Ctrl+X) is supported.
- Ctrl+- / Ctrl+_ for undo; Windows additionally supports Ctrl+Z.

Note: the TPS plugin comes from the official [Pi](https://github.com/earendil-works/pi) repository implementation; parts of the subagent plugin design are referenced from [omp](https://github.com/can1357/oh-my-pi).

### Install and Update

```bash
pi install git:github.com/mocha114514/better-pi-appearance
pi update git:github.com/mocha114514/better-pi-appearance
```

### Uninstall

```bash
pi remove git:github.com/mocha114514/better-pi-appearance
```

Then manually delete `~/.pi/agent/mpep-cache/` if you want a full cleanup.

### Commands

| Command              | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `/m-mng`             | Enable or disable extensions, including `responses-ws` |
| `/m-mng list`        | List plugin states                                     |
| `/m-lgg`             | Chinese/English selection                              |
| `/m-usg` / `/-usg n` | View usage and cost statistics                         |

### Data Location

- Configuration, plugin switches and usage data are stored in **`~/.pi/agent/mpep-cache/`**, separate from the installation directory. Follows `PI_CODING_AGENT_DIR` when set; project-level installations also use the same user data directory.

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
