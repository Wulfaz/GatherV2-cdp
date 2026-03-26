# gather-ctl

Programmatic control of the **GatherV2** desktop app from the command line, via Chrome DevTools Protocol (CDP).

Control your mic, camera, screen share, recording, hand raise, availability, and desk — from a terminal, a StreamDeck, or any automation tool.

## Requirements

- GatherV2 desktop app installed at `/Applications/GatherV2.app`
- Node.js
- `ws` npm package (`npm install` in this folder)
- Gather V2 patched to expose CDP (see [Setup](#setup))

## Setup

### 1. Patch GatherV2 (once, then after each update)

The app must be launched with `--remote-debugging-port=9222`. The included script wraps the binary so this happens automatically on every launch — from Spotlight, Dock, or StreamDeck.

```bash
sudo ./patch-gather.sh
```

If macOS shows a security warning on first launch after patching, go to **System Settings → Privacy & Security → Open Anyway**.

Re-run `sudo ./patch-gather.sh` after each Gather update.

### 2. Install dependencies

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
| `status` | — | Print current state: mic, cam, share, record, availability, hand |
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
| `hand` | — | Toggle hand raise |
| `hand` | `up` | Raise hand |
| `hand` | `down` | Lower hand |
| `quit` | — | Teleport to your own desk (no-op if already there) |

## Notes

- **`share`** requires being in meeting range (the button must be visible in the toolbar). The `on` action opens the OS screen picker and auto-clicks Share.
- **`record`** requires being in an active meeting with recording enabled for the space. The `on` action opens the "Record new" menu item and auto-confirms the dialog.
- **`hand`** requires being in an active meeting.
- **`status <avail>`** maps to Gather's availability states: `active` → Active, `away` → Away, `busy` → Busy.
- **`quit`** requires a desk assigned to your user in the space.

## Files

| File | Description |
|---|---|
| `gather-ctl.js` | Main CLI script |
| `patch-gather.sh` | Patches GatherV2.app to expose CDP on port 9222 |
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
| `status` | `window.gatherDev.Repos.localMediaSelfInfo._audioMuteClicked`, `currentSpaceUser.isHandRaised`, `currentMeeting.activeRecordingId`, etc. — bundled into a single `JSON.stringify({…})` |
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
| `status active/away/busy` | `currentSpaceUser.setAvailability({ availability: 'Active' })` (or `Away` / `Busy`) |
| `quit` | `window.gatherDev.MoveController.moveSpaceUserToDesk()` |
