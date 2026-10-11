/**
 * Visualises song playback from data the server really broadcasts: a Jam (`nowPlaying.mode==='jam'`) or a game
 * that embeds its song carry the full note tracks in TransportState. We walk those tracks against the shared
 * transport clock exactly like the Stage does. Library "band"/"tap" songs and built-in game songs send only a
 * title/id over the wire, so there is nothing to visualise for them (documented in docs/integration.md).
 */
import { activity } from '../state/activity';
import { ROLES, stepPos, stepTime, type GameSong, type Role, type TrackNote, type TransportState } from './protocol';

interface Active { key: string; startStep: number; song: GameSong; tracks: Partial<Record<Role, TrackNote[]>>; idx: Partial<Record<Role, number>> }

export type SongSource = { title: string; visualised: boolean } | null;

export class SongPlayer {
  private active: Active | null = null;
  source: SongSource = null;

  update(ts: TransportState | null) {
    const np = ts?.nowPlaying;
    let song: GameSong | null = null, startStep = 0, roles: Role[] = [];
    let key = '';
    if (np && 'mode' in np && np.mode === 'jam') {
      song = np.song; startStep = np.startStep; roles = np.full ? [...ROLES] : ['melody'];
      key = `jam:${np.song.id}:${np.startStep}`;
    } else if (ts?.game?.song) {
      const g = ts.game;
      song = g.song!; startStep = g.startStep;
      roles = ROLES.filter((r) => !(g.live && g.free?.includes(r)));
      key = `game:${song.id}:${g.startStep}`;
    }
    if (!song) {
      this.active = null;
      this.source = ts?.game ? { title: ts.game.songId, visualised: false }
        : np ? { title: np.title, visualised: false } : null;
      return;
    }
    this.source = { title: song.title, visualised: true };
    if (this.active?.key === key) return;
    const tracks: Active['tracks'] = {};
    for (const r of roles) tracks[r] = [...song.tracks[r]].sort((a, b) => a.step - b.step);
    this.active = { key, startStep, song, tracks, idx: {} };
    this.seeded = false; // first tick skips ahead to "now" so joining mid-song never replays the past
  }

  private seeded = false;

  tick(ts: TransportState | null, serverNow: number) {
    const a = this.active;
    if (!a || !ts) return;
    const cur = stepPos(ts, serverNow);
    for (const r of ROLES) {
      const track = a.tracks[r];
      if (!track) continue;
      let i = a.idx[r] ?? 0;
      if (!this.seeded) { while (i < track.length && a.startStep + track[i].step < cur - 1) i++; }
      while (i < track.length && a.startStep + track[i].step <= cur) {
        const n = track[i];
        activity.fire({
          type: 'instrument:note', instrumentId: r, source: 'song', velocity: n.v,
          midi: r === 'drums' ? undefined : n.midi, drumVoice: r === 'drums' ? n.d ?? 0 : undefined,
          durSteps: n.dur, timestamp: stepTime(ts, a.startStep + n.step),
        });
        i++;
      }
      a.idx[r] = i;
    }
    this.seeded = true;
  }
}
