/** Room codes: short, typeable, no look-alike characters (0/O, 1/I/L). Must satisfy the server's /^[A-Z0-9]{3,8}$/. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 4;

export function newRoomCode(): string {
  const bytes = new Uint32Array(ROOM_CODE_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Upper-case and drop anything that is not a letter or digit; '' when nothing usable is left. */
export function normalizeRoomCode(raw: string | null | undefined): string {
  const code = (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code.length >= 3 ? code : '';
}

export const roomFromUrl = () => normalizeRoomCode(new URLSearchParams(location.search).get('room'));
