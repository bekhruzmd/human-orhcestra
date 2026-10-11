import { GoogleGenerativeAI } from '@google/generative-ai';
import { UserProfile, genAI } from './geminiProfile.js';

export type BuiltinSongId = 'neon' | 'ode' | 'canon' | 'blues' | 'jingle';

export interface MatchResult {
  sharedVibe: string;
  overlap: string;
  icebreaker: string;
  song_id: BuiltinSongId;
  song_title: string;
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
Your task is to compare two player profiles who bumped phones, identify their deepest shared interests and musical tastes, create a conversation spark, and recommend the best MIDI song for them to play together.

Allowed song_id choices (MUST BE EXACTLY ONE OF THESE FIVE):
- "neon": High-energy cyberpunk synthwave, intense electronic beats (BPM 120)
- "ode": Uplifting classical anthem, celebratory and joyful (BPM 100)
- "canon": Chill, harmonious melodic flow, relaxing and ambient (BPM 80)
- "blues": 12-bar blues, groovy and soulful (BPM 110)
- "jingle": Fast, playful upbeat melody (BPM 130)

You MUST output ONLY valid JSON matching this exact schema:
{
  "sharedVibe": "Short punchy 8-bit title for their combined aesthetic (e.g. 'Cyberpunk Bass Bros', 'Lo-Fi Pixel Dreamers')",
  "overlap": "1-2 sentences highlighting exactly what specific interests, hobbies, or musical vibes they have in common",
  "icebreaker": "A fun, specific question they should ask each other right now",
  "song_id": "neon" | "ode" | "canon" | "blues" | "jingle",
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

  const sharedInterests = common.length > 0 ? common : ['8-Bit Rhythms', 'Multiplayer Music'];
  const tasteA = (profileA.musicTaste || []).join(' ').toLowerCase();
  const tasteB = (profileB.musicTaste || []).join(' ').toLowerCase();
  const combinedTaste = `${tasteA} ${tasteB}`;

  let chosenSong: BuiltinSongId = 'neon';
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

  const meta = BUILTIN_SONGS[chosenSong];

  return {
    sharedVibe: `${profileA.vibe || 'Neon'} x ${profileB.vibe || 'Pulse'}`,
    overlap: `Both ${nameA} and ${nameB} share a passion for ${sharedInterests.join(' and ')} with aligned musical energy.`,
    icebreaker: `Ask each other: if you could headline an 8-bit concert together, what would you name your band?`,
    song_id: chosenSong,
    song_title: meta.title,
    compatibilityScore: Math.floor(80 + Math.random() * 18),
    recommendedSongId: chosenSong,
    recommendedSongTitle: meta.title,
  };
}

/**
 * Compare two approved user profiles, find common ground/interests, and
 * pick the optimal song from built-in Human Orchestra songs.
 */
export async function matchProfilesAndRecommendSong(
  profileA: UserProfile,
  profileB: UserProfile
): Promise<MatchResult> {
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('your_gemini_api_key')) {
    console.warn('[Gravitate Match] GEMINI_API_KEY not configured. Using fallback matcher.');
    return createFallbackMatch(profileA, profileB);
  }

  try {
    const prompt = `Compare these two player profiles who tapped their phones together:

PLAYER 1:
${JSON.stringify(profileA, null, 2)}

PLAYER 2:
${JSON.stringify(profileB, null, 2)}

Generate their Vibe Match JSON now.`;

    const result = await matchModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();
    const jsonStr = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(jsonStr);

    let songId: BuiltinSongId = 'neon';
    if (['neon', 'ode', 'canon', 'blues', 'jingle'].includes(parsed.song_id)) {
      songId = parsed.song_id as BuiltinSongId;
    }

    const meta = BUILTIN_SONGS[songId];

    return {
      sharedVibe: String(parsed.sharedVibe || `${profileA.name} & ${profileB.name} Duet`),
      overlap: String(parsed.overlap || `Both players share great taste in music and multiplayer games.`),
      icebreaker: String(parsed.icebreaker || `What is the most energetic track you love listening to on repeat?`),
      song_id: songId,
      song_title: meta.title,
      compatibilityScore: Number(parsed.compatibilityScore) || 88,
      recommendedSongId: songId,
      recommendedSongTitle: meta.title,
    };
  } catch (err: any) {
    console.error('[Gravitate Match] Gemini match error:', err?.message || err);
    return createFallbackMatch(profileA, profileB);
  }
}
