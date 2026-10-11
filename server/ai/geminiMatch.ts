import { GoogleGenerativeAI } from '@google/generative-ai';
import { UserProfile, genAI } from './geminiProfile.js';

export type BuiltinSongId = 'neon' | 'ode' | 'canon' | 'blues' | 'jingle';

export interface MatchResult {
  sharedVibe: string;
  overlap: string;
  icebreaker: string;
  hasMusicGenre: boolean;
  sharedMusicGenre?: string | null;
  song_id?: BuiltinSongId | null;
  song_title?: string | null;
  compatibilityScore: number; // 0 - 100
  // Backwards compatibility aliases
  recommendedSongId?: string;
  recommendedSongTitle?: string;
}

export interface SongMetadata {
  id: BuiltinSongId;
  title: string;
  vibe: string;
  bpm: number;
}

export const BUILTIN_SONGS: Record<BuiltinSongId, SongMetadata> = {
  neon: { id: 'neon', title: 'Neon Run', vibe: 'High-energy 80s arcade synthwave, fast and intense', bpm: 120 },
  ode: { id: 'ode', title: 'Ode to Joy', vibe: 'Uplifting classical celebratory anthem, grand and triumphant', bpm: 100 },
  canon: { id: 'canon', title: 'Canon in D', vibe: 'Chill harmonious flow, melodic and relaxed', bpm: 80 },
  blues: { id: 'blues', title: '12-Bar Blues', vibe: 'Soulful groovy retro blues, rhythm-heavy', bpm: 110 },
  jingle: { id: 'jingle', title: 'Jingle Bells', vibe: 'Playful upbeat retro arcade tempo', bpm: 130 },
};

// Explicitly use gemini-3.6-flash and responseMimeType: "application/json" as required
export const matchModel = genAI.getGenerativeModel({
  model: 'gemini-3.6-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.7,
  },
  systemInstruction: `You are the Gravitate Matchmaker AI for "Human Orchestra", a multiplayer 8-bit rhythm game.
Your task is to compare two player profiles who bumped phones, identify their deepest shared interests and musical tastes, create a conversation spark, and evaluate if their shared interest includes a music genre or musical style.

Music Genre Evaluation Rule:
- Determine if the two players share an interest in a specific music genre, musical style, instrument, or rhythm aesthetic (e.g. Synthwave, Chiptune, Classical, Blues, Electronic, EDM, Rock, Jazz, Ambient, etc.).
- Set "hasMusicGenre": true if they share a music genre or musical preference. Otherwise set "hasMusicGenre": false.
- If "hasMusicGenre" is true:
    * "sharedMusicGenre": Name of the shared genre or musical style.
    * "song_id": Exactly ONE of the allowed songs below matching their shared vibe.
- If "hasMusicGenre" is false:
    * "sharedMusicGenre": null
    * "song_id": null

Allowed song_id choices (when hasMusicGenre is true):
- "neon": High-energy cyberpunk synthwave, intense electronic beats (BPM 120)
- "ode": Uplifting classical anthem, celebratory and joyful (BPM 100)
- "canon": Chill, harmonious melodic flow, relaxing and ambient (BPM 80)
- "blues": 12-bar blues, groovy and soulful (BPM 110)
- "jingle": Fast, playful upbeat melody (BPM 130)

You MUST output ONLY valid JSON matching this exact schema:
{
  "sharedVibe": "Short punchy 8-bit title for their combined aesthetic (e.g. 'Cyberpunk Bass Bros', 'Retro Sci-Fi Explorers')",
  "overlap": "1-2 sentences highlighting exactly what specific interests, hobbies, or vibes they have in common",
  "icebreaker": "A fun, specific question they should ask each other right now to ignite conversation",
  "hasMusicGenre": boolean,
  "sharedMusicGenre": string or null,
  "song_id": "neon" | "ode" | "canon" | "blues" | "jingle" | null,
  "compatibilityScore": number (integer between 70 and 99)
}`,
});

/**
 * Fallback matcher when offline or if API key encounters temporary limits.
 */
function createFallbackMatch(profileA: UserProfile, profileB: UserProfile): MatchResult {
  const nameA = profileA.name || 'Player 1';
  const nameB = profileB.name || 'Player 2';

  const setA = new Set((profileA.interests || []).map((i) => i.toLowerCase().trim()));
  const common = (profileB.interests || []).filter((i) => setA.has(i.toLowerCase().trim()));
  const sharedInterests = common.length > 0 ? common : (profileA.interests?.length ? profileA.interests : ['8-Bit Games', 'Multiplayer Fun']);

  const rawTasteA: string[] = profileA.musicTaste || (profileA as any).musicalTastes || [];
  const rawTasteB: string[] = profileB.musicTaste || (profileB as any).musicalTastes || [];
  const tasteA = rawTasteA.map((t) => t.toLowerCase().trim());
  const tasteB = rawTasteB.map((t) => t.toLowerCase().trim());

  // Check for shared music taste or music genre in shared interests
  const musicKeywords = [
    'synthwave', 'chiptune', 'electronic', 'rock', 'blues', 'jazz', 'classical',
    'pop', 'hip hop', 'rap', 'metal', 'ambient', 'lo-fi', 'lofi', 'techno', 'house',
    'r&b', 'soul', 'disco', 'funk', 'edm', 'indie', 'folk', 'country', 'reggae', 'punk',
    'orchestra', 'beats', 'bass', 'guitar', 'piano', 'drums', 'synthesizer', 'music'
  ];

  const commonMusicTaste = tasteB.filter((t) => tasteA.some((a) => a.includes(t) || t.includes(a)));
  const musicInterests = sharedInterests.filter((i) => musicKeywords.some((k) => i.includes(k)));

  const hasMusicGenre = commonMusicTaste.length > 0 || musicInterests.length > 0;
  const sharedGenre = commonMusicTaste[0] || musicInterests[0] || null;

  let chosenSong: BuiltinSongId | null = null;
  if (hasMusicGenre) {
    const combinedTaste = `${tasteA.join(' ')} ${tasteB.join(' ')} ${(sharedGenre || '').toLowerCase()}`;
    if (combinedTaste.includes('chill') || combinedTaste.includes('ambient') || combinedTaste.includes('lo-fi') || combinedTaste.includes('relax')) {
      chosenSong = 'canon';
    } else if (combinedTaste.includes('blues') || combinedTaste.includes('jazz') || combinedTaste.includes('groove')) {
      chosenSong = 'blues';
    } else if (combinedTaste.includes('classic') || combinedTaste.includes('orchestra') || combinedTaste.includes('uplift')) {
      chosenSong = 'ode';
    } else if (combinedTaste.includes('pop') || combinedTaste.includes('fun') || combinedTaste.includes('arcade')) {
      chosenSong = 'jingle';
    } else {
      chosenSong = 'neon';
    }
  }

  const meta = chosenSong ? BUILTIN_SONGS[chosenSong] : null;

  return {
    sharedVibe: `${profileA.vibe || 'Neon'} x ${profileB.vibe || 'Pulse'}`,
    overlap: `Both ${nameA} and ${nameB} share common ground in ${sharedInterests.join(' and ')}.`,
    icebreaker: hasMusicGenre
      ? `Ask each other: if you could headline an 8-bit concert together, what would you name your band?`
      : `Ask each other: what got you passionate about ${sharedInterests[0] || 'your favorite hobby'}?`,
    hasMusicGenre,
    sharedMusicGenre: sharedGenre,
    song_id: chosenSong,
    song_title: meta ? meta.title : null,
    compatibilityScore: Math.floor(80 + Math.random() * 18),
    recommendedSongId: chosenSong ?? undefined,
    recommendedSongTitle: meta ? meta.title : undefined,
  };
}

/**
 * Compare two approved user profiles, find common ground/interests, and
 * pick the optimal song from built-in Human Orchestra songs if a music genre is shared.
 */
export async function matchProfilesAndRecommendSong(
  profileA: UserProfile,
  profileB: UserProfile
): Promise<MatchResult> {
  const activeKey = process.env.GEMINI_API_KEY;
  if (!activeKey || activeKey.includes('your_gemini_api_key')) {
    console.warn('[Gravitate Match] GEMINI_API_KEY not configured. Using fallback matcher.');
    return createFallbackMatch(profileA, profileB);
  }

  try {
    const prompt = `Compare these two player profiles who tapped their phones together:

PLAYER 1:
${JSON.stringify(profileA, null, 2)}

PLAYER 2:
${JSON.stringify(profileB, null, 2)}

Generate their Vibe Match JSON now with music genre evaluation.`;

    const result = await matchModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonStr = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    let hasMusicGenre = Boolean(parsed.hasMusicGenre);
    let sharedGenre: string | null = parsed.sharedMusicGenre || null;
    let songId: BuiltinSongId | null = null;

    if (parsed.song_id && ['neon', 'ode', 'canon', 'blues', 'jingle'].includes(parsed.song_id)) {
      songId = parsed.song_id as BuiltinSongId;
      hasMusicGenre = true;
    } else if (hasMusicGenre) {
      songId = 'neon';
    }

    const meta = songId ? BUILTIN_SONGS[songId] : null;

    return {
      sharedVibe: String(parsed.sharedVibe || `${profileA.name} & ${profileB.name} Duet`),
      overlap: String(parsed.overlap || `Both players share great taste in multiplayer games and passions.`),
      icebreaker: String(parsed.icebreaker || `What is a passion that inspires you the most?`),
      hasMusicGenre,
      sharedMusicGenre: sharedGenre,
      song_id: songId,
      song_title: meta ? meta.title : null,
      compatibilityScore: Number(parsed.compatibilityScore) || 88,
      recommendedSongId: songId ?? undefined,
      recommendedSongTitle: meta ? meta.title : undefined,
    };
  } catch (err: any) {
    console.error('[Gravitate Match] Gemini match error:', err?.message || err);
    return createFallbackMatch(profileA, profileB);
  }
}

