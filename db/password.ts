/**
 * Password hashing for member accounts.
 *
 * The app runs in a Worker, so bcrypt and argon2 are not available. Web Crypto
 * gives us PBKDF2, which is the standard choice in this runtime. Each password
 * gets its own random salt and the iteration count is stored with the hash, so
 * we can raise it later without locking anyone out.
 */

const ALGO = "pbkdf2";
const ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [ALGO, ITERATIONS, toBase64(salt), toBase64(hash)].join("$");
}

/** Constant time compare, so a wrong password cannot be guessed byte by byte. */
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string) {
  const [algo, rounds, salt, hash] = String(stored ?? "").split("$");
  if (algo !== ALGO || !rounds || !salt || !hash) return false;

  const iterations = Number(rounds);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  try {
    const got = await derive(password, fromBase64(salt), iterations);
    return sameBytes(got, fromBase64(hash));
  } catch {
    return false;
  }
}

/** Plain English reason a password is not good enough, or null if it is fine. */
export function passwordProblem(password: string) {
  if (password.length < 8) return "Your password needs 8 letters or more.";
  if (password.length > 200) return "That password is too long.";
  return null;
}
