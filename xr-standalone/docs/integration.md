# Integration report: Human Orchestra XR ↔ Human Orchestra

Findings from a **read-only** inspection of `~/Desktop/Projects/human-orchestra` (branch `master`, `70d38b6`). Nothing there was edited, installed, committed or reconfigured.

## What the existing app is

| Area | Finding |
|---|---|
| Frontend | Vite multi-page, vanilla TypeScript, Tone.js. `index.html` = phone **Player**, `stage.html` = laptop **Stage** (the host; owns all audio). |
| Backend | One Node `http` server + the `ws` library (`server/index.ts`), WebSocket at `/ws`. Also deployable as a Vercel function (`api/ws.ts`). Optional Postgres/Neon only for saved recordings. |
| Protocol | JSON text frames, typed in `shared/protocol.ts` (`t` = message type). Raw WebSocket, **not** Socket.IO. |
| Rooms / QR | **Original server: none.** One global session; the Stage QR just opens the Player page. **Rooms build:** `hello` carries an optional `room` code (3-8 letters/digits) and only a Stage with `create: true` can open one. The XR app joins an existing room by code and never creates one. If a code is entered but the server's `welcome` does not echo it, XR reports that the server has no room support. |
| Players | `hello{kind:'player', id}` then `join{name}`. Server assigns a role (`drums, bass, melody, pads, guitar`) and colour; broadcasts `roster`. |
| Musical events | Phones send **pad indices**, not pitches: `note{step, d, v, dur}`. Server clamps/rate-limits and relays `note{pid, role, step, d, v, dur, midi?}` to every other socket. `step` is an absolute 16th-note step on the shared server clock. |
| Time | Server clock is ms since process start. `stepTime = epoch + step·stepMs(bpm)`. Clients sync with `ping/pong`. |
| Playback | MIDI/band playback is **scheduled inside the Stage browser**, not sent over the wire. The wire carries only `TransportState` (`bpm, epoch, key, scale, paused, drop, nowPlaying, game…`). |
| Auth | **None.** No tokens, no login. A socket is a "Stage" only because it says `hello{kind:'stage'}`; only Stage sockets may send `cmd`, `jam`, `game`. |
| Origin / CORS | `new WebSocketServer({ server, path })` with no `verifyClient`: **any web origin may connect**. No CORS headers on the HTTP API (XR does not use it). |
| Volume / mute | **Not exposed.** The mixer is local to the Stage's Tone.js engine (`engine.setMix`, channels `song/kick/snare/hat/open/clap/other`). No message touches it. |
| Liveness | Server drops a socket silent for 9 s (`SILENCE_MS`), so every client must heartbeat. |

## How XR connects

```
Human Orchestra server ──/ws JSON──▶ OrchestraConnection ──▶ orchestraAdapter ──▶ activity + zustand store ──▶ R3F scene
                                       (one socket, verify,    (normalise, clock-    (per-frame, no allocs)     desktop & Quest
                                        heartbeat, reconnect)   map, resolve pitch)
```

* **Observer (default):** `hello{kind:'player'}` with **no id** and no `join`. No seat is created, XR is invisible in the roster, and it only receives broadcasts (`state`, `roster`, `note`). It sends nothing but `hello` and `ping`.
* **Conductor (opt-in toggle):** `hello{kind:'stage'}`. Needed to send `cmd`. Because the server has no auth, this is the same self-declared trust the real Stage uses; the UI warns about it and it is off by default.
* The endpoint is trusted only after a well-formed `welcome` arrives; anything else is rejected. Connections happen only when the user presses Connect.

### Event mapping (all real, nothing invented)

| Server message | XR use |
|---|---|
| `welcome`, `state` | Transport: BPM, paused, song title, drop, nowPlaying/game; clock seed. |
| `roster` | Players on instrument seats, join/leave/role-change log. (Arrives at 1 Hz for unseated sockets.) |
| `note` (phone) | Scheduled at `stepTime(step)` converted to the local clock, so visuals land with the audio. `d`/`midi` resolved to real pitches with a mirror of `shared/music.ts` (`networking/music.ts`). Drum voice → kick/snare/hat/clap/open; pitch → piano keys, bass core, melody bars, guitar strings. |
| Jam / game with embedded song | `TransportState.nowPlaying{mode:'jam'}.song` and `game.song` carry full note tracks. XR walks them against the transport clock (`songPlayer.ts`). |
| `pong` | Clock offset (min-RTT window) and latency readout. |

### Limitations (documented, not faked)

* **Library "band/tap" songs and built-in game songs** broadcast only a title/id, not notes, so only the title and playback state show; no per-note visuals.
* **AUTO band parts** are generated locally in the Stage and never sent.
* `raw` (freestyle gestures) and `ghit` (rhythm-game hits) are **Stage-only** broadcasts; observers don't get them. Conductor mode would receive them but XR does not visualise them yet.
* Phone note events carry no per-note velocity beyond `v`; there are no MIDI-channel or "program" data.
* The jam visual walk does not loop; a looping preview would need the server to re-broadcast `nowPlaying`.
* Per-instrument **mute/volume cannot be real** (see below).

## Conductor controls

| Control | Status |
|---|---|
| Select instrument, view activity/players/playback | **Works** (client-side). |
| Pause / Resume | **Works** in Conductor mode (`cmd pause`), verified against the real server. |
| Beat drop | **Works** in Conductor mode (`cmd drop`). Verified. |
| Tempo | **Works** in Conductor mode (`cmd bpm`); the server ignores it during a game/jam, and the UI locks the slider then. Verified. |
| Mute / volume per instrument, global volume | **Disabled in the UI.** No server command exists. |

## Backend changes that would be needed (not applied)

See [`proposed-orchestra-patch.md`](proposed-orchestra-patch.md): a `mix` command + state field so XR can drive the Stage's mixer, and an optional auth token for Stage sockets. Apply them in the Human Orchestra repo yourself; XR does not require them to run.

## Secure-context / mixed-content

Quest Browser needs HTTPS for immersive WebXR, and an HTTPS page cannot open `ws://` to a LAN host. Options, all inside this project or using the Orchestra's own tooling:

1. **Dev bridge (default):** `npm run dev` serves XR over HTTPS and proxies same-origin `wss://<mac-ip>:<port>/ws` to `ORCHESTRA_TARGET` (default `http://localhost:3000`). It exists only while that dev server runs and forwards only to that one target.
2. **Orchestra tunnel:** the original's `npm run demo` prints an HTTPS/WSS public URL. Paste its host into the XR address field (`wss://xxxx.trycloudflare.com`).
3. **Deployed XR (Vercel/static):** point it at a `wss://` Orchestra (deployed or tunnelled). Because the Orchestra has no Origin check, no change is needed there. No secrets live in the XR code.
