import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Structured User Profile for Gravitate & Human Orchestra.
 * User control directive: Must be approved by user before broadcasting.
 */
export interface UserProfile {
  id?: string;
  name: string;
  tagline: string;
  bio: string;
  interests: string[];
  musicTaste: string[];
  vibe: string;
  icebreakers: string[];
  approved: boolean;
  approvedAt?: number;
  updatedAt?: number;
}

// Read API key from environment variables (loaded via dotenv/config)
const apiKey = process.env.GEMINI_API_KEY || '';

// Initialize Google Generative AI client
export const genAI = new GoogleGenerativeAI(apiKey);

// Explicitly use gemini-3.6-flash and responseMimeType: "application/json" to guarantee structured JSON output
export const profileModel = genAI.getGenerativeModel({
  model: 'gemini-3.6-flash',
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.7,
  },
  systemInstruction: `You are the Gravitate Icebreaker & Music Profiler for "Human Orchestra", an 8-bit retro neon multiplayer rhythm game.
Analyze the user's raw intro, transcript, or bio and craft a fun, perceptive, and charming 8-bit arcade persona.
You MUST output ONLY valid JSON matching this schema:
{
  "name": "Short player display name or arcade handle (max 12 characters)",
  "tagline": "Punchy retro 8-bit tagline summarizing their energy (max 8 words)",
  "bio": "A concise 1-2 sentence bio capturing their personality and spirit",
  "interests": ["3 to 5 specific hobbies, passions, or quirky interests"],
  "musicTaste": ["2 to 4 musical genres, instruments, or sound styles they love"],
  "vibe": "A fun 2-3 word aesthetic descriptor (e.g., 'Neon Synthwave Rebel', 'Chiptune Speedrunner', 'Lo-Fi Chill Voyager')",
  "icebreakers": ["2 engaging conversation-starter questions for other players to ask them"]
}`,
});

/**
 * Helper to produce a vibrant fallback profile when offline, testing, or if the API key fails.
 */
export function createFallbackProfile(input: string): UserProfile {
  const sanitized = input.trim();
  const firstName = sanitized.split(/\s+/)[0]?.replace(/[^a-zA-Z0-9]/g, '') || 'NeonRider';
  const displayName = firstName.slice(0, 12) || 'PixelHero';

  return {
    id: 'usr_' + Math.random().toString(36).slice(2, 9),
    name: displayName,
    tagline: 'Dropping 8-bit rhythms in the Human Orchestra',
    bio: sanitized || 'A rhythm enthusiast ready to jam with shared beats.',
    interests: ['Synthesizers', 'Chiptune & Retro Games', 'Co-op Jamming'],
    musicTaste: ['Synthwave', '8-Bit Chiptune', 'Electronic'],
    vibe: 'Arcade Neon Maverick',
    icebreakers: [
      'What was the first rhythm game that hooked you?',
      'If your vibe was a synth instrument, would you be lead, keys, bass, or drums?',
    ],
    approved: false, // User control directive: ALWAYS unapproved until explicit user approval
    updatedAt: Date.now(),
  };
}

/**
 * Generate a structured profile from user audio transcript or typed text.
 * Uses Gemini 3.6 Flash with responseMimeType: "application/json".
 */
export async function generateProfileFromInput(transcriptOrText: string): Promise<UserProfile> {
  const trimmed = transcriptOrText?.trim();
  if (!trimmed) {
    return createFallbackProfile('Anonymous Jammer');
  }

  // If no valid Gemini API key configured, return fallback profile gracefully
  if (!apiKey || apiKey.includes('your_gemini_api_key')) {
    console.warn('[Gravitate AI] GEMINI_API_KEY not configured. Returning fallback profile.');
    return createFallbackProfile(trimmed);
  }

  try {
    const prompt = `User raw introduction:
"${trimmed}"

Generate their structured 8-bit rhythm persona JSON now.`;

    const result = await profileModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();

    // Since responseMimeType is "application/json", response is guaranteed JSON
    const parsed = JSON.parse(text);

    return {
      id: 'usr_' + Math.random().toString(36).slice(2, 9),
      name: String(parsed.name || 'PixelPlayer').slice(0, 14),
      tagline: String(parsed.tagline || 'Ready to drop the beat in the Human Orchestra').slice(0, 80),
      bio: String(parsed.bio || trimmed),
      interests: Array.isArray(parsed.interests) && parsed.interests.length > 0
        ? parsed.interests.map(String)
        : ['Retro Gaming', 'Chiptunes', 'Multiplayer Music'],
      musicTaste: Array.isArray(parsed.musicTaste) && parsed.musicTaste.length > 0
        ? parsed.musicTaste.map(String)
        : ['Synthwave', 'Electronic Beats'],
      vibe: String(parsed.vibe || 'Neon Arcade Pilot'),
      icebreakers: Array.isArray(parsed.icebreakers) && parsed.icebreakers.length > 0
        ? parsed.icebreakers.map(String)
        : [
            'What song do you have on loop this week?',
            'What is your favorite retro arcade sound effect?'
          ],
      approved: false, // User control directive: NEVER broadcast until explicitly approved
      updatedAt: Date.now(),
    };
  } catch (err: any) {
    console.error('[Gravitate AI] Gemini profile generation error:', err?.message || err);
    return createFallbackProfile(trimmed);
  }
}
