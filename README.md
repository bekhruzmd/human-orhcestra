# 🎼 Human Orchestra

Scan a QR code and your phone becomes an instrument. Everyone plays together, **in key and on the beat**, on a big shared screen. It works with 1–3 players, and it's worth watching with the sound off.

```
phones (Player)  ──ws──▶  Node server  ◀──ws──  Stage (laptop, plays the audio)
 XY pad / shake / tilt     global transport        visuals, AUTO band, conductor
 flash on every beat       clock-sync pongs        recorder
```

## Setup

Needs Node 20+ (tested on 22).

```bash
npm install
brew install cloudflared      # free HTTPS tunnel (Windows: winget install Cloudflare.cloudflared)

npm run demo                  # build + server + HTTPS tunnel
```

`npm run demo` prints a public `https://….trycloudflare.com` URL. Then:

1. On the laptop open **http://localhost:3000/stage**, and click **"SOUND OFF · click to enable audio"** (browsers require a click).
2. Phones scan the QR on the Stage. The QR uses the tunnel URL automatically.
3. Plug the headphone splitter into the laptop. Audio plays from the Stage.

| Command | What it does |
|---|---|
| `npm run demo` | production build + server + cloudflared tunnel (what you want at the table) |
| `npm start` | build + server only (LAN demo: `http://<laptop-ip>:3000`; **no HTTPS, so no shake/tilt on iOS**) |
| `npm run dev` | Vite dev server (5173, hot reload) + server (3000); Stage at `localhost:5173/stage.html` |
| `vercel deploy --prod` | cloud copy at **https://horcha.vercel.app** (see "Vercel deployment") |
| `npm run tunnel` | tunnel only, if you run the server separately |
| `npm test` | offline checks: scale-lock + clock-sync accuracy simulation |
| `npm run test:network` | isolated live WebSocket regression tests (temporary server on port 3199) |
| `npm run typecheck` | `tsc --noEmit` |

Stage keys: **H** hides the conductor bar, **F** toggles fullscreen.

## How it works

### 1. Clock sync (`src/common/clock.ts`)
Each phone estimates `offset = serverTime − localTime` using NTP-style exchanges:

```
c0 = local.now()  ──ping──▶  s = server.now()      (stamped on receipt, before any parsing)
c3 = local.now()  ◀──pong──
rtt = c3 − c0         offset = s − (c0 + c3)/2
```

That formula assumes the path is symmetric. If it isn't, the offset is wrong by half the asymmetry, which can never exceed `rtt/2`. So:

1. a burst of 24 pings at lock-on (40 ms apart), then one probe every 1.5 s, in a sliding window of 48 samples;
2. **keep only the lowest-RTT 30%.** Wi-Fi delay is "mostly fast, with random spikes", and the spikes are what create asymmetry;
3. **median** offset of that slice, with jitter reported as the scaled MAD of the same slice;
4. after the first lock, the applied offset **slews** (max 1.5 ms per update) so audio never glitches. A jump over 50 ms (tab was frozen) snaps instead;
5. after a reconnect the estimate is thrown away and relocked, because the old one may be stale.

The server's clock is `process.hrtime` (monotonic), not `Date.now()`, so an NTP step on the laptop can't move the beat.

### 2. Beat-quantized scheduling (`shared/protocol.ts`, `src/player/main.ts`, `src/common/engine.ts`)
The **server owns the one transport**: `{bpm, epoch, key, scale, drop…}`. Step *N* (a 16th note) sounds at `epoch + N·stepMs`. A BPM change re-anchors `epoch` so the current step position stays continuous.

- A phone never sends a time or a pitch. It sends *"column 5, velocity 0.8, on step 1234"*, where 1234 is the first 16th boundary at least `lead` ms away. `lead` is 60–150 ms, scaled from the measured RTT and jitter.
- The server clamps absurd steps and rate-limits each phone, then relays the event.
- Every listener maps `step → server time → local time → AudioContext time` and schedules the synth at that exact time, compensating output latency. Network delay only decides whether the message arrives *before* its step. If it's late, it plays immediately and counts as a "late note" in the debug drawer. If it's more than 250 ms late, it's dropped.
- The Stage uses no Tone.Transport; there is exactly one transport and it's on the server.

### 3. Musical guardrails (`shared/music.ts`)
- Players send **indices**, never pitches: melody has 8 columns of the scale, bass picks chord tones (root/5th/♭7/octave), pads pick a chord voicing, drums pick a voice. An out-of-key note can't be represented.
- Pitches are resolved at playback from the current key, scale and chord. Change the key on the Stage and every phone re-pitches instantly.
- A 4-bar chord loop per scale (C minor: **Cm – A♭ – E♭ – B♭**). Bass and pads follow it automatically.
- **Chord-aware nudge:** a scale tone a semitone from a chord tone (e.g. E♭ over B♭) is moved to the nearest scale tone that doesn't clash. `scripts/musictest.ts` checks that all 1,536 melody-note/chord/scale/key combinations stay in key, and that 216 get nudged.
- Shake hits pick the drum voice from the groove (kick on 1 and 3½, snare on 2 and 4), so any rhythm of shaking fits.
- Holding a finger repeats the note on the role's own rhythm (8ths for melody, quarters for bass, once a bar for pads), so a first-time user gets a pattern from a single touch.

### 4. Synchronized flash and the sync-error readout (`src/common/beat.ts`)
The flash is not triggered by a message. Every device computes `beat = floor((serverTime − epoch) / beatMs)` from its own synced clock every frame, so phones flash together exactly as well as their clocks agree.

The **sync error** number on the Stage and in each phone's drawer is **measured, not assumed**:

- **p90 held-out residual:** every fresh low-RTT probe is compared with the offset currently being applied. A good estimate predicts new probes well; a drifting one doesn't.
- **+ flash quantisation:** the mean timing error of the flash frame versus the true beat (≤ half a 60 Hz frame).
- **path bound ±rtt/2** is shown next to it as the worst case that no NTP-style method can see past.

Honest limits: the residual can't detect a *constant* asymmetry (e.g. uplink 2 ms, downlink 14 ms), which shifts every probe equally. That's why the bound is displayed too. `npm run simtest` demonstrates this with a hidden ground truth: sub-millisecond on clean links, and a floor of `(down−up)/2` on a 2 ms/14 ms path.

### 5. Other pieces
- **AUTO band** (off by default in the quiet lobby; `src/stage/auto.ts`): any role with no human gets a generated part, drawn as a dashed lane labelled **AUTO** and played at lower volume. The header says "SOLO · AUTO BAND BACKING" with one player and "DEMO · AUTO BAND" with none.
- **Drop:** the server schedules a 2-bar build starting on the next bar line. Drums and bass drop out, and the Stage plays a noise riser and a snare roll that accelerates from 8ths to 16ths to 32nds. Everything returns with a kick, crash and white flash on the bar line.
- **Phone speakers:** the Stage's *PHONES AS SPEAKERS* button (or a phone's own toggle) makes each phone play its own part locally at the same step times. The Stage then stops playing that player (it still draws them). AUTO parts always stay on the Stage.
- **Reconnect:** each tab keeps an id in `sessionStorage`. After a drop the socket reconnects with back-off, the phone re-hellos and relocks its clock, and the server restores its seat, name, colour and role. The seat is held for 90 s, and a silent socket is declared dead after 9 s. Verified by killing and restarting the server mid-session: phones came back on their own.
- **Recorder** (`src/common/recorder.ts`): keeps a rolling 30 s of the Stage's final output and saves it as a **WAV**. See "Deviations" below.

## 🎮 Play a recognizable song (main mode)

1. Run `npm run demo` and open the laptop Stage. Use its speakers or a wired output.
2. Press **PLAY A SONG → YOUR SONG (.mid)** to import a MIDI arrangement, or select a built-in example.
3. Choose **Import melody only** for just the hook. For multitrack files, use **Melody part** to select the actual lead/vocal line; the automatic choice is the highest-pitched part.
4. **Preview selected** before starting. Imports are saved in this browser (up to 20, subject to browser storage capacity).
5. Choose a difficulty and **START**. Phones receive the same arrangement and show playable charts. Audio is enabled from the Start/Preview click.

**Assisted performance:** the Stage schedules the complete arrangement 600 ms ahead. Successful taps score points and lift upcoming notes for that instrument. Without recent hits that part softens; the tune continues. Phone messages never retrigger past notes, add random pitches, or compete to advance a shared melody cursor. This deliberately replaces the old “only successful taps make sound” rule.

All song audio comes from the Stage, regardless of phone-speaker settings. Several people can play the same part without doubling its audio. Difficulty simplifies the phone chart while the complete arrangement remains audible. The Stage shows a late-audio-event counter separately from clock estimates.

Phones have a saved **Timing −/+** adjustment (−200 to +200 ms). Positive values move both the hit line and judgment later if the sound feels late. This aligns a device's scoring/display; it cannot remove network asymmetry or make late packets travel backward in time.

MIDI import preserves supplied pitches, supports up to 256 bars / 12,000 source notes / 5 MB, and rejects unsupported tempo changes rather than playing them at the wrong speed. Timing is quantized to the shared sixteenth-note grid. General MIDI patches are replaced with the app's simpler piano-like voices and drum kit, so this is not the original recording. MP3/Spotify links are not MIDI files. No invented harmony is added to imported melodies.

For songs such as **California Gurls, Down, and Ride It**, supply an appropriate MIDI arrangement. Those tracks are not bundled. A synthesized cover still uses the copyrighted composition; see the [U.S. Copyright Office's explanation](https://www.copyright.gov/register/pa-sr.html).

`npm test` includes audio-timeline regression tests with missing taps and 0–2,500 ms delayed hits, MIDI parsing and validation, chart/scoring checks, music guardrails, and clock simulation. `URL=ws://localhost:3000/ws npx tsx scripts/smoke.ts` checks the live protocol, including imported-song distribution and late joins.

## 🎚️ Make music with your own audio (MP3 / WAV)
Press **🎚️ SAMPLE** on the Stage and choose or drop an audio file (MP3, WAV, M4A, OGG, FLAC: whatever the browser can decode). **The file stays in the Stage's browser; nothing is uploaded to the server.** The app detects its tempo and beat grid (`src/stage/audioanalysis.ts`) and shows the waveform with the beat lines and the 16 slices.

- **🎛️ PHONES PLAY SLICES:** every phone becomes a 4×4 pad. Each pad plays one slice of the track (pad 1 = first beat of the grid, reading order). A tap is quantized to the next 16th note and re-timed to the room's tempo, so any rhythm stays in time; holding a pad re-triggers it every beat (stutter). Taps from several phones layer.
- **▶ BACKING LOOP:** the whole track loops under the band, bar-aligned to the shared transport (whole bars only, so it never drifts). Free play and everything else works on top.
- **Fixing the analysis by ear:** half/double-time is the classic mistake, so there are **½× / 2×**, **±1 BPM**, grid **◂ beat / beat ▸ / ◂ bar / bar ▸**, and slice length (**½ / 1 / 2 beats**) buttons; the waveform updates live. The white bar lines should sit on the beats.
- Tempo: the room is set to the file's BPM (rounded); the small remainder is absorbed by playback rate. The tempo slider is locked while a sample is active, and starting a rhythm game stops it.
- Recorded by the 30-second recorder like everything else. Anything you upload stays your responsibility: use audio you have the rights to use.
- Tests: `scripts/audiotest.ts` (tempo + beat phase recovered from synthetic tracks at 75-150 BPM within ~1 BPM and ~13 ms); in a browser a real 128 kbps MP3 was uploaded, detected at 118.0 BPM, and every phone tap played a slice with no late notes.

## Freestyle → song, and bring-your-own MIDI
- **🎤 FREESTYLE** (Stage conductor bar) turns the guardrails *off*: phone pads become continuous, un-quantised, un-locked keyboards. Phones stream raw gestures (pointer down/move/up, shakes, tilt) stamped with synced server time; the Stage records them and makes sound immediately so people hear what they do. Press **■ STOP · MAKE SONG** and `src/stage/composer.ts` builds a song (all free, deterministic, in the browser): notes from gestures → tempo by grid search over the onsets → key by scoring 12 roots × 4 scales → pitches snapped to the key, rhythm quantised, lead made monophonic and chord-aware, phrase tiled over 8 bars with a lift in the second half → missing parts generated from how energetic the jam was. The result loops on the shared transport, and phones can keep playing on top in normal mode.
- Result card: **Restart / Stop / ⬇ MIDI** (opens in any DAW) **/ ⬇ JSON** (the raw gestures + the composed song, for your own processing).
- **🎵 Songs** (Stage button, and the 🎵 button on every phone): anyone can pick a song.
  - **Built in:** public-domain tunes (Ode to Joy, Twinkle Twinkle, Jingle Bells, Mary Had a Little Lamb, Frère Jacques) and chord-loop backing tracks (four-chord pop loop, Canon progression, sad minor loop, Andalusian, 12-bar blues). Definitions live in `src/songs/library.ts`.
  - **Your own songs:** drop `.mid` files into `public/songs/` (git-ignored) and run `npm run build` / `npm run dev` (they run `scripts/songs.mjs`, which lists the folder). They appear in the picker on the Stage and phones, tagged "yours". Or use **Load .mid file…** in the Stage picker to load one from disk on the spot, which works on the Vercel copy too. MIDI mapping: channel 10 → drums, highest-pitched channel → melody, lowest → bass, the rest → pads; the key is detected so the phones' pads fit. No copyrighted song data ships with the app.
  - **Two modes:** **🎮 Play along**: starts the assisted rhythm game from the selected arrangement; **♫ Listen**: previews the complete arrangement on the Stage. Pad notes are ignored during playback so they cannot clash with it.
- `npm test` includes a composer test: sloppy synthetic playing at 120 BPM (±60 ms timing error) is recovered to 120 BPM and the right pitch set, and the MIDI export re-imports.

## Vercel deployment
`https://horcha.vercel.app` runs the same server as a Vercel Function (`api/ws.ts`; `/ws` is rewritten to it) and serves the built pages. It works, with one caveat: **the beat clock lives in memory**, and Vercel doesn't guarantee that every WebSocket lands on the same instance. With a handful of connections they do in practice (all connections reported the same transport epoch in testing), and a sync check is visible on the Stage. If the Stage and phones ever show different tempos or an empty roster, reload everything, or use `npm run demo`, which has no such limit. Sockets also close at the function's max duration (5 min on Hobby); clients reconnect and relock on their own. Cloud RTT is higher, so notes get a longer scheduling lead and feel slightly slower than on the local tunnel.

## Optional free-play demo (2 minutes, judges in groups of 2–3)

For the song experience, use the main-mode flow above. This older free-play demo needs AUTO enabled explicitly; the lobby now starts quietly.

| Time | Do | Say |
|---|---|---|
| 0:00 | Stage already up, **muted**. AUTO band is drawing. Point at the QR. | "Scan this. Your phone becomes an instrument." |
| 0:10 | Judge 1 scans and taps **JOIN**. They land on Drums with a prefilled name. | "It's already in time. Tap or shake." |
| 0:20 | The Stage header turns to **SOLO · AUTO BAND BACKING**. | "One person, full band. The dashed lanes are generated." |
| 0:30 | Judge 2 joins and gets Bass. Judge 3 joins as Melody, drags a finger across the pad. | "Everyone's locked to one key. You can't play a wrong note." |
| 0:50 | **Unmute** the audio, or keep it off and point at the screen. | "With the sound off you can still see who plays what. The dots in the grid line up." |
| 1:00 | Point at every phone flashing together, then the **SYNC ERROR** readout. | "Every phone flashes on the same beat from a shared clock. That number is measured live, per phone." |
| 1:15 | Change **KEY** and **SCALE** on the Stage. | "Same fingers, new mood." |
| 1:25 | Hit **DROP**. | "Build-up, then the beat comes back." |
| 1:40 | Tap **PHONES AS SPEAKERS**. | "Now the phones are the speaker array." |
| 1:50 | Hit **SAVE LAST 30 s**. | "And you take the jam home." |

Backup plan: if Wi-Fi is bad, open the Stage and one phone on the same laptop (`/` and `/stage`), where the sync is near-perfect.

## Acceptance status

| Criterion | Status |
|---|---|
| Sync error < ~30 ms with 3 phones | **Not yet measured on real phones/Wi-Fi.** Headless Chromium on localhost shows 2–9 ms (almost all frame quantisation). The simulation shows 0–6 ms across four network profiles, with a floor of half the path asymmetry. Verify at the venue: film all phones plus the Stage at 240 fps (iPhone slo-mo) and compare flash frames. The on-screen number is the estimate; the camera is the ground truth. |
| Musical within 15 s | One tap to join with a prefilled name; one touch on the pad makes a note, and holding makes a pattern. Not timed with real first-time users. |
| Sound muted, observer can tell who plays what and that all are in time | Lanes, colours, AUTO badges, step-grid dots, synchronized flashes. |
| Solo mode sounds like a band | Verified in a browser run: 1 player → 3 dashed AUTO lanes for the missing roles. |
| Clean reconnect | Verified by server restart in the browser test, and by dropped sockets in `scripts/smoke.ts`. |

## Deviations from the brief
- **Recorder uses a PCM ring buffer, not MediaRecorder.** MediaRecorder can't produce a valid file from a *rolling* window, because only the first chunk carries the container header. Tapping the final output with an AudioWorklet and writing a WAV on demand gives a file that always plays. The cost is ~11 MB of memory for 30 s and a WAV instead of webm.
- **Phone-speaker audio on iOS** needs the silent switch off, or Safari's `audioSession` API (the code sets it, but older iOS may ignore it).

## Troubleshooting
- **Phone says "denied" for Shake:** needs HTTPS (use `npm run demo`) and a tap on the button. On iOS, Settings → Safari → Motion & Orientation Access must be on.
- **Stage silent:** click the red "SOUND OFF" button. Chrome blocks audio until you do.
- **Audio feels late or early vs the flashes:** Bluetooth speakers add 100+ ms. Use wired headphones, or open a phone's ⏱ drawer (and the Stage console: `ho.engine.trimMs = -40`) to trim.
- **Quick tunnels sometimes take ~10 s** to become reachable. Wait for the URL before showing the QR.
- **Stuck seat/role:** restart the server (`Ctrl-C`, `npm run demo`); phones reconnect on their own.

## Layout
```
shared/protocol.ts   wire messages, transport math (step <-> time)
shared/music.ts      scales, chord loops, index -> pitch, chord-aware snapping
server/index.ts      static files, WebSocket, global transport, relay + guardrails
src/common/          clock.ts, net.ts, beat.ts, engine.ts (Tone), recorder.ts
src/player/          phone UI (index.html)
src/stage/           big-screen UI (stage.html), visuals.ts, auto.ts
scripts/             tunnel.mjs, smoke.ts (protocol), simtest.ts (sync), musictest.ts
```

## Second-pass engineering review

See [SECOND_PASS_REVIEW.md](SECOND_PASS_REVIEW.md) for the prioritized audit, implemented fixes, executed checks, remaining limitations and 60–90 second demo flow. This application has one shared room per server process. Reload Stage and phones together after this update to use the revised hit/stat messages.
