# @paperclipai/desktop

Electron shell that runs the Paperclip control plane locally as a sidecar process and exposes it through a tray-resident desktop app.

## What it does

- Spawns `pnpm paperclipai run` from the repo root as a child process
- Polls `http://localhost:3100/api/health` until the server is ready
- Opens a `BrowserWindow` pointed at `http://localhost:3100`
- Installs a macOS menu-bar (tray) icon with: Show Window, Open in Browser, Reveal Logs, Restart Sidecar, Quit
- Closing the window hides it (the app keeps running in the tray); Quit fully exits and stops the sidecar

## Run it (dev)

From the repo root:

```sh
pnpm install
pnpm dev:desktop
```

This compiles `src/` and launches Electron, which spawns `pnpm paperclipai run` from the monorepo root as the sidecar.

`pnpm build:desktop` compiles `src/` only (no launch). The root `pnpm build` (`pnpm -r build`) will also build this package.

## Build a macOS `.dmg`

```sh
pnpm dist:desktop
```

Output lands in `desktop/release/`. The `.dmg` is unsigned — on first launch right-click the app and pick **Open** to bypass Gatekeeper.

In packaged mode the app spawns the sidecar as `npx -y paperclipai run` via your login shell (`$SHELL -lc`), so it inherits your shell `PATH` and resolves `npx`/`node` from your environment. You must have Node + npm on `PATH`.

The sidecar inherits your existing `~/.paperclip` config, so if you've already run `paperclipai onboard`, it will pick up that setup.

## Logs

Sidecar stdout/stderr is mirrored to:

```
~/.paperclip/desktop/sidecar.log
```

Use the tray's **Reveal Logs** entry to open it.

## Scope (v1)

- macOS-first. Tray + dock behavior is tuned for macOS; Linux/Windows are best-effort.
- Dev mode only — assumes it is launched from inside the monorepo so `pnpm paperclipai run` resolves. Packaging via `electron-builder` and bundling a standalone CLI is a follow-up.

## Environment overrides

- `PAPERCLIP_DESKTOP_API_BASE` — override the default `http://localhost:3100` target.
- `PAPERCLIP_DESKTOP_PROJECT_ROOT` — explicit path to the monorepo root if auto-detection fails.
