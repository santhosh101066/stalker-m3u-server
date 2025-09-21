import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
import axios from "axios";
import http from "http";
import https, { RequestOptions } from "https";

// ==== Config ====


// Optional: restrict to http/https only
function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  return u;
}

export function getProxiedUrl(url: string, referer?: string): string {
  const b64url = Buffer.from(url).toString('base64');
  if (referer) {
    const b64ref = Buffer.from(referer).toString('base64');
    return `/api/proxy/stream?url=${b64url}&ref=${b64ref}`;
  }
  return `/api/proxy/stream?url=${b64url}`;
}




// ==== Hapi routes ====
export const proxy: ServerRoute[] = [
  {
    method: 'GET',
    path: '/api/proxy/stream',
    handler: async (request, h) => {
      const { url, ref } = request.query as Record<string, string | undefined>;
      if (!url) {
        return h.response({ error: 'No URL provided' }).code(400);
      }

      try {
        const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : undefined;

        const response = await axios.get(decodedUrl, {
          responseType: 'stream',
          headers: {
            Referer: referer,
          },
        });

        const stream = response.data as http.IncomingMessage;

        const hapiResponse = h.response(stream).code(response.status);

        // Copy all headers from the upstream response
        for (const [key, value] of Object.entries(response.headers)) {
          if (value) {
            hapiResponse.header(key, value.toString());
          }
        }
        // Add CORS headers
        hapiResponse.header('Access-Control-Allow-Origin', '*');
        hapiResponse.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        hapiResponse.header('Access-Control-Allow-Headers', 'Content-Type, Range');


        return hapiResponse;
      } catch (error: any) {
        console.error('[/proxy/stream] error:', error.message || error);
        if (error.response) {
          return h.response({ error: 'Failed to fetch upstream content' }).code(error.response.status);
        }
        return h.response({ error: 'Internal Server Error' }).code(500);
      }
    },
  },

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
            }
            const absolute = new URL(trimmed, playlistUrl).href;
            return getProxiedUrl(absolute, referer);
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

  
];