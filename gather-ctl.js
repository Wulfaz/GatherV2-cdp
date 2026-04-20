#!/usr/bin/env node
/**
 * gather-ctl — Programmatic control of Gather V2 desktop app via CDP
 *
 * Usage:
 *   node gather-ctl.js status               # Print current state (mic, cam, locked, hand, share, record, availability)
 *   node gather-ctl.js status <avail>       # Set availability: active | away | busy
 *   node gather-ctl.js mic                  # Toggle microphone
 *   node gather-ctl.js mic on|off           # Set mic explicitly
 *   node gather-ctl.js cam                  # Toggle camera
 *   node gather-ctl.js cam on|off           # Set camera explicitly
 *   node gather-ctl.js lock                 # Toggle meeting lock (must be in meeting, host only)
 *   node gather-ctl.js lock on|off          # Lock or unlock meeting explicitly
 *   node gather-ctl.js reaction <name>      # Send a reaction: wave|heart|tada|thumbsup|rofl|clap|100|fire
 *   node gather-ctl.js hand                 # Toggle hand raise
 *   node gather-ctl.js hand up|down         # Set hand explicitly
 *   node gather-ctl.js share                # Toggle screen share (button must be present)
 *   node gather-ctl.js share on|off         # Set screen share explicitly
 *   node gather-ctl.js record               # Toggle recording (must be in meeting with recording enabled)
 *   node gather-ctl.js record on|off        # Set recording explicitly
 *   node gather-ctl.js view                 # Toggle meeting/office view (must be in meeting)
 *   node gather-ctl.js view meeting|office  # Set view explicitly
 *   node gather-ctl.js music ambient|lofi|energy  # Play ambient music for all in meeting
 *   node gather-ctl.js music stop           # Stop music
 *   node gather-ctl.js dance <seconds>      # Dance for the given number of seconds
 *   node gather-ctl.js quit                 # Go back to own desk (no-op if already there)
 *
 * Requirements: Gather V2 must be running. CDP exposed on localhost:9222.
 */

const http = require('http');
const WebSocket = require('ws');

// ─── CDP helpers ─────────────────────────────────────────────────────────────

async function getGatherPageId() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', { agent: false }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const targets = JSON.parse(body);
          const page = targets.find(t =>
            t.type === 'page' && t.url?.includes('gather.town')
          );
          if (!page) reject(new Error('Gather page not found. Is Gather V2 running?'));
          else resolve(page.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', () =>
      reject(new Error('Cannot reach localhost:9222. Is Gather V2 running?'))
    );
  });
}

async function withGather(fn) {
  const wsUrl = await getGatherPageId();
  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const pending = new Map();

  const ev = (expr) => new Promise((resolve, reject) => {
    const id = msgId++;
    let timer;
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    }));
    timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('CDP eval timeout'));
      }
    }, 15000);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.result?.exceptionDetails) {
      const raw = msg.result.exceptionDetails.exception?.description || 'CDP error';
      const clean = raw.split('\n')[0].replace(/^Error:\s*/, '');
      p.reject(new Error(clean));
    } else {
      p.resolve(msg.result?.result?.value);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  try {
    return await fn(ev);
  } finally {
    ws.terminate(); // immediate teardown — avoids waiting for CDP's close handshake
  }
}

// ─── JS snippets (run inside Gather's renderer process) ──────────────────────

const JS = {
  getState: `(function() {
    const lm = window.gatherDev.Repos.localMediaSelfInfo;
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const camOnBtn  = document.querySelector('[data-testid="toggle-camera-off-button"]');
    const screenBtn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    const lockBtn   = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    const externalMeetingTitle = [...document.querySelectorAll('span')].find(s => s.textContent?.trim() === 'External meeting detected');
    const meeting = u?.currentMeeting;
    // External Meetings show a popup with title "External meeting detected" — no Gather AV, no lock/hand controls
    const externalMeeting = !!externalMeetingTitle;
    // Hallway Conversations (proximity-triggered) don't set currentMeeting but show lock/unlock buttons
    const hallwayConversation = !meeting && !externalMeeting && (!!lockBtn || !!unlockBtn);
    const inAnyMeeting = !!meeting || hallwayConversation;
    return JSON.stringify({
      mic:    !lm._audioMuteClicked,
      cam:    !!camOnBtn,
      screen: window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled ?? false,
      screenAvail: !!screenBtn,
      avail:  u?.userSetAvailability?.value ?? 'Unknown',
      externalMeeting: externalMeeting,
      hallwayConversation: hallwayConversation,
      hand:      u?.isHandRaised ?? false,
      handAvail:  inAnyMeeting,
      // unlock-conversation-button present = meeting is locked; lock-conversation-button present = unlocked
      locked:      inAnyMeeting ? !!unlockBtn : null,
      lockAvail:   inAnyMeeting,
      record:      !!meeting?.activeRecordingId,
      recordAvail: !!meeting,
      // "Grid" = meeting view, "Carousel" = office view
      view:      inAnyMeeting ? (window.gatherDev.Repos.videoViewMode?.inputState?.videoViewMode === 'Grid' ? 'meeting' : 'office') : null,
      viewAvail: inAnyMeeting,
      // playback is undefined when nothing is playing; playlist value === MusicPlaybackList key
      music:     !!meeting ? ({'SoftAmbience':'ambient','LofiChill':'lofi','SimpleEnergy':'energy'}[window.gatherDev.Repos.syncedMusicPlaybackFrontend?.playback?.playlist] ?? null) : null,
      musicAvail: !!meeting
    });
  })()`,

  toggleMic: `(function() {
    const lm = window.gatherDev.Repos.localMediaSelfInfo;
    lm.toggleAudioMuteClicked();
    return !lm._audioMuteClicked; // true = mic ON (not muted)
  })()`,

  setMic: (on) => `(function() {
    const lm = window.gatherDev.Repos.localMediaSelfInfo;
    const currentlyOn = !lm._audioMuteClicked;
    if (currentlyOn !== ${on}) lm.toggleAudioMuteClicked();
    return !lm._audioMuteClicked;
  })()`,

  toggleCam: `(function() {
    const on  = document.querySelector('[data-testid="toggle-camera-off-button"]');
    const off = document.querySelector('[data-testid="toggle-camera-on-button"]');
    const btn = on || off;
    if (!btn) throw new Error('Camera button not found');
    btn.click();
    return !on; // returns new state
  })()`,

  setCam: (wantOn) => `(function() {
    const isOn = !!document.querySelector('[data-testid="toggle-camera-off-button"]');
    if (isOn !== ${wantOn}) {
      const btn = document.querySelector('[data-testid="toggle-camera-on-button"]') ||
                  document.querySelector('[data-testid="toggle-camera-off-button"]');
      if (!btn) throw new Error('Camera button not found');
      btn.click();
    }
    return ${wantOn};
  })()`,

  toggleHand: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    if (!u) throw new Error('currentSpaceUser not found');
    const lockBtn = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    if (u.isHandRaised) { await u.lowerHand(); return false; }
    else                { await u.raiseHand(); return true;  }
  })()`,

  setHand: (up) => `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    if (!u) throw new Error('currentSpaceUser not found');
    const lockBtn = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    await u.setHandRaised(${up});
    return ${up};
  })()`,

  // ── lock: lock/unlock the meeting (host-only DOM button) ───────────────────
  // unlock-conversation-button present → meeting is locked (click to unlock)
  // lock-conversation-button present   → meeting is unlocked (click to lock)
  toggleLock: `(function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const lockBtn   = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u?.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    const btn = lockBtn || unlockBtn;
    if (!btn) throw new Error('Lock button not found (must be host in meeting range)');
    btn.click();
    return !!lockBtn; // clicked lockBtn → now locked → true; clicked unlockBtn → now unlocked → false
  })()`,

  setLock: (lock) => `(function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const lockBtn   = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u?.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    const isLocked  = !!unlockBtn;
    if (isLocked === ${lock}) return ${lock};
    const btn = ${lock} ? lockBtn : unlockBtn;
    if (!btn) throw new Error('Lock button not found (must be host in meeting range)');
    btn.click();
    return ${lock};
  })()`,

  setAvail: (status) => `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    if (!u) throw new Error('currentSpaceUser not found');
    await u.setAvailability({ availability: '${status}' });
    return '${status}';
  })()`,

  // Screen share: stop is a direct button click; start opens a picker dialog then clicks Share.
  // Requires macOS screen recording permission granted to Gather V2.
  screenStart: `(async function() {
    const btn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!btn) throw new Error('Not in a meeting');
    const isOn = window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled;
    if (isOn) return true; // already sharing
    btn.click();
    // Wait for picker dialog
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 150));
      const shareBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Share');
      if (shareBtn) { shareBtn.click(); break; }
    }
    await new Promise(r => setTimeout(r, 800));
    return window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled ?? false;
  })()`,

  screenStop: `(async function() {
    const btn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!btn) throw new Error('Not in a meeting');
    const isOn = window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled;
    if (!isOn) return false; // already off
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    return window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled ?? false;
  })()`,

  screenToggle: `(async function() {
    const btn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!btn) throw new Error('Not in a meeting');
    const isOn = window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled;
    if (isOn) {
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      return window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled ?? false;
    } else {
      btn.click();
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 150));
        const shareBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Share');
        if (shareBtn) { shareBtn.click(); break; }
      }
      await new Promise(r => setTimeout(r, 800));
      return window.gatherDev.Repos.avConnections.inputState?.ownScreenShareEnabled ?? false;
    }
  })()`,

  goToDesk: `(function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    if (!u) throw new Error('currentSpaceUser not found');
    if (!u.hasDesk) throw new Error('No desk assigned');
    if (u.isAtOwnDesk) return '"already at desk"';
    window.gatherDev.MoveController.moveSpaceUserToDesk();
    return '"moving to desk"';
  })()`,

  // Recording: start opens a "Record new" menu item then a confirmation dialog.
  // Stop uses the "Stop recording" menu item. Both go through the more-options menu.
  recordStart: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const meeting = u?.currentMeeting;
    if (!meeting) throw new Error('Not in a meeting');
    if (meeting.activeRecordingId) return true; // already recording

    const screenBtn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!screenBtn) throw new Error('Meeting toolbar not found (must be in meeting range)');
    const container = screenBtn.parentElement;
    const moreBtn = [...container.querySelectorAll('button[aria-haspopup="menu"]')].pop();
    if (!moreBtn) throw new Error('More options button not found');

    // Open menu, find "Record new"
    moreBtn.click();
    let recordNewBtn = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 150));
      recordNewBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Record new');
      if (recordNewBtn) break;
    }
    if (!recordNewBtn) throw new Error('Record new button not found (recording may not be enabled for this space)');
    recordNewBtn.click();

    // Wait for confirmation dialog, click "Start a new recording"
    let startBtn = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 150));
      startBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Start a new recording');
      if (startBtn) break;
    }
    if (!startBtn) throw new Error('Confirmation button not found in dialog');
    startBtn.click();

    // activeRecordingId propagates asynchronously; return true optimistically
    await new Promise(r => setTimeout(r, 500));
    return true;
  })()`,

  recordStop: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const meeting = u?.currentMeeting;
    if (!meeting) throw new Error('Not in a meeting');
    if (!meeting.activeRecordingId) return false; // already stopped

    const screenBtn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!screenBtn) throw new Error('Meeting toolbar not found (must be in meeting range)');
    const container = screenBtn.parentElement;
    const moreBtn = [...container.querySelectorAll('button[aria-haspopup="menu"]')].pop();
    if (!moreBtn) throw new Error('More options button not found');

    moreBtn.click();
    let stopBtn = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 150));
      stopBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Stop recording');
      if (stopBtn) break;
    }
    if (!stopBtn) throw new Error('Stop recording button not found in menu');
    stopBtn.click();

    await new Promise(r => setTimeout(r, 800));
    return !meeting.activeRecordingId; // true = successfully stopped
  })()`,

  recordToggle: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const meeting = u?.currentMeeting;
    if (!meeting) throw new Error('Not in a meeting');

    const screenBtn = document.querySelector('[data-testid="toggle-screen-share-button"]');
    if (!screenBtn) throw new Error('Meeting toolbar not found (must be in meeting range)');
    const container = screenBtn.parentElement;
    const moreBtn = [...container.querySelectorAll('button[aria-haspopup="menu"]')].pop();
    if (!moreBtn) throw new Error('More options button not found');

    if (meeting.activeRecordingId) {
      // Stop recording
      moreBtn.click();
      let stopBtn = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 150));
        stopBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Stop recording');
        if (stopBtn) break;
      }
      if (!stopBtn) throw new Error('Stop recording button not found in menu');
      stopBtn.click();
      await new Promise(r => setTimeout(r, 800));
      return false;
    } else {
      // Start recording
      moreBtn.click();
      let recordNewBtn = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 150));
        recordNewBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Record new');
        if (recordNewBtn) break;
      }
      if (!recordNewBtn) throw new Error('Record new button not found (recording may not be enabled for this space)');
      recordNewBtn.click();
      let startBtn = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 150));
        startBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Start a new recording');
        if (startBtn) break;
      }
      if (!startBtn) throw new Error('Confirmation button not found in dialog');
      startBtn.click();
      await new Promise(r => setTimeout(r, 500));
      return true;
    }
  })()`,

  sendReaction: (name) => {
    const emoji = {
      wave: '👋', heart: '❤️', tada: '🎉',
      thumbsup: '👍️', rofl: '🤣', clap: '👏',
      '100': '💯', fire: '🔥'
    }[name];
    return `(async function() {
    const repo = window.gatherDev?.Repos?.reactionsFrontend;
    if (!repo) throw new Error('reactionsFrontend not available');
    await repo.sendEmote('${emoji}');
    return true;
  })()`;
  },

  // ── view: toggle between meeting view and office view ────────────────────────
  // Gather internal modes: "Grid" = meeting view, "Carousel" = office view.
  // State is read from videoViewMode.inputState.videoViewMode.
  //
  // Switching TO Grid: clicking meeting-view-nav triggers React Router navigation which
  // unmounts Carousel-view components (including the "Locked conversation" label overlay).
  // setViewMode('Grid') alone dispatches the same Redux action but does NOT change the route,
  // so the label persists. Therefore: click meeting-view-nav when present (room meetings);
  // fall back to setViewMode('Grid') only in Hallway Conversations where the nav is absent.
  //
  // Switching TO Carousel: setViewMode('Carousel') is sufficient — no label issue in Grid.
  // Do NOT click office-view-nav — it navigates to the map page, exiting Hallway Conversations.
  viewToggle: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const lockBtn = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u?.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    const repo = window.gatherDev.Repos.videoViewMode;
    if (!repo) throw new Error('videoViewMode not available');
    const isInMeeting = repo.inputState?.videoViewMode === 'Grid';
    repo.setViewMode(isInMeeting ? 'Carousel' : 'Grid');
    await new Promise(r => setTimeout(r, 300));
    return repo.inputState?.videoViewMode === 'Grid' ? 'meeting' : 'office';
  })()`,

  viewSet: (mode) => `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    const lockBtn = document.querySelector('[data-testid="lock-conversation-button"]');
    const unlockBtn = document.querySelector('[data-testid="unlock-conversation-button"]');
    if (!u?.currentMeeting && !lockBtn && !unlockBtn) throw new Error('Not in a meeting');
    const repo = window.gatherDev.Repos.videoViewMode;
    if (!repo) throw new Error('videoViewMode not available');
    const wantGrid = ${JSON.stringify(mode)} === 'meeting';
    const isAlreadyInMode = repo.inputState?.videoViewMode === (wantGrid ? 'Grid' : 'Carousel');
    if (!isAlreadyInMode) {
      repo.setViewMode(wantGrid ? 'Grid' : 'Carousel');
      await new Promise(r => setTimeout(r, 300));
    }
    return ${JSON.stringify(mode)};
  })()`,

  // ── music: play ambient music for all in meeting, or stop ─────────────────
  // API: window.gatherDev.Repos.syncedMusicPlaybackFrontend
  // MusicPlaybackList enum values: SoftAmbience|LofiChill|SimpleEnergy (value === key)
  // startPlayback/stopPlayback are synchronous (fire-and-forget internally).
  playMusic: (track) => {
    const trackMap = { ambient: 'SoftAmbience', lofi: 'LofiChill', energy: 'SimpleEnergy' };
    const trackValue = trackMap[track];
    return `(async function() {
      const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
      if (!u?.currentMeeting) throw new Error('Not in a meeting');
      const repo = window.gatherDev.Repos.syncedMusicPlaybackFrontend;
      if (!repo) throw new Error('syncedMusicPlaybackFrontend not available');
      if (!repo.canStartPlayback) throw new Error('Cannot start music (check space/meeting permissions)');
      repo.startPlayback('${trackValue}');
      await new Promise(r => setTimeout(r, 500));
      return '${track}';
    })()`;
  },

  stopMusic: `(async function() {
    const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
    if (!u?.currentMeeting) throw new Error('Not in a meeting');
    const repo = window.gatherDev.Repos.syncedMusicPlaybackFrontend;
    if (!repo) throw new Error('syncedMusicPlaybackFrontend not available');
    if (!repo.canStopPlayback) throw new Error('Cannot stop music (check space/meeting permissions)');
    repo.stopPlayback();
    await new Promise(r => setTimeout(r, 300));
    return null;
  })()`,

  // ── discover-view: snapshot of all repos + videoViewMode API + locked label fiber
  // Temporary discovery tool — run before and after a manual "Meeting view" click, then diff.
  discoverView: `(function() {
    // A: all repo keys
    const allRepoKeys = Object.keys(window.gatherDev.Repos).sort();

    // B: videoViewMode full API
    const vmRepo = window.gatherDev.Repos.videoViewMode;
    const vmMethods = [];
    let p = Object.getPrototypeOf(vmRepo);
    while (p && p !== Object.prototype) {
      Object.getOwnPropertyNames(p).forEach(n => {
        if (n !== 'constructor' && typeof vmRepo[n] === 'function' && !vmMethods.includes(n)) vmMethods.push(n);
      });
      p = Object.getPrototypeOf(p);
    }
    const vmOwnNonFn = Object.keys(vmRepo).filter(k => typeof vmRepo[k] !== 'function');

    // C: all inputStates snapshot
    const repos = window.gatherDev.Repos;
    const inputStates = {};
    for (const key of Object.keys(repos)) {
      try {
        const r = repos[key];
        if (r && typeof r === 'object' && r.inputState !== undefined) {
          inputStates[key] = JSON.parse(JSON.stringify(r.inputState));
        }
      } catch(e) { inputStates[key] = 'err: ' + e.message; }
    }

    // D: "Locked conversation" React fiber path
    let lockedLabel = null;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walker.nextNode())) {
        if (n.textContent.trim() === 'Locked conversation') nodes.push(n.parentElement);
      }
      if (nodes.length) {
        const el = nodes[0];
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
        if (fiberKey) {
          let f = el[fiberKey];
          const path = [];
          for (let i = 0; i < 25 && f; i++) {
            const name = typeof f.type === 'function' ? (f.type.displayName || f.type.name) : null;
            if (name) path.push(name);
            f = f.return;
          }
          lockedLabel = { tagName: el.tagName, class: el.className, reactPath: path };
        } else {
          lockedLabel = { tagName: el.tagName, class: el.className, noFiber: true };
        }
      }
    } catch(e) { lockedLabel = 'err: ' + e.message; }

    // E: meeting-view-nav onClick
    let navInfo = null;
    try {
      const nav = document.querySelector('[data-testid="meeting-view-nav"]');
      if (nav) {
        const fk = Object.keys(nav).find(k => k.startsWith('__reactFiber'));
        if (fk) {
          const props = nav[fk]?.pendingProps || {};
          navInfo = {
            href: nav.href,
            onClick: props.onClick?.toString().slice(0, 800) ?? null,
            propKeys: Object.keys(props),
          };
        } else {
          navInfo = { href: nav.href, noFiber: true };
        }
      } else {
        navInfo = 'meeting-view-nav not in DOM';
      }
    } catch(e) { navInfo = 'err: ' + e.message; }

    return JSON.stringify({
      A_allRepoKeys: allRepoKeys,
      B_videoViewMode: { methods: vmMethods, ownNonFn: vmOwnNonFn, inputState: vmRepo.inputState },
      C_inputStates: inputStates,
      D_lockedLabel: lockedLabel,
      E_meetingViewNav: navInfo,
    }, null, 2);
  })()`,

  startDance: `(async function() {
  const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
  if (!u) throw new Error('currentSpaceUser not found');
  await u.startDancing();
  return true;
})()`,

  stopDance: `(async function() {
  const u = window.gatherDev.Repos.gameSpace.currentSpaceUserOrUndefined;
  if (!u) throw new Error('currentSpaceUser not found');
  await u.stopDancing();
  return false;
})()`,
};

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printState(state) {
  const s = typeof state === 'string' ? JSON.parse(state) : state;
  console.log(`status: ${s.avail}`);
  if (s.externalMeeting)          console.log(`meet:   EXTERNAL`);
  else if (s.hallwayConversation) console.log(`meet:   HALLWAY`);
  else if (s.lockAvail)           console.log(`meet:   ROOM`);
  console.log(`mic:    ${s.mic ? 'ON ' : 'OFF'}`);
  console.log(`cam:    ${s.cam ? 'ON ' : 'OFF'}`);
  console.log(`lock:   ${s.lockAvail ? (s.locked ? 'ON ' : 'OFF') : 'N/A (not in meeting)'}`);
  console.log(`hand:   ${s.handAvail ? (s.hand ? 'RAISED' : 'DOWN') : 'N/A (not in meeting)'}`);
  console.log(`share:  ${s.screenAvail ? (s.screen ? 'ON ' : 'OFF') : 'N/A (not in meeting)'}`);
  console.log(`record: ${s.recordAvail ? (s.record ? 'ON ' : 'OFF') : 'N/A (not in meeting)'}`);
  console.log(`view:   ${s.viewAvail ? (s.view === 'meeting' ? 'MEETING' : 'OFFICE') : 'N/A (not in meeting)'}`);
  console.log(`music:  ${s.musicAvail ? (s.music ? s.music.toUpperCase() : 'OFF') : 'N/A (not in meeting)'}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  if (!cmd || (cmd === 'status' && !arg)) {
    await withGather(async (ev) => {
      const raw = await ev(JS.getState);
      printState(raw);
    });
    return;
  }

  if (cmd === 'mic') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.toggleMic);
      else if (arg === 'on') result = await ev(JS.setMic(true));
      else if (arg === 'off') result = await ev(JS.setMic(false));
      else { console.error('Usage: mic [on|off]'); process.exit(1); }
      console.log(`mic: ${result ? 'ON' : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'cam') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.toggleCam);
      else if (arg === 'on') result = await ev(JS.setCam(true));
      else if (arg === 'off') result = await ev(JS.setCam(false));
      else { console.error('Usage: cam [on|off]'); process.exit(1); }
      await new Promise(r => setTimeout(r, 300));
      const raw = await ev(JS.getState);
      const s = JSON.parse(raw);
      console.log(`cam: ${s.cam ? 'ON' : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'hand') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.toggleHand);
      else if (arg === 'up') result = await ev(JS.setHand(true));
      else if (arg === 'down') result = await ev(JS.setHand(false));
      else { console.error('Usage: hand [up|down]'); process.exit(1); }
      console.log(`hand: ${result ? 'RAISED' : 'DOWN'}`);
    });
    return;
  }

  if (cmd === 'lock') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.toggleLock);
      else if (arg === 'on') result = await ev(JS.setLock(true));
      else if (arg === 'off') result = await ev(JS.setLock(false));
      else { console.error('Usage: lock [on|off]'); process.exit(1); }
      console.log(`locked: ${result ? 'ON' : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'status' && arg) {
    const validStatuses = { active: 'Active', away: 'Away', busy: 'Busy' };
    const normalized = arg.toLowerCase();
    const avail = validStatuses[normalized];
    if (!avail) {
      console.error('Usage: status <active|away|busy>');
      process.exit(1);
    }
    await withGather(async (ev) => {
      await ev(JS.setAvail(avail));
      console.log(`status: ${avail}`);
    });
    return;
  }

  if (cmd === 'share') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.screenToggle);
      else if (arg === 'on') result = await ev(JS.screenStart);
      else if (arg === 'off') result = await ev(JS.screenStop);
      else { console.error('Usage: share [on|off]'); process.exit(1); }
      console.log(`share: ${result ? 'ON' : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'quit') {
    await withGather(async (ev) => {
      const result = await ev(JS.goToDesk);
      console.log(result === '"already at desk"' ? 'quit: already at desk' : 'quit: moving to desk');
    });
    return;
  }

  if (cmd === 'record') {
    await withGather(async (ev) => {
      let result;
      if (!arg) result = await ev(JS.recordToggle);
      else if (arg === 'on') result = await ev(JS.recordStart);
      else if (arg === 'off') result = await ev(JS.recordStop);
      else { console.error('Usage: record [on|off]'); process.exit(1); }
      console.log(`record: ${result ? 'ON' : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'view') {
    const validViews = ['meeting', 'office'];
    if (arg && !validViews.includes(arg)) {
      console.error('Usage: view [meeting|office]');
      process.exit(1);
    }
    await withGather(async (ev) => {
      const result = !arg ? await ev(JS.viewToggle) : await ev(JS.viewSet(arg));
      console.log(`view: ${result.toUpperCase()}`);
    });
    return;
  }

  if (cmd === 'music') {
    const validTracks = ['ambient', 'lofi', 'energy', 'stop'];
    if (!arg || !validTracks.includes(arg)) {
      console.error('Usage: music [ambient|lofi|energy|stop]');
      process.exit(1);
    }
    await withGather(async (ev) => {
      const result = arg === 'stop' ? await ev(JS.stopMusic) : await ev(JS.playMusic(arg));
      console.log(`music: ${result ? result.toUpperCase() : 'OFF'}`);
    });
    return;
  }

  if (cmd === 'reaction') {
    const validReactions = ['wave', 'heart', 'tada', 'thumbsup', 'rofl', 'clap', '100', 'fire'];
    if (!arg || !validReactions.includes(arg)) {
      console.error('Usage: reaction [wave|heart|tada|thumbsup|rofl|clap|100|fire]');
      process.exit(1);
    }
    await withGather(async (ev) => {
      await ev(JS.sendReaction(arg));
      console.log(`reaction: ${arg}`);
    });
    return;
  }

  if (cmd === 'dance') {
    const seconds = parseFloat(arg);
    if (!arg || isNaN(seconds) || seconds < 0.5 || seconds > 10) {
      console.error('Usage: dance <seconds>  (between 0.5 and 10)');
      process.exit(1);
    }
    await withGather(async (ev) => {
      await ev(JS.startDance);
      await new Promise(r => setTimeout(r, seconds * 1000));
      await ev(JS.stopDance);
      console.log(`dance: done (${seconds}s)`);
    });
    return;
  }

  if (cmd === 'discover-view') {
    await withGather(async (ev) => {
      const result = await ev(JS.discoverView);
      const data = JSON.parse(result);
      console.log('=== A: All Repo Keys ===');
      console.log(data.A_allRepoKeys.join(', '));
      console.log('\n=== B: videoViewMode API ===');
      console.log('methods:', data.B_videoViewMode.methods.join(', '));
      console.log('own non-fn:', data.B_videoViewMode.ownNonFn.join(', '));
      console.log('inputState:', JSON.stringify(data.B_videoViewMode.inputState));
      console.log('\n=== C: All inputStates (diff before/after manual click) ===');
      console.log(JSON.stringify(data.C_inputStates, null, 2));
      console.log('\n=== D: "Locked conversation" label fiber ===');
      console.log(JSON.stringify(data.D_lockedLabel, null, 2));
      console.log('\n=== E: meeting-view-nav handler ===');
      console.log(JSON.stringify(data.E_meetingViewNav, null, 2));
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  console.error('Commands: status [active|away|busy] | mic [on|off] | cam [on|off] | lock [on|off] | reaction [wave|heart|tada|thumbsup|rofl|clap|100|fire] | hand [up|down] | share [on|off] | record [on|off] | view [meeting|office] | music [ambient|lofi|energy|stop] | dance <seconds> | quit');
  process.exit(1);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
