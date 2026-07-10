import { Request } from "@hapi/hapi";
import { serverProtocol } from "@/config/server";
import { logger } from "@/utils/logger";

// Resolves the URL the client actually used so generated links work both when
// the server is reached directly (ip:port) and through a reverse proxy (domain).
//
// Priority:
//   1. PUBLIC_BASE_URL env var (e.g. "https://iptv.example.com") — hard override
//   2. X-Forwarded-Proto / X-Forwarded-Host headers set by the reverse proxy
//   3. The Host header of the incoming request

function parseBaseUrl(): { proto: "http" | "https"; host: string } | null {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { proto: u.protocol === "https:" ? "https" : "http", host: u.host };
  } catch {
    logger.warn(`[publicUrl] Invalid PUBLIC_BASE_URL "${raw}" — ignoring. Fix this env var or generated URLs will be wrong.`);
    return null;
  }
}

const baseUrlOverride = parseBaseUrl();

export function getPublicProto(request: Request): "http" | "https" {
  if (baseUrlOverride) return baseUrlOverride.proto;
  const fwd = request.headers["x-forwarded-proto"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim() === "https" ? "https" : "http";
  }
  return serverProtocol;
}

export function getPublicHost(request: Request): string {
  if (baseUrlOverride) return baseUrlOverride.host;
  const fwd = request.headers["x-forwarded-host"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return request.info.host || "localhost:3000";
}

export function getPublicOrigin(request: Request): string {
  return `${getPublicProto(request)}://${getPublicHost(request)}`;
}
