import crypto from "crypto";

/**
 * Generates a random salt and hashes the password using PBKDF2.
 */
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return { hash, salt };
}

/**
 * Verifies a password against a hash and salt using PBKDF2.
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
  return hash === verifyHash;
}
