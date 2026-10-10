# Human Orchestra — second-pass review

## Existing implementation audited

The application uses one shared in-memory room per server process, not separate room codes. This was preserved. The Node WebSocket transport, Vite/TypeScript clients, Tone engine and canvas visuals remain intact.

| Area | Findings |
| --- | --- |
| Joining / assignment | QR, preview seats, balanced assignment and 90-second reconnect grace already existed. Joining unnecessarily requested motion permission. Refresh required joining again. |
| Freestyle | Quantized free play, raw freestyle gestures and jam-to-song composition already implemented. Starting Concert while leaving Freestyle could accidentally compose the old jam. |
| Concert | Three complete 32–48 second arrangements, difficulty charts, count-in, timing offset, hits/misses, combos and results already implemented. Assisted arrangement scheduling deliberately keeps music moving without hits. |
| Audio | Shared clock, output-latency compensation, ahead-of-time scheduling, compressor, limiter, reverb and delay already implemented. Concurrent audio initialization could create duplicate buses. Instrument dynamics were weak; Concert bass shared the piano sound. |
| Songs | Separate curated concert and general jam libraries exist, plus validated MIDI import, part selection and browser storage. Retained existing compositions and pitches; did not add songs or copyrighted recordings. |
| Solo | Missing instruments already play automatically during Concert. No additional solo mode needed. |
| Scoring | Deterministic local timing judgement already implemented. Refresh lost progress; reports lacked a performance identifier. Host live accuracy counted future notes. |
| Visuals / mobile | Timestamped musical animation, lane feedback and two-to-four-lane touch controls already implemented. Small controls, narrow layouts, host overflow, generic timing feedback and incorrect Concert chord displays needed refinement. |
| Adaptive difficulty | Not implemented; fixed Easy/Medium/Hard chart filtering is intentional and retained. |

## Prioritized fixes implemented

### P0 — reliability and gameplay

- Reject null/invalid message envelopes, invalid tempo/key values and malformed stats; cap WebSocket payloads.
- Give consecutive starts distinct start steps. Scope stats to the active performance and reject backwards/inconsistent totals and impossible score bounds.
- Validate hit IDs against cached role charts and reject duplicate hits, including after reconnect.
- Persist chart resolution and scores in session storage; refresh automatically rejoins and resumes the same chart. Misses during absence still count, so refreshing does not erase mistakes.
- Do not mark unsent offline reports as delivered; resend after reconnect. Bound connection attempts and clear held input on disconnect.
- Serialize audio initialization and resume an already initialized audio context from a gesture.
- Prevent a Concert transition from triggering asynchronous composition of a previous freestyle session.
- Retain complete, Stage-scheduled musical timelines despite missing or delayed taps.

### P1 — musical and interaction quality

- Increase human-part dynamic range: without recent hits the part softens, while hits lift future notes. Backing remains audible and hits never replay past notes.
- Give Concert bass a dry sine voice with a shorter release while preserving imported polyphonic pitches. Make pitched-voice velocity respond proportionally to performance.
- Explain lane tapping directly; distinguish early/late Good hits and provide neutral feedback for stray taps.
- Add performance-based results advice and a neutral grade when no notes were playable.
- Compute live band accuracy from judged notes; retain full-chart accuracy for final results.
- Pulse the host lane on actual player hits and clear queued visuals between performances.
- Replace the unrelated freestyle chord loop with a Concert beat guide; show song-relative bar numbers.
- Remove join-time sensor permission; leave motion opt-in. Improve 44px timing controls, narrow/short layouts, scrolling sheets, visible focus, and conductor overflow.
- Add a proper QR quiet zone and correct LAN Vite port selection. Explain the one-player flow on Stage.
- Cache server charts and replace repeated pitch-rank scans with a precomputed map for larger MIDI charts.
- Revoke recorder worklet URLs and allow retry after module-load failure.
- Add isolated `npm run test:network`; use Node's existing tsx loader for tests to avoid the observed CLI IPC runner stall.

## Validation actually executed

- `npm run typecheck` — passed.
- `npm test` — passed all seven suites after switching the invocation to `node --import tsx`.
- `npm run test:network` — passed on an isolated temporary server; it shuts down automatically.
- `npm run build` — passed (1040 modules).
- `git diff --check` — passed.
- Protocol checks: five simultaneous joins, role/color allocation, clock agreement, relay bounds, disconnect/offline status, reconnect identity, imported-song distribution, late join assignment, invalid imports, malformed messages, current stats, duplicate hits, restart identity, stale reports and stopping.
- Timeline regression: missing taps and 0/80/250/800/2500ms delayed hits preserve the complete note sequence and timing; only dynamics vary.
- Chrome UI: joining without a sensor prompt, automatic rejoin on refresh, solo Concert launch with audio active, visible note highway/misses, and final phone results surviving refresh (66 misses retained).
- Chrome UI: Freestyle activation, four phone pad inputs, composition into “Your jam”, and stop.
- Screenshot review: Stage and phone controller at the available desktop viewport. Physical phone sizes and touch latency were not measured.

## Remaining limitations and manual checks

- One room and shared transport per server process; Stage identification is a client role, not authenticated host authorization. This is suitable for the existing supervised demo, not a multi-tenant public service.
- Scores remain client-judged with consistency checks, not server-authoritative anti-cheat. Session persistence requires available browser session storage.
- Musical contribution is assisted dynamics, not strict hit-to-play gating. A missed note softens the part through loss of recent-hit lift; the underlying arrangement continues.
- Keep Stage visible and awake. Background browser scheduling and physical output latency can still affect audio. A Stage refresh requires enabling audio again; locally uploaded audio cannot be restored from the server.
- Existing dual song pickers remain; use **PLAY A SONG** for the shortest demo. No new adaptive difficulty or leaderboard was added.
- General MIDI timbres are synthesized substitutes. No subjective listening-quality or acoustic clipping measurement was performed in this session.
- Existing cloud hosting behavior was not revalidated. Use one local Node server for the judging demo.
- Before judging: scan the displayed QR with an iPhone and Android phone on the intended network; test 320/375/390px portrait and landscape, two simultaneous lane touches, rotate mid-song, refresh mid-song, Wi-Fi off/on, and a late join. Confirm score continuity and audible volume changes with wired output. Film synchronized beat flashes if a measured cross-device sync claim is needed.

## 60–90 second demo

1. Run `npm run demo` and leave Stage visible. Verify the tunnel QR from a real phone before judging.
2. Judge scans and taps **JOIN THE BAND**. No name edit or motion permission required.
3. Host chooses **PLAY A SONG → Ode to Joy → EASY → START**.
4. Say: “Tap the lane as the note reaches the line. Your hits bring your instrument forward.” The other three parts supply backing.
5. Play the 38-second arrangement, show accuracy, Perfect/Good counts and best streak, then choose **PLAY AGAIN** if time allows.

Reload both Stage and phones after deploying this update because the hit/stats protocol gained performance and note identifiers.
