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

**Meeting types:**

GatherV2 has three meeting types detected differently:
- **Room meeting** — `u.currentMeeting` is set (non-null). Full feature set available.
- **Hallway Conversation** — proximity-triggered when avatars get close; `u.currentMeeting` is null. Detected by DOM presence of `lock-conversation-button` or `unlock-conversation-button`. Only `hand`, `lock`, and `view` are available; `music` and `record` require a room meeting.
- **External Meeting** — an external call (Zoom, Google Meet, etc.) triggered from within Gather; a popup with title **"External meeting detected"** appears (buttons: "Join next meeting", "Go to desk"). `u.currentMeeting` is null, no lock/unlock buttons, no `data-testid` on any popup element. Detected by DOM presence of a `<span>` whose trimmed text equals `"External meeting detected"`. No Gather AV controls apply; only `status` (read-only) is relevant.

The `status` command prints a `meet:` line (`EXTERNAL`, `HALLWAY`, or `ROOM`) when in any conversation.

**Gather internals accessed via CDP:**

- `window.gatherDev.Repos.localMediaSelfInfo` — mic state (`_audioMuteClicked`, `toggleAudioMuteClicked()`)
- `window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined` — user object: hand, availability, desk, meeting membership, dancing (`startDancing()`, `stopDancing()`)
- `window.gatherDev.Repos.avConnections.inputState` — screen share state (`ownScreenShareEnabled`)
- `window.gatherDev.Repos.reactionsFrontend` — emoji reactions (`sendEmote(emoji)` — takes the raw emoji character, e.g. `👋`)
- `window.gatherDev.Repos.videoViewMode.inputState` — meeting view mode (`videoViewMode: "Grid"|"Carousel"` read-only; `"Grid"` = meeting/video-grid view, `"Carousel"` = office/game-map view). **Do not write this observable directly.** Use `setViewMode('Grid'|'Carousel')` which dispatches the correct Redux action (`setViewMode(A) { dispatch(gB(A)) }`). DOM nav links (`meeting-view-nav` / `office-view-nav`) are unreliable — `meeting-view-nav` is absent in Hallway Conversations.
- `window.gatherDev.Repos.syncedMusicPlaybackFrontend` — shared meeting music (`startPlayback(playlist)`, `stopPlayback()`, guarded by `canStartPlayback`/`canStopPlayback`; `playback.playlist` reflects current track or `undefined` when not playing)
- `window.gatherDev.MoveController.moveSpaceUserToDesk()` — move to own desk
- DOM buttons (`[data-testid="toggle-camera-*"]`, `[data-testid="toggle-screen-share-button"]`) — camera and screen share toggles
- DOM buttons (`[data-testid="lock-conversation-button"]`, `[data-testid="unlock-conversation-button"]`) — meeting lock toggle; `lock-conversation-button` present = unlocked (click to lock), `unlock-conversation-button` present = locked (click to unlock). Presence of either button also signals "in any conversation" (scheduled or Hallway).
- Meeting toolbar more-options menu (`button[aria-haspopup="menu"]`) — recording start/stop

**Platform setup:**

| Method | macOS | Windows |
|--------|-------|---------|
| Per-session (no modification) | `open -a GatherV2 --args --remote-debugging-port=9222` | `"%LOCALAPPDATA%\Programs\GatherV2\GatherV2.exe" --remote-debugging-port=9222` |
| Persistent patch | `sudo ./patch-gather.sh` (wraps the binary) | `.\patch-gather.ps1` (patches shortcuts) |

## Companion Stream Deck plugin

A Stream Deck plugin mirrors all CLI commands as hardware buttons with live state feedback:
`~/Developments/Stream Deck/GatherV2 StreamDeck Plugin/`

The plugin uses the same CDP approach and shares the same JS snippets. When adding a new CLI command, update the plugin too: add the JS snippet to `src/gatherV2/js-snippets.ts`, extend `GatherState` in `src/gatherV2/types.ts`, create a new action in `src/actions/`, add image assets under `net.wulfaz.gatherV2.sdPlugin/imgs/actions/`, register in `manifest.json` and `src/plugin.ts`, then run `npm run build`.

## Key constraints

- The `ws` package is used directly for the CDP WebSocket connection (no higher-level CDP library).
- CDP timeout is hard-coded at 15 seconds per `ev()` call.
- JS snippets that interact with dialogs or async UI use polling loops (`for i < 10; sleep 150ms`) — they are intentionally fragile to Gather UI changes.
- **"In any conversation" detection** (`inAnyMeeting`) uses DOM presence of `lock-conversation-button` or `unlock-conversation-button`. This covers room meetings (`u.currentMeeting` set) and Hallway Conversations (`u.currentMeeting` null). External Meetings are tracked separately via `externalMeeting` and are excluded from `inAnyMeeting`. `hand`, `lock`, and `view` use the `inAnyMeeting` check.
- **External Meeting detection** uses `[...document.querySelectorAll('span')].find(s => s.textContent?.trim() === 'External meeting detected')`. The popup has no `data-testid` — Gather uses obfuscated class names only. `hallwayConversation` explicitly guards against `externalMeeting` being true to avoid false positives.
- `record` and `music` require a room meeting only (`u.currentMeeting` must be set). `record` and `share` additionally require the toolbar button to be present in the DOM. `lock` additionally requires being a meeting host (non-hosts do not see the lock button).
- `reaction` accepts 8 fixed emojis (wave, heart, tada, thumbsup, rofl, clap, 100, fire) mapped to their Unicode characters. Only these 8 are accepted server-side; arbitrary emojis are silently dropped by GatherV2.
- `dance` keeps the WebSocket open for the full duration (timer runs in Node.js between two `ev()` calls). Duration is capped at 0.5–10 seconds.
- `view` works in both room meetings and Hallway Conversations. State is read from `videoViewMode.inputState.videoViewMode`; changes are applied via `repo.setViewMode('Grid'|'Carousel')` — a Redux dispatch. DOM nav clicks (`meeting-view-nav` / `office-view-nav`) are not used: `meeting-view-nav` is absent in Hallway Conversations.
- `music` requires a room meeting; `MusicPlaybackList` enum values: `SoftAmbience` | `LofiChill` | `SimpleEnergy` (string enum — values equal keys). `startPlayback` and `stopPlayback` are synchronous (fire-and-forget); a 300–500 ms settle delay is added after each call.
