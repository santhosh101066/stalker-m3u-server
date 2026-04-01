import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";

export function createJWT(payload: any): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadWithExp = { ...payload, exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) }; // 1 day expiration
  const body = Buffer.from(JSON.stringify(payloadWithExp)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJWT(token: string): any | false {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (sig === parts[2]) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return false; // expired
      }
      return payload;
    }
    return false;
  } catch {
    return false;
  }
}

export function authCheck(request: any): boolean {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.split(" ")[1];
  return !!verifyJWT(token);
}
