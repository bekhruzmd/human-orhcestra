# Proposed Human Orchestra changes (NOT applied)

These are suggestions for the **original** repo. XR was built without them; it simply shows the matching controls as disabled until they exist. Nothing here has been run against the original.

## 1. Remote mix commands (enables mute / volume)

The Stage mixes in-browser (`engine.setMix(channel, 0..1.5)`, channels `song, kick, snare, hat, open, clap, other`). To control that remotely, the server needs to relay a mix state and the Stage needs to apply it.

`shared/protocol.ts`
```ts
export type MixChannel = 'song' | 'kick' | 'snare' | 'hat' | 'open' | 'clap' | 'other';
// TransportState:
mix?: Partial<Record<MixChannel, number>>;   // 0..1.5, absent = default
// ClientMsg cmd union gains:
| { t: 'cmd'; cmd: 'mix'; value?: string }    // "kick|0.8"
```

`server/index.ts` (inside the existing `cmd` switch, which is already Stage-only)
```ts
case 'mix': {
  const [ch, lv] = String(m.value ?? '').split('|');
  if (!MIX_CHANNELS.includes(ch as MixChannel)) break;
  transport.mix = { ...(transport.mix ?? {}), [ch]: Math.max(0, Math.min(1.5, Number(lv) || 0)) };
  break;
}
```

`src/stage/main.ts`: on `net.on('state')`, for each `ts.mix` entry call `engine.setMix(ch, level)`.

Mute = level 0. Note the mixer is per **sound channel**, not per player role, so "mute guitar" would need a role→channel mapping (or per-role gain nodes in `engine.ts`). Until then XR can offer at most drum-voice and "song" channels.

## 2. Optional Stage auth token

Today `hello{kind:'stage'}` is self-declared, so any client on the network can pause or change tempo. Suggested: env `STAGE_TOKEN`; the Stage sends `hello{kind:'stage', token}`; the server downgrades a stage hello with a bad token to `player`. XR would add a token field to its connect screen (kept in memory, never in source).

## 3. Optional: broadcast `raw`/`ghit` to observers, and notes for band songs

Let non-Stage sockets receive `raw` (freestyle) and `ghit`, and have the Stage (or server) broadcast scheduled song notes (or at least `songId` + `startStep`) for library songs, so XR can visualise those too.
