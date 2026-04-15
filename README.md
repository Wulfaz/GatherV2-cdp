# gather-ctl

Programmatic control of the **GatherV2** desktop app from the command line, via Chrome DevTools Protocol (CDP).

Control your mic, camera, screen share, recording, hand raise, availability, desk, reactions, dance, meeting lock, video view, and shared music — from a terminal, a Stream Deck, or any automation tool.

## Requirements

- GatherV2 desktop app installed
  - macOS: `/Applications/GatherV2.app`
  - Windows: `%LOCALAPPDATA%\Programs\GatherV2\GatherV2.exe`
- Node.js
- `ws` npm package (`npm install` in this folder)
- GatherV2 running with CDP exposed on port 9222 (see [Setup](#setup))

## Setup

The app must be launched with `--remote-debugging-port=9222`. There are two ways to do this:

### Option 1. Launch GatherV2 with CDP enabled (no modification needed)

Quit any running instance of GatherV2, then launch it with the flag:

**macOS**
```bash
open -a GatherV2 --args --remote-debugging-port=9222
```

**Windows** — Command Prompt:
```cmd
"%LOCALAPPDATA%\Programs\GatherV2\GatherV2.exe" --remote-debugging-port=9222
```

**Windows** — PowerShell:
```powershell
Start-Process "$env:LOCALAPPDATA\Programs\GatherV2\GatherV2.exe" -ArgumentList "--remote-debugging-port=9222"
```

This is a one-time command per session — you must use it each time you start GatherV2.

### Option 2. Patch GatherV2 (once, then after each update)

The included scripts inject `--remote-debugging-port=9222` so the flag is passed automatically on every launch — from Spotlight/Start Menu, Dock/Taskbar, or StreamDeck.

**macOS** — wraps the binary inside the app bundle (requires `sudo`):
```bash
sudo ./patch-gather.sh
```
If macOS shows a security warning on first launch after patching, go to **System Settings → Privacy & Security → Open Anyway**.

**Windows** — patches Start Menu and Desktop shortcuts (run in PowerShell):
```powershell
.\patch-gather.ps1
```
If Windows SmartScreen warns on first run, click **More info → Run anyway**.

Re-run the patch script after each Gather update.

### Install dependencies

```bash
npm install
```

## Usage

```bash
node gather-ctl.js <command> [argument]
```

GatherV2 app must be running. All commands connect to CDP, execute, and disconnect immediately.

## Commands

| Command | Argument | Description |
|---|---|---|
| `status` | — | Print current state: mic, cam, share, record, availability, hand, lock, view, music |
| `status` | `active` | Set availability to Active |
| `status` | `away` | Set availability to Away |
| `status` | `busy` | Set availability to Busy |
| `mic` | — | Toggle microphone |
| `mic` | `on` | Unmute microphone |
| `mic` | `off` | Mute microphone |
| `cam` | — | Toggle camera |
| `cam` | `on` | Turn camera on |
| `cam` | `off` | Turn camera off |
| `share` | — | Toggle screen share (must be in meeting range) |
| `share` | `on` | Start screen share (opens picker, auto-confirms) |
| `share` | `off` | Stop screen share |
| `record` | — | Toggle recording (must be in an active meeting) |
| `record` | `on` | Start recording (opens confirmation dialog, auto-confirms) |
| `record` | `off` | Stop recording |
| `hand` | — | Toggle hand raise (must be in a meeting) |
| `hand` | `up` | Raise hand |
| `hand` | `down` | Lower hand |
| `reaction` | `wave\|heart\|tada\|thumbsup\|rofl\|clap\|100\|fire` | Send an emoji reaction |
| `dance` | `[seconds]` | Dance for the given duration (0.5–10 s, default 3 s) |
| `lock` | — | Toggle meeting lock (must be meeting host) |
| `lock` | `on` | Lock the meeting |
| `lock` | `off` | Unlock the meeting |
| `view` | — | Toggle between meeting (Grid) and office (Carousel) view |
| `view` | `meeting` | Switch to meeting/Grid view |
| `view` | `office` | Switch to office/Carousel view |
| `music` | `ambient\|lofi\|energy` | Play shared meeting music (Soft Ambience / Lofi Chill / Simple Energy) |
| `music` | `stop` | Stop shared meeting music |
| `quit` | — | Teleport to your own desk (no-op if already there) |

## Meeting types

GatherV2 has two meeting types:

- **Room meeting** — calendar/planned meetings. Full feature set available (`hand`, `lock`, `view`, `music`, `record`).
- **Hallway Conversation** — automatically triggered when avatars come close to each other. `hand`, `lock`, and `view` work; `music` and `record` are unavailable.

`status` prints a `meet:` line showing `HALLWAY` or `ROOM` whenever you are in any conversation.

## Notes

- **`share`** requires being in meeting range (the button must be visible in the toolbar). The `on` action opens the OS screen picker and auto-clicks Share.
- **`record`** requires being in a **room** meeting with recording enabled for the space. The `on` action opens the "Record new" menu item and auto-confirms the dialog.
- **`hand`** and **`view`** work in both room meetings and Hallway Conversations.
- **`lock`** works in both room meetings and Hallway Conversations. Additionally requires being the meeting host — non-hosts do not see the lock button.
- **`music`** requires being in a **room** meeting. It affects all participants. `MusicPlaybackList` values: `SoftAmbience` / `LofiChill` / `SimpleEnergy`.
- **`reaction`** accepts exactly 8 emojis (wave, heart, tada, thumbsup, rofl, clap, 100, fire). Arbitrary emojis are silently dropped by GatherV2 server-side.
- **`dance`** duration is capped at 0.5–10 seconds. The WebSocket stays open for the full duration.
- **`status <avail>`** maps to Gather's availability states: `active` → Active, `away` → Away, `busy` → Busy.
- **`quit`** requires a desk assigned to your user in the space.

## Files

| File | Description |
|---|---|
| `gather-ctl.js` | Main CLI script |
| `patch-gather.sh` | macOS: patches GatherV2.app binary to expose CDP on port 9222 |
| `patch-gather.ps1` | Windows: patches GatherV2 shortcuts to expose CDP on port 9222 |
| `package.json` | Node.js project file |

## Network calls

Every command opens one HTTP request and one WebSocket connection, then disconnects immediately.

### HTTP

| Method | URL | Purpose |
|---|---|---|
| `GET` | `http://localhost:9222/json` | Discover CDP targets; finds the Gather page and retrieves its `webSocketDebuggerUrl` |

### WebSocket

| URL | Purpose |
|---|---|
| `ws://localhost:9222/devtools/page/<id>` | CDP session with the Gather renderer process |

All commands are sent over the WebSocket as a single `Runtime.evaluate` message:

| CDP method | Parameters | Purpose |
|---|---|---|
| `Runtime.evaluate` | `expression`, `returnByValue: true`, `awaitPromise: true` | Execute a JavaScript snippet inside Gather's renderer and return the result |

### `Runtime.evaluate` expressions

Each command maps to a self-contained IIFE sent as the `expression` parameter.

| Command | Expression (simplified) |
|---|---|
| `status` | `window.gatherDev.Repos.localMediaSelfInfo._audioMuteClicked`, `currentSpaceUser.isHandRaised`, `currentMeeting.activeRecordingId`, lock/view/music state, etc. — bundled into a single `JSON.stringify({…})` |
| `mic` toggle | `window.gatherDev.Repos.localMediaSelfInfo.toggleAudioMuteClicked()` |
| `mic on/off` | same repo, calls `toggleAudioMuteClicked()` only if current state differs |
| `cam` toggle | `document.querySelector('[data-testid="toggle-camera-on-button"]').click()` or `toggle-camera-off-button` depending on current state |
| `share` toggle/on | `document.querySelector('[data-testid="toggle-screen-share-button"]').click()`, then polls for a `Share` button and clicks it |
| `share off` | same button click, no dialog |
| `record on` | opens more-options menu → clicks `"Record new"` → clicks `"Start a new recording"` in the confirmation dialog |
| `record off` | opens more-options menu → clicks `"Stop recording"` |
| `hand up` | `currentSpaceUser.raiseHand()` |
| `hand down` | `currentSpaceUser.lowerHand()` |
| `hand` toggle | checks `currentSpaceUser.isHandRaised`, then calls `raiseHand()` or `lowerHand()` |
| `reaction <name>` | `window.gatherDev.Repos.reactionsFrontend.sendEmote('<emoji>')` |
| `dance` | `currentSpaceUser.startDancing()`, timer in Node.js, then `currentSpaceUser.stopDancing()` |
| `lock` toggle | `document.querySelector('[data-testid="lock-conversation-button"]').click()` or `unlock-conversation-button` |
| `lock on/off` | checks which button is present; clicks only if state differs |
| `view` toggle | reads `videoViewMode.inputState.videoViewMode`, calls `repo.setViewMode('Carousel'` or `'Grid')` |
| `view meeting/office` | same `setViewMode` call, maps `meeting` → `'Grid'`, `office` → `'Carousel'` |
| `music <track>` | `window.gatherDev.Repos.syncedMusicPlaybackFrontend.startPlayback('SoftAmbience'\|'LofiChill'\|'SimpleEnergy')` |
| `music stop` | `window.gatherDev.Repos.syncedMusicPlaybackFrontend.stopPlayback()` |
| `status active/away/busy` | `currentSpaceUser.setAvailability({ availability: 'Active' })` (or `Away` / `Busy`) |
| `quit` | `window.gatherDev.MoveController.moveSpaceUserToDesk()` |
