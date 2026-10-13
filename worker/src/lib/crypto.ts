const encoder = new TextEncoder();

/** Workers cap PBKDF2 at 100k iterations. */
export const PBKDF2_ITERATIONS = 100_000;
const HASH_PREFIX = "pbkdf2_sha256";

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${base64url(randomBytes(bytes))}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, PBKDF2_ITERATIONS);
  return { hash: `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${base64(derived)}`, salt: base64(salt) };
}

export async function verifyPassword(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
  const [prefix, iterationsText, expected] = storedHash.split("$");
  const iterations = Number(iterationsText);
  if (prefix !== HASH_PREFIX || !expected || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  try {
    const derived = await derive(password, fromBase64(storedSalt), iterations);
    return timingSafeEqual(derived, fromBase64(expected));
  } catch {
    return false;
  }
}

let dummy: Promise<{ hash: string; salt: string }> | undefined;

/** Spends the same work as a real verification so unknown emails are not distinguishable by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("timing-equaliser-not-a-password");
  const { hash, salt } = await dummy;
  await verifyPassword(password, hash, salt);
}
