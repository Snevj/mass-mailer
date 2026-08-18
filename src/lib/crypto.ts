import crypto from "crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";

function key() {
  // ENCRYPTION_KEY is preferred so rotating SESSION_SECRET (which also signs
  // session cookies) doesn't silently make every stored sender credential
  // undecryptable. Falls back to SESSION_SECRET for installs that predate
  // this split.
  const s = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("ENCRYPTION_KEY (or SESSION_SECRET) too short for encryption");
  return crypto.createHash("sha256").update(s).digest(); // 32 bytes
}

export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (plain.startsWith(PREFIX)) return plain; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

// Safe to call on plaintext — returns as-is if not in our encrypted format.
export function decryptSecret(s: string): string {
  if (!s || !s.startsWith(PREFIX)) return s;
  try {
    const body = s.slice(PREFIX.length);
    const [iv, tag, enc] = body.split(".");
    if (!iv || !tag || !enc) return s;
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(enc, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return s;
  }
}

export function isEncrypted(s: string) {
  return typeof s === "string" && s.startsWith(PREFIX);
}
