# 🎼 Human Orchestra

Scan a QR code and your phone becomes an instrument. Everyone plays together, **in key and on the beat**, on a big shared screen. It works with a roomful of players, and it's worth watching with the sound off.

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

1. On the laptop open **http://localhost:3000/**, and click **"SOUND OFF · click to enable audio"** (browsers require a click).
2. Phones scan the QR on the Stage. The QR uses the tunnel URL automatically.
3. Plug the headphone splitter into the laptop. Audio plays from the Stage.

| Command | What it does |
|---|---|
| `npm run demo` | production build + server + cloudflared tunnel (what you want at the table) |
| `npm start` | build + server only (LAN demo: `http://<laptop-ip>:3000`; **no HTTPS, so no shake/tilt on iOS**) |
| `npm run dev` | Vite dev server (5173, hot reload) + server (3000); Stage at `localhost:5173/` |
| `vercel deploy --prod` | cloud copy at **https://horcha.vercel.app** (see "Vercel deployment") |
| `npm run tunnel` | tunnel only, if you run the server separately |
| `npm test` | offline checks: scale-lock + clock-sync accuracy simulation |
| `npm run test:network` | isolated live WebSocket regression tests (temporary server on port 3199) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run roomtest` / `npm run xrtest` | room-code isolation checks / VR networking against the real server |

The home page (`/`) is the Stage. Phones use `/mobile`; `/stage` remains an alias for the Stage.

### VR conductor (Meta Quest)

`/xr` is a mixed-reality view of the same session: each instrument floats in your room and lights up as phones play. Open `https://<this-site>/xr` in the Quest Browser, enter the room code shown on the Stage, press **Connect**, then **Enter Mixed Reality**. Observers are read-only; **Conductor** can pause, drop and change tempo. Per-instrument mute and volume are shown but disabled, because the server has no such command. The page is a separate bundle, so phones and the Stage never download the 3D code.

Room codes: each Stage creates its own room (shown on screen and in the QR link, `/mobile?room=ABCD`); phones and the VR page join it by code.

Stage keys: **N** advances the three-moment Judge demo, **W** opens “How it works,” **H** hides the conductor bar, and **F** toggles fullscreen. Less-used controls, sync test, and demo preflight are under **More**.

## Staying up to date with teammates

This checkout uses `public/master` as the team branch. `origin` is a separate
repository; the checker deliberately watches `public` only.

| Command | What it does |
|---|---|
| `npm run sync` | Fetch team branches now and print incoming commits, changed files, and overlaps with your work |
| `npm run sync:status` | Read the latest saved report; check its timestamp before relying on it |
| `npm run sync:start` | Enable a macOS background check every five minutes and at login |
| `npm run sync:stop` | Disable and uninstall the background check |
| `npm run sync:service` | Inspect the macOS background service |
| `npm run test:sync` | Verify fetch safety using isolated local repositories |

The checker only updates `public/*` remote-tracking refs and writes a report to
`.git/github-sync/latest.md` (Git resolves the location for worktrees). It never
pulls, merges, rebases, stashes, switches branches, commits, or pushes. Your editor
may show incoming changes after a fetch, but your working files stay untouched.
Read the report with `npm run sync:status`; it does not send notifications.
The report includes up to 25 incoming commits and ten recent remote branch tips.
File overlap means “review this,” not necessarily a merge conflict.

Background checks run while logged in and awake, using your existing Git
credentials without interactive prompts. Network/authentication failures are
reported explicitly and retried at the next interval. The service uses the current
checkout and Node path; stop and reinstall it if either moves. Keep the checker
scripts available on branches where you use it.

Before starting work, run `npm run sync` and review the report. For detailed changes:

```bash
git diff HEAD...public/master
```

Finish and commit your current work before manually merging:

```bash
git status
git merge public/master
```

Resolve any conflicts, then run `npm run typecheck`, `npm test`, and `npm run build`.
Start separate tasks on descriptive branches, such as `git switch -c feature/song-picker`.
Use a shared GitHub issue or draft PR to claim a task; fetched commits cannot show
work your teammate has not pushed yet. Push only when ready and to the intended
remote (for example, `git push -u public feature/song-picker`).

## How it works

### 1. Clock sync (`src/common/clock.ts`)
Each phone estimates `offset = serverTime − localTime` using NTP-style exchanges:

```
c0 = local.now()  ──ping──▶  s = server.now()      (stamped on receipt, before any parsing)
c3 = local.now()  ◀──pong──
rtt = c3 − c0         offset = s − (c0 + c3)/2
```

That formula assumes the path is symmetric. If it isn't, the offset is wrong by half the asymmetry, which can never exceed `rtt/2`. So:

1. A burst of 24 pings at lock-on (40 ms apart), then one probe every 1.5 s, in a sliding window of 48 samples;
2. **Keep only the lowest-RTT 30%.** Wi-Fi delay is "mostly fast, with random spikes", and the spikes are what create asymmetry;
3. **Median** offset of that slice, with jitter reported as the scaled MAD of the same slice;
4. After the first lock, the applied offset **slews** (max 1.5 ms per update) so audio never glitches. A jump over 50 ms (tab was frozen) snaps instead;
5. After a reconnect the estimate is thrown away and relocked, because the old one may be stale.

The server's clock is `process.hrtime` (monotonic), not `Date.now()`, so an NTP step on the laptop can't move the beat.

### 2. Beat-quantized scheduling (`shared/protocol.ts`, `src/player/main.ts`, `src/common/engine.ts`)
The **server owns the one transport**: `{bpm, epoch, key, scale, drop…}`. Step *N* (a 16th note) sounds at `epoch + N·stepMs`. A BPM change re-anchors `epoch` so the current step position stays continuous.

- A phone never sends a time or a pitch. It sends *"column 5, velocity 0.8, on step 1234"*, where 1234 is the first 16th boundary at least `lead` ms away. `lead` is 60–260 ms, scaled from the measured RTT and jitter.
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

**Participation shapes the sound:** the Stage schedules the complete arrangement 600 ms ahead. Missing chart notes weakens and shortens your instrument, with slight detuning on pitched parts and uneven accents on percussion. Four recent hits restore the clean sound. Each player contributes equally within their instrument section. Phone messages never retrigger past notes or move the shared beat.

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
  - **Three modes:** **🎸 Jam over melody** loops only the imported lead. Players add drums, bass, guitar and piano live on the shared beat; pitched instruments follow chords inferred from the MIDI, and the Stage has a melody-volume control. **🎮 Play along**: starts the rhythm game from the selected arrangement; missed pills weaken, shorten, and slightly detune your instrument, while four recent hits restore its clean sound; **♫ Listen**: previews the complete arrangement on the Stage. In Listen mode, accompaniment pads are ignored during playback; Jam mode accepts live, quantized accompaniment while the lead loops.
- `npm test` includes a composer test: sloppy synthetic playing at 120 BPM (±60 ms timing error) is recovered to 120 BPM and the right pitch set, and the MIDI export re-imports.

## Vercel deployment
`https://horcha.vercel.app` runs the same server as a Vercel Function (`api/ws.ts`; `/ws` is rewritten to it) and serves the built pages. It works, with one caveat: **the beat clock lives in memory**, and Vercel doesn't guarantee that every WebSocket lands on the same instance. With a handful of connections they do in practice (all connections reported the same transport epoch in testing), and a sync check is visible on the Stage. If the Stage and phones ever show different tempos or an empty roster, reload everything, or use `npm run demo`, which has no such limit. Sockets also close at the function's max duration (5 min on Hobby); clients reconnect and relock on their own. Cloud RTT is higher, so notes get a longer scheduling lead and feel slightly slower than on the local tunnel.

## Judge demo (60–90 seconds)

Start `npm run demo`, open the Stage at `http://localhost:3000/`, and enable audio. **More → Demo preflight** shows whether the HTTPS tunnel is reachable; wait for it before asking judges to scan. If the tunnel is unavailable, **Open player here** opens `/mobile?room=CODE` on the same laptop as the Stage at `/`.

| Moment | Do | Say |
|---|---|---|
| **1 · Scan + play** | Press **NEXT** (or **N**). AUTO fills unclaimed parts. A judge scans the QR, joins, and touches a pad. | “Your phone joins the shared key and becomes an instrument. AUTO fills the band around you.” |
| **2 · One shared beat** | Press **NEXT**. Point to the phones flashing together and the enlarged **SYNC ERROR** readout. | “Each screen follows the same server clock locally; the live p90 shows how well its offset predicts new pings.” |
| **3 · The drop** | Press **NEXT**. The server schedules a two-bar build, then the band returns together on the bar line. | “The drop is one shared transport event, not a cue sent separately to each phone.” |

Use the remaining time to open **W · How it works** and explain the ping/pong midpoint estimate and lowest-RTT 30% filter. For 240 fps evidence, open **More → Sync test**; it flashes the Stage and phones white with a shared beat number and logs per-phone p90 sync errors to the console.

## Acceptance status

|---|---|
| Criterion | Current status |
|---|---|
| Sync error < ~30 ms with 3 phones | **Not measured on real phones or venue Wi-Fi yet.** Simulations and localhost tests are not camera measurements. Use Sync test to film the shared beat counter at 240 fps and compare frame offsets; the Stage console reports each phone’s p90 estimate. |
| Musical within 15 s | **Not user-timed yet.** The intended path is open Stage → scan → join → touch pad; AUTO supplies unclaimed parts. Time this with a first-time participant at the event. |
| Sound-muted clarity | **Implemented, not observer-tested.** Role lanes, AUTO labels, beat grid, synchronized phone flashes, and the Stage sync readout remain visible with audio off. |
| Solo mode sounds like a band | **Automated behavior verified.** With one player, AUTO generates the missing instrument roles; confirm the mix over the actual table speakers. |
| Clean reconnect | **Automated behavior verified.** `scripts/smoke.ts` covers socket drop/rejoin and seat restoration; venue Wi-Fi still needs a live check. |

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
src/player/          phone UI (mobile.html)
src/stage/           big-screen UI (index.html; stage.html alias), visuals.ts, auto.ts
scripts/             tunnel.mjs, smoke.ts (protocol), simtest.ts (sync), musictest.ts
```

## Engineering notes

This application has one shared room per server process. Reload Stage and phones together after an update so they use the same transport and message version.

### Rhythm-game participation

The Stage schedules the whole arrangement ahead to keep the beat steady. Each connected player controls an equal share of their instrument's sound using their last four chart notes. Misses reduce volume and sustain and add up to 32 cents of alternating detune; percussion loses strength and accent consistency. Unassigned instruments provide clean backing. Musical rests do not count as misses, late joiners start clean, and the phone's timing window plus 350 ms of network slack is allowed before a miss affects upcoming notes. Delayed valid hits can still restore the recent phrase, without replaying past notes.

Tap the colored lanes or the buttons below them when pills reach the line. Keyboard: D/K on easy, D/F/K on medium, D/F/J/K on hard. The rhythm meter shows your own recent participation; shared instruments blend everyone's contribution. Listen mode remains a clean preview.
