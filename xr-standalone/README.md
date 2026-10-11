# Human Orchestra XR

A browser-based mixed-reality conductor view for [Human Orchestra](../human-orchestra). It connects to a running Human Orchestra server, shows the players as a holographic semicircle of instruments around you (Quest 3 passthrough, or an orbit view on desktop), and animates them from the **real** note events the server relays. Separate project; the original is read-only to it. See [`docs/integration.md`](docs/integration.md) for the protocol findings.

React · TypeScript · Vite · three.js · React Three Fiber · @react-three/xr · Zustand. No Unity, no APK.

## Run it

```bash
# 1. Human Orchestra, from its own folder (unchanged, as you normally run it)
cd ../human-orchestra && npm run dev          # serves on :3000

# 2. This app
cd ../human-orchestrator_xr
npm install
npm run dev                                   # HTTPS; prints a Local and a Network URL
```

Set `ORCHESTRA_TARGET=http://localhost:4000 npm run dev` if the Orchestra isn't on :3000.

### Desktop preview
Open the **Local** URL (accept the self-signed certificate warning). Leave the address as `/ws` ("This computer (bridge)"), press **Connect**. Have phones join the Orchestra as usual. No server handy? **Preview with simulation** (clearly labelled SIMULATION everywhere).

### Quest 3
1. Mac and Quest on the same Wi-Fi.
2. In Quest Browser open the **Network** URL (`https://192.168.x.x:<port>`), accept the certificate warning once.
3. Leave the address `/ws` and press **Connect** (observer), or pick **Conductor** to enable pause/tempo/beat drop.
4. If your Orchestra uses room codes, type the code shown on its Stage screen into **Room code** before connecting; leave it empty for a server without rooms.
5. Press **Enter Mixed Reality**, allow the prompt. The orchestra is placed around you once and stays fixed in the room. Use **RECENTER** on the status panel (left of you) to re-place it where you now stand and face.
6. Aim a controller (or pinch with a hand) at an instrument to select it.

Using a deployed/tunnelled Orchestra instead: type its address (`wss://your-host`) in the address field. An HTTPS page can't open `ws://` hosts, so use the Orchestra's `npm run demo` tunnel URL or a deployed server.

## What is real

| Feature | Status |
|---|---|
| Players, roles, join/leave | Live from `roster` |
| Phone notes → drum hits, piano keys, bass pulse, guitar strings, melody bars, particles | Live from relayed `note`, timed to its step on the server clock |
| Jam / imported-song notes | Live from the song tracks the server broadcasts in `TransportState` |
| BPM, paused, song title | Live from `state` |
| Pause / resume, beat drop, tempo | Work in **Conductor** mode (tested against the real server) |
| Per-instrument mute / volume, global volume | **Disabled**: the server has no such command ([`docs/proposed-orchestra-patch.md`](docs/proposed-orchestra-patch.md)) |
| Library "band" songs, AUTO band, freestyle `raw`, game `ghit` | Not visualised: not sent to non-Stage sockets (see docs) |

Observer mode takes no seat and sends only `hello`/`ping`; closing XR never interrupts the orchestra.

## Test

```bash
npm test          # starts the real Orchestra server (read-only, in-memory) on spare ports and drives the adapter:
                  # connect, roster, note→visual, observer read-only, conductor commands, reconnect (no duplicate
                  # subscriptions), jam-track visualisation, impostor endpoint rejected
npm run typecheck
npm run build
```
Dev helpers: `scripts/e2e-shot.mjs` (headless desktop run + screenshots), `scripts/e2e-xr.mjs` (enters the library's emulated Quest 3 session; needs `npm run dev`, which enables `?emulate`).

## Layout
`src/networking` (connection, adapter, protocol mirror, clock, song player, simulation) · `src/state` (store + per-frame activity) · `src/xr` (scene, instruments, panels, particles, interactions) · `src/components` (connect screen, desktop HUD).
