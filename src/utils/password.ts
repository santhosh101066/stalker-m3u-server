import crypto from "crypto";

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512");
  const storedHash = Buffer.from(hash, "hex");
  return verifyHash.length === storedHash.length && crypto.timingSafeEqual(verifyHash, storedHash);
}
