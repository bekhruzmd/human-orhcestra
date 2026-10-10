# Team brief

Use this as a plain-English guide for the demo table. The explanations describe the current implementation; the answers avoid claiming real-phone timing results that we have not measured yet.

## Clock sync

**How it works:** Every phone and the Stage exchange ping/pong messages with the server, noting the local send and receive times while the server stamps when it receives each ping. The round-trip time (RTT) estimates network delay, and the midpoint formula estimates the server-minus-device clock offset; the client keeps the lowest-RTT 30% of recent samples, takes their median, and slews later corrections gradually. The displayed p90 is a held-out prediction error, not ground truth, and constant path asymmetry cannot be observed from these exchanges alone.

**Hard questions**

1. **Why use the midpoint?** It estimates when the server timestamp happened during the round trip, assuming the outbound and return paths are similar.
2. **Does p90 prove the clocks differ by only that amount?** No; it measures how well recent low-RTT samples match the applied offset, while path asymmetry can add hidden error.
3. **Why keep only the lowest-RTT 30%?** Those samples are less likely to include queueing spikes, so their offsets are less distorted before we take the median.

## Scheduling and lead time

**How it works:** The server owns the tempo and epoch, and every note targets an integer sixteenth-note step on that shared timeline. A phone chooses a future step far enough away for its measured RTT and jitter, then each audio client converts that server time into its local audio clock and schedules the sound ahead. If a note arrives late it plays as soon as possible and increments the late counter; if it is more than 250 ms late it is dropped as too stale to sound musical.

**Hard questions**

1. **Why not send a “play now” message on each beat?** Network arrival time varies, so devices independently schedule against the shared clock instead of reacting to message arrival.
2. **Why use a lead at all?** It gives the phone’s input message time to reach the Stage before the target step; the current lead adapts to RTT and jitter and is clamped between 60 and 260 ms.
3. **Does this remove all audio latency?** No; the client uses the browser’s output timestamp or reported output latency and offers a manual trim, but Bluetooth and device-specific audio paths can still add delay.

## Scale lock and chord-aware nudge

**How it works:** A phone sends a pad-column index rather than an arbitrary pitch, and the audio client resolves that index using the current key, scale, chord, and target step. The scale mapping makes out-of-key notes unavailable, while the melody nudge moves a scale note to a nearby safe scale tone when it sits a semitone from a chord tone. Bass and chord pads choose chord tones directly, so the nudge is mainly for melody notes that could clash against the current harmony.

**Hard questions**

1. **Can a player still make a bad-sounding note?** Yes; the guardrails prevent out-of-key pitches and reduce close semitone clashes, but they do not replace musical judgment.
2. **Why change pitch after the player chooses a column?** The columns describe musical choices in the current key, and the nudge only changes a melody pitch when it would create a particularly rough semitone rub.
3. **What happens when the host changes key?** The same index is resolved under the new key at playback, so the phone layout and every instrument stay aligned without sending new pitch data.

## Composer

**How it works:** Freestyle gestures arrive with synchronized timestamps, and the Stage records those gestures as raw note and drum events. The composer estimates tempo, key, and scale, quantizes a short phrase, cleans duplicate or overlapping notes, and fills missing instruments with generated parts. It creates a deterministic eight-bar loop that can be played and exported as MIDI for a DAW.

**Hard questions**

1. **Does it understand any performance?** No; it is a rule-based arranger for short pad jams, not a general-purpose transcription or music-understanding model.
2. **What if players drift off the grid?** Tempo and phase are estimated from the gesture onsets, then events are quantized to the chosen grid; very sparse input can make that estimate less reliable.
3. **Are generated parts copied from a song?** No; the backing parts come from the app’s deterministic patterns, while the user’s gestures form the source material.

## Recorder

**How it works:** An AudioWorklet copies the Stage’s post-limiter stereo output into fixed-size PCM blocks in a rolling 30-second buffer. On request, the browser writes those samples into a 16-bit WAV file and downloads it locally. The rolling buffer is kept in browser memory, so the recording is not uploaded by this feature.

**Hard questions**

1. **Why not use MediaRecorder?** A rolling window can discard the first MediaRecorder chunk that contains container headers, leaving a file that some players cannot open.
2. **How much audio does it capture?** The final Stage mix after the limiter, including the synthesized parts that are audible there.
3. **Where is the file stored?** It is created and downloaded by the Stage browser; saving or sharing the resulting WAV is up to the user.

## Reconnect

**How it works:** Each tab keeps a stable player ID in session storage, and the WebSocket client retries with a short backoff after a disconnect or when the tab becomes visible again. On reconnect the phone re-hellos, restarts clock sync, and joins with its existing ID so the server can restore its seat and role. The server keeps a dropped seat for 90 seconds and closes silent sockets after 9 seconds, but a disconnected phone cannot send notes while it is offline.

**Hard questions**

1. **Does reconnect preserve the player’s instrument?** Usually yes, because the stable ID maps back to the server’s reserved seat during the grace period.
2. **Does the phone keep playing during a network outage?** Not into the shared Stage mix; it reconnects and relocks before resuming network participation.
3. **Is reconnect equally reliable on Vercel?** The code reconnects, but the shared transport is in memory and Vercel may route sockets to different instances, so the local tunnel is the safer live-demo setup.

## What we struggled with

The hardest engineering boundary was keeping clock-estimation error, display-frame timing, audio-output latency, and late network notes as separate measurements instead of calling all of them “sync.” The rhythm game added another constraint: the arrangement has to keep playing on schedule while each player’s recent hits or misses change the sound they contribute. Imported MIDI also brings uneven track naming, split instruments, and timing limits, so the importer needs safe fallbacks rather than assuming every file is a clean lead sheet.

We have not yet filmed multiple real phones and the Stage together at 240 fps on venue Wi-Fi, and we have not timed the join flow with first-time judges. Simulations and automated protocol tests help catch regressions, but they are not substitutes for those two measurements.

## AI tools used

For this project pass, OpenAI Codex assisted with repository exploration, code changes, test iteration, and documentation edits across the Stage demo, sync proof, preflight, and team brief. The implementation was checked with the project’s automated tests and TypeScript typecheck; the live-device timing claims remain explicitly unverified. No external AI service or AI-generated song file was used in this pass.
