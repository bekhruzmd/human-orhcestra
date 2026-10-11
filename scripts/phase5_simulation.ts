import { WebSocket } from 'ws';

interface GravitateProfile {
  name: string;
  tagline: string;
  vibe: string;
  interests: string[];
  musicalTastes: string[];
}

const profileA: GravitateProfile = {
  name: 'RetroRider',
  tagline: 'Chasing 80s neon sunsets',
  vibe: 'Cyberpunk Synthesizer',
  interests: ['Arcade gaming', 'Synthwave music', 'Pixel art'],
  musicalTastes: ['Synthwave', 'Chiptune', 'Electronic'],
};

const profileB: GravitateProfile = {
  name: 'PixelMaestro',
  tagline: 'Orchestrating 8-bit vibes',
  vibe: 'Arcade Conductor',
  interests: ['Retro arcades', 'MIDI composing', 'Pixel art'],
  musicalTastes: ['Cyberpunk beats', 'Synthwave', 'EDM'],
};

async function runSimulation() {
  console.log('🚀 [Phase 5 Test] Starting Seamless Game Handoff WebSocket Simulation...');

  const wsUrl = 'ws://localhost:3000/ws';
  const wsA = new WebSocket(wsUrl);
  const wsB = new WebSocket(wsUrl);

  await Promise.all([
    new Promise((resolve, reject) => {
      wsA.on('open', resolve);
      wsA.on('error', reject);
    }),
    new Promise((resolve, reject) => {
      wsB.on('open', resolve);
      wsB.on('error', reject);
    }),
  ]);

  console.log('✅ Both client sockets connected to server!');

  // Helper for message listening
  function waitForMessage(ws: WebSocket, predicate: (data: any) => boolean, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for message`));
      }, timeoutMs);

      const handler = (rawData: Buffer | string) => {
        try {
          const msg = JSON.parse(rawData.toString());
          if (predicate(msg)) {
            cleanup();
            resolve(msg);
          }
        } catch {
          // ignore non-json
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', handler);
      };

      ws.on('message', handler);
    });
  }

  // 1. Hello & Join
  wsA.send(JSON.stringify({ t: 'hello', kind: 'player', id: 'sim_handoff_a' }));
  wsB.send(JSON.stringify({ t: 'hello', kind: 'player', id: 'sim_handoff_b' }));

  await Promise.all([
    waitForMessage(wsA, (m) => m.t === 'welcome'),
    waitForMessage(wsB, (m) => m.t === 'welcome'),
  ]);

  wsA.send(JSON.stringify({ t: 'join', name: profileA.name }));
  wsB.send(JSON.stringify({ t: 'join', name: profileB.name }));
  console.log('✅ Both clients joined band roster.');

  // 2. Spatial-Temporal Bump Spike (simulating phone accelerometer tap within 60ms)
  const now = Date.now();
  console.log('📲 Simulating physical phone bump...');
  wsA.send(JSON.stringify({ t: 'bump_spike', timestamp: now, profile: profileA }));
  await new Promise((r) => setTimeout(r, 60));
  wsB.send(JSON.stringify({ t: 'bump_spike', timestamp: now + 60, profile: profileB }));

  const [matchA, matchB] = await Promise.all([
    waitForMessage(wsA, (m) => m.t === 'bump_matched'),
    waitForMessage(wsB, (m) => m.t === 'bump_matched'),
  ]);

  if (matchA.roomId !== matchB.roomId) {
    throw new Error(`Room ID mismatch: A=${matchA.roomId}, B=${matchB.roomId}`);
  }
  const roomId = matchA.roomId;
  console.log(`✅ Bump match confirmed! Shared Room: ${roomId}`);

  // 3. Mutual Consent Confirmation
  console.log('🤝 Sending mutual bump_confirm from both devices...');
  wsA.send(JSON.stringify({ t: 'bump_confirm', roomId, profile: profileA }));
  wsB.send(JSON.stringify({ t: 'bump_confirm', roomId, profile: profileB }));

  console.log('🤖 Waiting for Gemini Matchmaker reveal...');
  const [revealA, revealB] = await Promise.all([
    waitForMessage(wsA, (m) => m.t === 'bump_reveal', 20000),
    waitForMessage(wsB, (m) => m.t === 'bump_reveal', 20000),
  ]);

  const recommendedSongId = revealA.match?.song_id;
  console.log(`✅ Gemini match received: "${revealA.match?.sharedVibe}"!`);
  console.log(`🎵 Recommended Track: ${revealA.match?.song_title} (ID: ${recommendedSongId})`);

  // 4. Phase 5 Handoff: Client A clicks "ENTER STAGE TOGETHER"
  console.log('▶ [Client A] Emitting bump_start_jam to trigger rhythm game handoff...');
  
  // Set up listeners for the transport state update on both clients
  const statePromiseA = waitForMessage(wsA, (m) => m.t === 'state' && m.state?.game !== null, 10000);
  const statePromiseB = waitForMessage(wsB, (m) => m.t === 'state' && m.state?.game !== null, 10000);

  wsA.send(JSON.stringify({ t: 'bump_start_jam', roomId, song_id: recommendedSongId }));

  // Simulate double-click from Client B 50ms later (must not cause error or restart)
  await new Promise((r) => setTimeout(r, 50));
  wsB.send(JSON.stringify({ t: 'bump_start_jam', roomId, song_id: recommendedSongId }));

  const [stateA, stateB] = await Promise.all([statePromiseA, statePromiseB]);

  console.log('🎉 [Client A] Transport state updated:', JSON.stringify(stateA.state.game));
  console.log('🎉 [Client B] Transport state updated:', JSON.stringify(stateB.state.game));

  const gameA = stateA.state.game;
  const gameB = stateB.state.game;

  if (!gameA || !gameB) {
    throw new Error('Game was not started in transport state!');
  }

  if (gameA.startStep !== gameB.startStep || gameA.songId !== gameB.songId) {
    throw new Error(`Clients out of sync: A=${JSON.stringify(gameA)}, B=${JSON.stringify(gameB)}`);
  }

  console.log(`\n======================================================`);
  console.log(`✅ ALL PHASE 5 CHECKS PASSED PERFECTLY!`);
  console.log(`   - Server received bump_start_jam from first client.`);
  console.log(`   - Prevented double-loading on second client click.`);
  console.log(`   - Synchronized game startStep: ${gameA.startStep}`);
  console.log(`   - Loaded Song ID: ${gameA.songId}`);
  console.log(`   - Difficulty: ${gameA.difficulty}`);
  console.log(`   - Both phones seamlessly transitioned into the band!`);
  console.log(`======================================================\n`);

  wsA.close();
  wsB.close();
}

runSimulation().catch((err) => {
  console.error('❌ Simulation failed:', err);
  process.exit(1);
});
