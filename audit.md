# Human Orchestra: Project Audit

> **Working-tree update, 2026-10-10 (after `90cd05d`):** the original audit below is historical. The user tested on a real phone and reported bad synchronization and incoherent music. The current local implementation switches the main song game to assisted playback: Stage schedules the complete arrangement ahead; hit messages only lift future dynamics and update scores. Misses no longer remove notes. See README's updated main-mode instructions. Deployed to production at https://horcha.vercel.app on 2026-10-10 (deployment `dpl_9ntZHi9i76PXZx4kaUsZ85n2vaiN`).

> **Working-tree update, 2026-10-10 (MP3 sampler):** added "make music with your own audio". See section 4.5. Not committed to git yet: the working tree also holds the earlier uncommitted assisted-playback changes, so a commit would mix the two.

### Update: upload an MP3 and make music with it

- **What:** Stage button **🎚️ SAMPLE** loads any decodable audio file (tested with a real MP3 and a WAV). It stays in the Stage's browser; the server only learns `{title, mode}`. New shared state `TransportState.sample` and `cmd: 'sample'` (locked while a game runs; starting a game clears it).
- **Analysis** (`src/stage/audioanalysis.ts`, pure functions): onset envelope (high-passed RMS + a kick-band envelope), autocorrelation over 60-180 BPM with a mild prior near 115 BPM, fine comb search at 0.1 BPM, beat phase from the kick-weighted comb, grid moved to the first real onset. First version locked onto off-beat hi-hats (≈200-400 ms phase error); adding the kick-band envelope fixed it (≤13 ms on all test tracks).
- **Modes:** *Chop* (phones show a 4×4 slice pad; taps send the normal quantised `note` with `d` = slice index; Stage plays `slice = offset + d*sliceLen` at the step time) and *Backing loop* (whole bars looped, started on a bar line). Both use `playbackRate = transportBpm / fileBpm`. Engine additions: `decode`, `playSample`, `stopSamples` (separate from the instrument voices; samples feed the master bus so the recorder hears them).
- **Controls:** ½×/2×, ±1 BPM, grid by beat/bar, slice length ½/1/2 beats, live waveform with beat lines and slice shading.
- **Phone:** sampler grid with hold-to-retrigger each beat; local synth speaker is muted in sampler mode. Also fixed a stale pad bitmap when the line above the pad wraps and the pad changes height.
- **Verification:** `scripts/audiotest.ts` passes (added to `npm test`). Playwright with a real 128 kbps MP3 and a WAV: detected 118.0 BPM, 7/7 taps played slices, 0 late audio events, backing loop started, Stop restored free play, 0 console errors. Regressions on this build: free play (3 phones), rhythm-game solo run (56/56), typecheck, build. `scripts/smoke.ts` passes (14/14) on a **fresh** server; it uses fixed player ids and fails role/roster checks if earlier sessions left seats on the server, which is a test-isolation property, not a product bug.
- **Unverified:** real phones, iOS Safari decoding of every format, accuracy on real music (only synthetic click tracks and one synthetic MP3 were analysed; dense or beat-less music will need manual grid/tempo correction), and how it sounds by ear.
- **Legal note:** the app ships no audio; the user supplies the file and it is processed locally. Rights to the audio are the user's responsibility.

### Changes after the original audit

- Fixed the causal timing bug: tapping on the beat used to request playback in the past, producing late/dropped/requantized notes. Game packets now carry participation, not audible note triggers; the server rejects legacy note packets during games.
- Stage schedules all song parts 600 ms ahead, independent of phone packet arrival. Multiple players on one role do not double the sound. The original complete arrangement plays on every difficulty.
- Fixed roster refreshes destroying `song:` voices once per second; arrangement voices survive roster changes. Disposed effect sends now get cleaned up. Song-mode voices use a cleaner piano-like sound, reduced reverb, and no lead echo. Idle AUTO band is off by default.
- Imported MIDI is playable directly from the main game picker, with preview, browser persistence, melody-only mode, and manual melody-part selection. Validated arrangement data travels with game state so phones and late joiners use the same chart. Empty roles are reassigned to an available part.
- Imports no longer silently truncate at 16 bars or discard tracks with fewer than four notes. Limits: 256 bars, 12,000 source notes, 5 MB. Variable-tempo files are rejected explicitly. MIDI still uses sixteenth-note quantization and synthesized voices, not original instrument patches or recordings.
- Removed the shared tap-along melody cursor; legacy Play along requests now start the assisted game. Unrelated pad notes cannot overlay a song preview.
- Phone timing adjustment shifts display and judging together, persists locally, and is bounded to ±200 ms. Game setup waits for clock lock. Clock restarts cancel the previous probe timer.
- Stage Start/Preview enables audio; the game HUD shows actual late audio events. The phone join screen directs listeners to Stage audio.

### Verification for this update

- Production deployment completed with status READY. Live headless-browser checks: Stage and phone HTTP 200, updated MIDI picker visible, WebSocket connected, Stage and independent phone connection shared the same transport epoch/BPM, no browser errors. These checks did not start a public game. Vercel emitted missing-type-definition diagnostics during function transpilation but completed the deployment; local typechecking passes and live runtime checks succeeded.

- Typechecking, production build, existing offline suite, plus new `scripts/playbacktest.ts` pass. Live `scripts/smoke.ts` passes all 17 checks, including imported arrangement distribution, role reassignment, late joining, legacy-note rejection, invalid-import handling, and stopping.
- Deterministic playback regression: absent taps and delays of 0/80/250/800/2500 ms preserve the entire audible timeline (pitches, steps, durations, note counts). Timely hits affect future velocity only; stale hits are ignored.
- Independent MIDI fixture exercises running status and short tracks; regression checks cover long imports, malformed input, tempo-change rejection, melody-only conversion and server-side arrangement validation.
- Headless Chromium: Stage + three 390×844 simulated phones, imported 16-note tune, hit-message delays of 0/250/800 ms. All phones scored 16/16 Perfect, Stage emitted exactly 16 notes, zero late audio events, zero browser errors. Melody-part selection, melody-only import, preview, results, replay and persistence across Stage reload were exercised.
- Captured Stage WAV: non-silent (peak about 0.277 full scale), no full-scale clipped samples. This validates audio output, not subjective musical quality.
- **Still unverified:** the revised build on real iOS/Android hardware and venue Wi-Fi, and its subjective mix by ear. “California Gurls,” “Down,” and “Ride It” are the user's desired repertoire; no supplied MIDI files exist yet and those songs have not been bundled. Their melodies remain copyrighted compositions even when synthesized.

---


Everything built, decided, tested and shipped so far, written so someone who wasn't there can pick the project up. Written 2026-10-10 against commit `90cd05d`.

**Status in one line:** a working multiplayer rhythm game (plus free play, freestyle composing and a song library) deployed at https://horcha.vercel.app and pushed to https://github.com/bekhruzmd/human-orhcestra. It has been tested in headless Chromium, in Node scripts and in a clock simulation. It has **not** been tested on real phones, real venue Wi-Fi, iOS Safari, or by ear.

---

## 1. What it is

Phones scan a QR code and become instruments. A Node server owns one shared transport (tempo, bar, beat). A laptop "Stage" plays the audio and shows the visuals. Everything is built to be impressive with the sound off, and to work with 1 to 3 players.

| Piece | Role |
|---|---|
| Server (`server/index.ts`) | Static files, WebSocket relay, the single global transport, clock-sync replies, guardrails, game start/stop |
| Stage (`stage.html`, `src/stage/`) | Laptop / big screen: plays all audio, draws lanes and the beat grid, shows the QR, conductor controls, game menus and results |
| Player (`index.html`, `src/player/`) | Phone: joins, shows free-play pad or the rhythm highway, flashes on the beat |
| Shared (`shared/`) | Wire protocol and transport math, music theory, rhythm-game data layer, song library |

**Stack:** Node + TypeScript, `ws`, Vite + TypeScript clients, Tone.js for audio, `qrcode` for the QR. Free tools only; no paid APIs. HTTPS for phones via a free cloudflared quick tunnel, or via Vercel.

---

## 2. Timeline (git history)

| Commit | Date | What |
|---|---|---|
| `7f3126c` | 10-09 | Step 1: server transport, NTP-style clock sync, synchronized beat flash with measured sync error |
| `3954fb9` | 10-09 | Steps 2-3: melody XY pad heard on Stage; all four roles, scale lock, chord-aware snapping, beat quantisation |
| `fd1c569` | 10-09 | Steps 4-6: Stage visuals, AUTO band, conductor controls, phone-speaker mode, rolling recorder |
| `e44a146` | 10-09 | Tunnel helper, README, tests |
| `0df2e26` | 10-09 | README numbers corrected to match measurements |
| `a9b7b85` | 10-10 | Vercel deployment, engine start-time fix, RTT-scaled note lead |
| `c5c4d65` | 10-10 | Phone flash-mode toggle (soft default / full / off), tighter bottom bar |
| `14a63fd` | 10-10 | Freestyle jam capture, algorithmic composer, MIDI import/export, song loop player |
| `fec0909` | 10-10 | Song library, bring-your-own-MIDI folder, tap-along mode, phone song picker |
| `90cd05d` | 10-10 | **Rhythm game**: song library, note highway, scoring, 3 difficulties, solo mode, results |

The original brief's six build steps were followed in order, except steps 2 and 3 share a commit because the audio engine was written once for all four roles.

---

## 3. Architecture and key mechanisms

### 3.1 Clock sync (`src/common/clock.ts`)
- NTP-style exchange: client stamps `c0`, server stamps `s` on receipt (before parsing), client stamps `c3` on reply. `rtt = c3 - c0`, `offset = s - (c0 + c3) / 2`.
- Asymmetric paths make any single estimate wrong by up to `rtt/2`, so: sliding window of 48 samples, **keep only the lowest-RTT 30%**, take the **median** offset. Jitter is the scaled MAD of the same slice.
- 24-ping burst on connect (40 ms apart), then one probe every 1.5 s. After lock, the applied offset slews at most 1.5 ms per update; jumps over 50 ms (frozen tab) snap. After a reconnect the estimate is discarded and relocked.
- Server time is `process.hrtime` (monotonic), not `Date.now()`.
- **Displayed "sync error"** is measured: the p90 of held-out residuals (each fresh low-RTT probe vs the offset currently applied), plus flash-frame quantisation. The `rtt/2` path bound is shown beside it.

### 3.2 Transport and beat-quantized scheduling (`shared/protocol.ts`)
- The server owns `{bpm, epoch, root, scale, drop, autoBand, speakerMode, freestyle, nowPlaying, game}`. Step N (a 16th note) sounds at `epoch + N * stepMs`. A BPM change re-anchors `epoch` so the step position stays continuous.
- Phones never send times or pitches in normal play; they send "column 5, velocity 0.8, on step 1234", where the step is the first 16th boundary at least `lead` ms away. `lead` scales with measured RTT (`40 + 1.1*rttMin + 3*jitter`, clamped 60-260 ms).
- Every listener maps step → server time → local time → AudioContext time (using the native context's `getOutputTimestamp` / `outputLatency` where available) and schedules the synth at that exact time. Late messages play ASAP and count as "late notes"; over 250 ms late they are dropped.
- No Tone.Transport is used; the only transport is on the server.

### 3.3 Musical guardrails (`shared/music.ts`)
- Pads send indices, never pitches. Out-of-key notes are unrepresentable in normal play.
- Four scales (minor/major pentatonic, dorian, blues), a 4-bar chord loop per scale (C minor: Cm, A♭, E♭, B♭), bass and pads follow the chord automatically.
- Chord-aware nudge: a scale tone a semitone from a chord tone moves to the nearest non-clashing scale tone. `scripts/musictest.ts` checks all 1,536 melody-note/chord/scale/key combinations stay in key (216 are nudged).
- Server guardrails: per-connection note rate limit (24/s), integer-step-only, far-future steps rejected, hopelessly late steps moved to the next grid line.

### 3.4 Audio engine (`src/common/engine.ts`)
Per-player voices (melody, bass, pads, drums), master chain with compressor + limiter, reverb and tempo-synced delay sends. Handles the drop (riser, accelerating snare roll, impact), freestyle raw playback, and a game-mode "punchy" piano voice. Monophonic Web Audio synths throw on duplicate start times, so starts are nudged by 1.5 ms when needed (bug found during live testing, fixed).

### 3.5 Networking (`src/common/net.ts`, server)
Back-off reconnect (250 ms to 2 s), dead-socket watchdog (6 s client, 9 s server), immediate reconnect on tab-visible / online. Sessions are keyed by a per-tab id in `sessionStorage`; seats are held 90 s after a drop. Verified by killing and restarting the server mid-session.

### 3.6 Recorder (`src/common/recorder.ts`)
Rolling 30 s of the Stage's final output via an AudioWorklet tap into a PCM ring buffer; saved as a 16-bit stereo WAV. **Deviation from the brief:** MediaRecorder was specified, but it cannot produce a valid file from a rolling window (only the first chunk carries the container header).

---

## 4. Features, by mode

### 4.1 Free play (original brief)
- Join with a name and auto-assigned colour; roles assigned Drums → Bass → Melody → Pads with manual override.
- XY pad (X = pitch in scale, Y = intensity/filter), hold-to-repeat on each role's own rhythm, shake for groove-aware drum hits, tilt for vibrato/filter, haptic tick on the beat, optional phone-speaker mode.
- Stage: QR + roster, lanes per player with a 2-bar piano roll, bursts sized by velocity, whole-screen drum pulse, 16-step beat grid with each player's hits as dots, chord loop, BPM, bar counter, live sync stats.
- Conductor: tempo slider, key and scale selectors, DROP, AUTO band toggle, phones-as-speakers, save-last-30-s.
- AUTO band: gentle generated parts for any role nobody holds (dashed lanes labelled AUTO); header says "SOLO · AUTO BAND BACKING" with one player.

### 4.2 Phone flash control
The synchronized flash is the brief's "muted proof of sync", but a full-screen white flash on every beat was too harsh. Phones now have **soft** (colour pulse, default), **full**, and **off**, remembered per phone; `?flash=0` also turns it off. Beat dots and haptics are unaffected. The flash is disabled during a rhythm game.

### 4.3 Freestyle → composed song
- 🎤 FREESTYLE turns off quantising and scale-lock; pads become continuous keyboards; phones stream raw gestures (down/move/up, shake, tilt) stamped in server time; the Stage records them and sonifies them immediately.
- STOP → `src/stage/composer.ts` (free, deterministic, runs in the browser): gestures → notes; tempo by grid search over onsets (70-160 BPM × 24 phases, mild prior near 105); key by scoring 12 roots × 4 scales; pitches snapped to key, rhythm quantised, lead made monophonic and chord-aware, phrase tiled over 8 bars with a lift in the second half; missing parts generated from how energetic the jam was.
- Result card: Restart / Stop / ⬇ MIDI / ⬇ raw JSON.
- Test (`composertest.ts`): jittery playing at 120 BPM (±60 ms) recovers 120 BPM and the right pitch set; MIDI export re-imports.

### 4.3b Song library and tap-along (older picker)
- **🎵 SONGS** (Stage and every phone): built-in public-domain tunes (Ode to Joy, Twinkle Twinkle, Jingle Bells, Mary Had a Little Lamb, Frère Jacques) and chord-loop backing tracks (four-chord pop loop, Canon progression, sad minor loop, Andalusian, 12-bar blues). Definitions: `src/songs/library.ts`.
- **Bring your own MIDI:** `.mid` files placed in `public/songs/` (git-ignored; `scripts/songs.mjs` lists them) or loaded with a file picker appear in the picker. `src/stage/midi.ts` imports them (channel 10 → drums, highest channel → melody, lowest → bass, rest → pads; key detected).
- **Tap-along:** every phone tap plays the song's *next* melody note, so any rhythm plays the tune over a looping band.

### 4.4 Rhythm game (current main mode)
- **Flow:** Stage `🎮 PLAY A SONG` → pick song + difficulty → server starts on a bar line with a 4-beat count-in → phones show a note highway → results on Stage and phones. Free play is the lobby between songs.
- **Songs** (`shared/songs.ts`, data-driven): *Ode to Joy* (Beethoven, public domain), *Canon in D (arr.)* (Pachelbel's public-domain ground bass and opening theme, original continuation), *Neon Run* (original). Each has title, artist, BPM, duration, rating and a note track per instrument. Adding a song = appending one `SongDef`.
- **Difficulty changes the chart, never the tempo:** Easy 2 lanes / quarter-note grid / ±75-170 ms; Medium 3 lanes / no 16th off-beats / ±55-125 ms; Hard 4 lanes / every note / ±40-95 ms. Pitched lanes follow pitch height; drum lanes are kick, snare, hat, clap.
- **Gameplay is performance, not playback:** a correct tap sends a normal `note` with the chart's step and pitch and the Stage plays it at that exact time. A missed note is never sent, so it never sounds. Roles nobody holds are played by `src/stage/gameconductor.ts`; if a player drops, the band covers their part.
- **Timeline-driven visuals:** note position = `hitLine - (noteTime - now) * pxPerMs`, with `now = clock.toServer(rAF time)` and tap time from the pointer event timestamp. No CSS animation timing anywhere.
- **Scoring:** Perfect 100 / Good 60, combo multiplier +0.25x per 8 notes (max 2x), accuracy counts Good at 60%, grades S/A/B/C/D. Each phone judges its own taps and reports totals every 400 ms; the Stage shows a live team score, per-player stats and a results screen.
- **Solo mode:** one phone plays one instrument and the other three play themselves; Stage and results say "SOLO".
- **Server locks:** tempo, key, scale, drop, freestyle and role changes are ignored while a game runs. A finished game is cleared 45 s after it ends (bug found in testing: a stale finished game blocked a freshly opened Stage).
- Instrument names changed to Drums / Bass / Piano (pads role) / Synth (melody role).

---

### 4.5 Sampler: your own audio (MP3 / WAV)
Stage **🎚️ SAMPLE** → choose a file → tempo/beat grid detected → **PHONES PLAY SLICES** (every phone is a 4×4 pad of slices, taps quantised and re-timed to the room tempo, hold to re-trigger each beat) or **BACKING LOOP** (whole bars looped under the band, bar-aligned). Manual correction buttons for tempo and grid; the file never leaves the Stage's browser.

## 5. Hosting and deployment

- **Local / venue:** `npm run demo` builds, starts the server and a free cloudflared tunnel, and the Stage's QR uses the tunnel URL. `npm start` serves on the LAN (HTTP only, so no shake/tilt on iOS). `npm run dev` runs Vite + server with hot reload.
- **GitHub:** https://github.com/bekhruzmd/human-orhcestra (public). Every commit is authored by `bekhruzmd`, with no attribution trailers; the contributors list shows only `bekhruzmd`. A separate private repo `bekhruzmd/human-orchestra` was created earlier and still exists with the older history; delete it if unwanted.
- **Vercel:** project `horcha`, production alias https://horcha.vercel.app (the requested name was available). The server runs as a Vercel Function (`api/ws.ts` re-exports the same `http.Server`; `/ws` is rewritten to it), pages are static from `dist/`. Needed `.js` import extensions on server-side imports (a crash found during live testing). Build command is `npm run build`.
- **Vercel caveat (important):** the beat clock lives in one server instance's memory, and Vercel doesn't guarantee all WebSockets reach the same instance. In testing all connections shared one epoch and worked; it is not guaranteed. Sockets also close at the function's max duration (5 min on Hobby); clients reconnect and relock. Cloud RTT is higher, so notes get a longer lead. For judging, `npm run demo` on the laptop is the safer path; Vercel is the backup.
- Custom MIDI files are git-ignored and therefore not in the Vercel deploy; use the Stage's "Load .mid file…" there.

---

## 6. Testing: what was run and what it showed

| Check | How | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | clean at every commit |
| `npm test` | musictest, composertest, librarytest, gametest, simtest | all pass |
| Clock-sync accuracy | `simtest.ts`, 4 simulated network profiles with hidden ground truth | 0-6 ms true error; floor of `(down-up)/2` on asymmetric paths (5.7 ms on a 2/14 ms path), exactly as theory predicts |
| Scale lock | `musictest.ts` | 1,536 notes, 0 out of key |
| Protocol smoke | `smoke.ts` against a live server (5 clients) | 11/11: role order, unique colours, sync agreement 0.07 ms, far-future note rejected, no echo, BPM continuity, players can't conduct, offline marking, reconnect restores seat |
| Free-play browser run | Playwright: Stage + 3 phones | worked; sync readout 2-9 ms (mostly frame quantisation in headless) |
| Solo / speaker / recording / reconnect | Playwright | solo lanes + label correct; speaker flag reaches Stage; valid WAV downloaded; phones rejoined after a server restart |
| Freestyle → song | Playwright with random sloppy input | composed (149 BPM, D blues), valid MIDI download, no errors |
| Tap-along | Playwright, 6 random-rhythm taps on Ode to Joy | notes played in order (E E F G G F E D) |
| Rhythm game solo | scripted player on localhost **and the live site** | 56/56 Perfect, S rank, results on Stage |
| Rhythm game misses/Hard | Hard drums, every 4th note skipped | 117 Perfect / 55 missed, combo reset, grade C |
| Rhythm game team | 3 phones: drums, bass, synth on Canon, Medium | team 98% accuracy, per-player rows, clean return to free play |
| Live site | Playwright against horcha.vercel.app | free play (3 phones), solo game: passed |

**Bugs found by testing and fixed:** Vercel crash from missing `.js` ESM extensions; duplicate Web Audio start times throwing under late arrivals; late notes (18 → 8 per run live) via the RTT-scaled lead; recorder failing on Tone's wrapped context (switched to AudioWorklet); stale finished game blocking the Stage.

---

## 7. Decisions and judgement calls

- **Copyrighted songs:** asked to include real hit songs, I did not write out copyrighted melodies. Instead: public-domain tunes, original music, chord loops (progressions aren't copyrightable), and a bring-your-own-MIDI path so the user can add any song they supply.
- **Free play kept**, not deleted, as the lobby experience: lowest-risk reading of "replace the free-play interface" combined with "preserve existing functionality".
- **Scoring is client-side:** each phone judges and reports; the server clamps values but doesn't verify. Fine for a hackathon, not cheat-proof.
- **No database:** all state is in server memory; a restart empties the roster briefly until phones rejoin automatically.
- **Soft flash by default** after the user found the white flash unpleasant.
- **No new dependencies** were added for the game; one route to MIDI, QR and audio was already in place.

---

## 8. Known limitations and unverified claims

1. **Real-hardware sync is unmeasured.** The brief's acceptance target (3 phones under ~30 ms on hackathon Wi-Fi) is **not verified**. Headless localhost shows 2-9 ms; the simulation shows 0-6 ms. The on-screen figure is an estimate that cannot see constant path asymmetry. Ground truth needs a 240 fps camera on the phones and Stage.
2. **No real-phone or iOS Safari testing.** Touch timing, silent-switch audio behaviour, the motion permission prompt, and `audioSession` handling are untested. The user reported the earlier build worked on a phone; the game UI has not been seen on one.
3. **Nothing has been judged by ear.** Sound design, mix levels, composer output quality and the arrangements of the three songs are only checked structurally.
4. **Vercel instance affinity** (section 5) is a risk for live use.
5. **Hard-mode drums** can place notes in two lanes on the same beat, needing two fingers; the test script only tapped one.
6. **No audio-latency calibration** for tap timing yet; trim exists only for Stage audio (`ho.engine.trimMs`, debug drawer).
7. **Bluetooth speakers** add 100+ ms against the flashes; wired headphones recommended.
8. **MIDI import** is only tested on files the app exported itself; unusual channel layouts in real files may map oddly.
9. **Unconfirmed on Hobby limits:** 5-minute socket lifetime is from documentation, not observed.
10. **Priority-2 items not done:** cross-session leaderboards, advanced effects, chart generation from imported MIDI for the game.

---

## 9. Repo map

```
shared/protocol.ts     wire messages, transport math (step <-> time), state types
shared/music.ts        scales, chord loops, index -> pitch, chord-aware snapping, freestyle ranges
shared/game.ts         rhythm-game data layer: chart builder, difficulty, judging, scoring
shared/songs.ts        the three rhythm-game songs (data-driven)
server/index.ts        static files, WebSocket, transport, relay + guardrails, game start/stop
api/ws.ts              Vercel Function entry (re-exports the server)
src/common/            clock.ts, net.ts, beat.ts, engine.ts (Tone), recorder.ts, util.ts
src/player/            phone UI (main.ts), rhythm highway (game.ts)
src/stage/             big-screen UI (main.ts), visuals.ts, auto.ts, composer.ts, midi.ts,
                       song.ts, gameconductor.ts
src/songs/library.ts   older PD tunes + chord loops for the tap-along picker
scripts/               tunnel.mjs, songs.mjs, smoke.ts, simtest.ts, musictest.ts,
                       composertest.ts, librarytest.ts, gametest.ts
vercel.json            build command + /ws rewrite
```
About 4,300 lines of TypeScript across shared, server, clients and scripts.

---

## 10. How to run, test and deploy

```bash
npm install
brew install cloudflared          # free HTTPS tunnel
npm run demo                      # build + server + tunnel; Stage at http://localhost:3000/stage
npm test                          # offline checks
npx tsx scripts/smoke.ts          # protocol smoke test (needs `npm run serve` running)
vercel deploy --prod              # cloud copy (project: horcha)
```

Stage keys: **H** hides the conductor bar, **F** toggles fullscreen.

## 11. Suggested next steps before judging
1. Run `npm run demo` and test with 2-3 real phones on the venue's Wi-Fi; film a flash-sync check at 240 fps and compare with the on-screen number.
2. Play all three songs on each difficulty on a real phone; adjust windows or add a tap-latency calibration if taps feel early or late.
3. Check the iOS audio/motion flow and the silent-switch behaviour.
4. Listen to the mix and the three arrangements; tune levels.
5. Decide whether to rely on the laptop tunnel (recommended) or Vercel at the table.
