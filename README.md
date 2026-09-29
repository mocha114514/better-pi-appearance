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

### Keyboard Shortcuts

- Ctrl+C no longer clears the input box text.
- With mouse-selected text, Ctrl+C copies it instead of quitting Pi; pressing Ctrl+C with nothing selected asks for confirmation first to prevent accidental exits.
- With mouse-selected text, direct deletion (Backspace / Delete) and overwrite (Ctrl+V) are supported.
- With mouse-selected text, line cutting (Ctrl+X) is supported.
- Ctrl+- / Ctrl+_ for undo; Windows additionally supports Ctrl+Z.

Note: the TPS plugin comes from the official [Pi](https://github.com/earendil-works/pi) repository implementation.

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

| Command              | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `/m-mng`             | Enable or disable extensions you like/dislike  |
| `/m-mng list`        | List plugin states                             |
| `/m-lgg`             | Chinese/English selection                      |
| `/m-usg` / `/-usg n` | View usage and cost statistics                 |

### Data Location

- Configuration, plugin switches and usage data are stored in **`~/.pi/agent/mpep-cache/`**, separate from the installation directory. Follows `PI_CODING_AGENT_DIR` when set; project-level installations also use the same user data directory.

## License

[MIT](LICENSE) · Copyright (c) 2026 mocha114514
