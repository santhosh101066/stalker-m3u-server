import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
import axios from "axios";
import http from "http";
import https, { RequestOptions } from "https";
import crypto from "crypto";
import NodeCache from "node-cache";
import { v4 as uuidv4 } from "uuid";

// ==== Config ====
const cache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 1 day TTL, check every hour
const SECRET_KEY = process.env.SECRET_KEY || "update-this-secret";

// Optional: restrict to http/https only
function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  return u;
}

// ==== Signed URL helpers ====
function generateSignedUrl(resourceId: string, type: "segment"): string {
  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(`${resourceId}${type}`)
    .digest("hex");
  return `fetch/segment/resource?resourceId=${resourceId}&sig=${signature}`;
}

function verifySignedUrl(
  resourceId: string,
  sig: string,
  type: "segment",
): boolean {
  const expectedSig = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(`${resourceId}${type}`)
    .digest("hex");
  return sig === expectedSig;
}

// What we store per resourceId
type CacheRecord = {
  url: string;       // absolute URL to real segment
  referer?: string;  // optional referer to send upstream
};

// ==== Hapi routes ====
export const proxy: ServerRoute[] = [
  // GET /proxy?url=BASE64(m3u8)&ref=BASE64(optional referer))
  {
    method: "GET",
    path: "/api/proxy",
    handler: async (request, h) => {
      try {
        const { url, ref } = request.query as Record<string, string | undefined>;
        if (!url) return h.response({ error: "No URL provided" }).code(400);

        // Base64 decode inputs
        const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
        const referer = ref ? Buffer.from(ref, "base64").toString("utf-8") : undefined;

        const playlistUrl = assertHttpUrl(decodedUrl).href;

        // Fetch playlist text (follow redirects)
        const headers: Record<string, string> = {};
        if (referer) headers["Referer"] = referer;

        const resp = await axios.get<string>(playlistUrl, {
          responseType: "text",
          headers,
          validateStatus: () => true,
        });

        if (resp.status < 200 || resp.status >= 300) {
          return h.response({ error: "Failed to fetch stream" }).code(resp.status);
        }

        const body = resp.data || "";
        if (!body.startsWith("#EXTM3U")) {
          // Not an M3U8? Just return raw
          return h.response(body).type("text/plain");
        }

        // Rewrite lines
        const rewritten = body
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;

            // Check if line is a sub-playlist (ends with .m3u8 or contains .m3u8?)
            if (trimmed.endsWith(".m3u8") || trimmed.includes(".m3u8?")) {
              // Resolve as absolute URL against the playlist URL
              const absolute = new URL(trimmed, playlistUrl).href;
              const b64url = Buffer.from(absolute).toString("base64");
              const b64ref = referer ? Buffer.from(referer).toString("base64") : undefined;
              return `/api/proxy?url=${b64url}` + (b64ref ? `&ref=${b64ref}` : "");
            } else {
              // Treat as media segment
              const absolute = new URL(trimmed, playlistUrl).href;

              const resourceId = uuidv4();
              const record: CacheRecord = { url: absolute, referer };
              cache.set(resourceId, record);

              const signed = generateSignedUrl(resourceId, "segment");
              return signed;
            }
          })
          .join("\n");

        return h
          .response(rewritten)
          .type("application/vnd.apple.mpegurl")
          .header("Cache-Control", "no-cache");
      } catch (err: any) {
        console.error("[/proxy] error:", err?.message || err);
        return h.response({ error: "Failed to proxy playlist" }).code(500);
      }
    },
  },

  // GET /fetch/segment/resource?resourceId=...&sig=...
  {
    method: "GET",
    path: "/api/fetch/segment/resource",
    handler: async (request: Request, h: ResponseToolkit) => {
      const { resourceId, sig } = request.query as Record<string, string>;
      if (!resourceId || !sig) {
        return h.response({ error: "Missing signed URL params" }).code(400);
      }

      if (!verifySignedUrl(resourceId, sig, "segment")) {
        return h.response({ error: "Invalid signed URL" }).code(400);
      }

      const record = cache.get<CacheRecord>(resourceId);
      if (!record?.url) {
        return h.response({ error: "Resource not found or expired" }).code(404);
      }

      try {
        const parsed = new URL(record.url);
        const client = parsed.protocol === "https:" ? https : http;

        // Forward minimal headers helpful for HLS
        const fwdHeaders: Record<string, string> = {};
        const reqHeaders = request.headers;
        if (reqHeaders["user-agent"]) fwdHeaders["user-agent"] = String(reqHeaders["user-agent"]);
        if (reqHeaders["range"]) fwdHeaders["range"] = String(reqHeaders["range"]);
        if (reqHeaders["accept"]) fwdHeaders["accept"] = String(reqHeaders["accept"]);
        if (reqHeaders["accept-encoding"])
          fwdHeaders["accept-encoding"] = String(reqHeaders["accept-encoding"]);
        if (record.referer) fwdHeaders["referer"] = record.referer;

        const options: RequestOptions = {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: fwdHeaders,
        };

        // Passthrough streaming (no buffering)
        const upstreamReq = client.request(options, (upRes) => {
          // Status
          request.raw.res.statusCode = upRes.statusCode || 200;
           request.raw.res.setHeader("Access-Control-Allow-Origin", "*");
          request.raw.res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          request.raw.res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
          // Copy headers
          for (const [name, value] of Object.entries(upRes.headers)) {
            if (typeof value !== "undefined") {
              request.raw.res.setHeader(name, Array.isArray(value) ? value.join(", ") : String(value));
            }
          }
          // Ensure no caching at our side
          request.raw.res.setHeader("Cache-Control", "no-cache");

          // Pipe data
          upRes.pipe(request.raw.res);
        });

        upstreamReq.on("error", (e) => {
          console.error("[/fetch/segment/resource] upstream error:", e);
          if (!request.raw.res.headersSent) {
            request.raw.res.statusCode = 502;
          }
          request.raw.res.end("Stream failed");
        });

        upstreamReq.end();
        // We are writing to raw response; tell Hapi to abandon
        // @ts-ignore
        return h.abandon;
      } catch (err: any) {
        console.error("[/fetch/segment/resource] error:", err?.message || err);
        return h.response({ error: "Error fetching segment content" }).code(500);
      }
    },
  },
  {
    method: "OPTIONS",
    path: "/api/fetch/segment/resource",
    handler: (request, h) => {
      return h.response().code(204).header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type, Range");
    }
  }
];