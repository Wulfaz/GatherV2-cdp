# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the CLI

```bash
node gather-ctl.js <command> [argument]
```

GatherV2 must be running with CDP exposed on port 9222. There are no build or compile steps — it's plain Node.js CommonJS.

## Architecture

The entire project is a single-file CLI (`gather-ctl.js`) with no framework, no build system, and no test suite.

**Control flow:**

1. `main()` parses `process.argv`, dispatches to a command branch.
2. Every command calls `withGather(fn)`, which:
   - Fetches `http://localhost:9222/json` to find the Gather page target and its `webSocketDebuggerUrl`.
   - Opens a raw WebSocket to that URL.
   - Exposes an `ev(expr)` helper that sends a `Runtime.evaluate` CDP message and returns the resolved value.
   - Calls `fn(ev)`, then immediately terminates the WebSocket (`ws.terminate()` — not a graceful close).
3. All Gather state reads and mutations happen via JavaScript snippets in the `JS` object, evaluated inside Gather's renderer process via `Runtime.evaluate`.

**Gather internals accessed via CDP:**

- `window.gatherDev.Repos.localMediaSelfInfo` — mic state (`_audioMuteClicked`, `toggleAudioMuteClicked()`)
- `window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined` — user object: hand, availability, desk, meeting membership
- `window.gatherDev.Repos.avConnections.inputState` — screen share state (`ownScreenShareEnabled`)
- `window.gatherDev.MoveController.moveSpaceUserToDesk()` — move to own desk
- DOM buttons (`[data-testid="toggle-camera-*"]`, `[data-testid="toggle-screen-share-button"]`) — camera and screen share toggles
- Meeting toolbar more-options menu (`button[aria-haspopup="menu"]`) — recording start/stop

**Platform setup:**

| Method | macOS | Windows |
|--------|-------|---------|
| Per-session (no modification) | `open -a GatherV2 --args --remote-debugging-port=9222` | `"%LOCALAPPDATA%\Programs\GatherV2\GatherV2.exe" --remote-debugging-port=9222` |
| Persistent patch | `sudo ./patch-gather.sh` (wraps the binary) | `.\patch-gather.ps1` (patches shortcuts) |

## Key constraints

- The `ws` package is used directly for the CDP WebSocket connection (no higher-level CDP library).
- CDP timeout is hard-coded at 15 seconds per `ev()` call.
- JS snippets that interact with dialogs or async UI use polling loops (`for i < 10; sleep 150ms`) — they are intentionally fragile to Gather UI changes.
- `record`, `share on`, and `hand` require being within meeting range (`u.currentMeeting` must be set). `record` and `share` additionally require the toolbar button to be present in the DOM.
