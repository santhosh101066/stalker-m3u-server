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
        const referer = ref
          ? Buffer.from(ref, 'base64').toString('utf-8')
          : undefined;

        // --- MODIFICATION START ---
        // Pass essential headers from the client to the upstream server
        const requestHeaders: Record<string, string | undefined> = {
          'Referer': referer,
          'User-Agent': request.headers['user-agent'],
          'Accept': request.headers['accept'],
          'Accept-Encoding': request.headers['accept-encoding'], // Pass client's encoding preference
        };
        if (request.headers.range) {
          requestHeaders['Range'] = request.headers.range;
        }
        // --- MODIFICATION END ---

        const response = await axios.get(decodedUrl, {
          responseType: 'stream',
          headers: requestHeaders,
          validateStatus: () => true,
        });

        const stream = response.data as http.IncomingMessage;
        const hapiResponse = h.response(stream).code(response.status);

        // --- MODIFICATION START ---
        // Copy critical headers from the upstream response to the client
        // Explicitly DO NOT copy 'content-encoding' as axios handles decompression
        const headersToCopy = [
          'content-type',
          'content-length',
          'accept-ranges',
          'content-range',
          'date',
          'last-modified',
          'etag',
        ];

        for (const [key, value] of Object.entries(response.headers)) {
          if (value && headersToCopy.includes(key.toLowerCase())) {
            hapiResponse.header(key, value.toString());
          }
        }
        // --- MODIFICATION END ---

        // Add CORS headers
        hapiResponse.header('Access-Control-Allow-Origin', '*');
        hapiResponse.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        hapiResponse.header('Access-Control-Allow-Headers', 'Content-Type, Range');

        return hapiResponse;
      } catch (error: any) {
        console.error('[/proxy/stream] error:', error.message || error);
        if (error.response) {
          return h
            .response({ error: 'Failed to fetch upstream content' })
            .code(error.response.status);
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

        const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
        const referer = ref
          ? Buffer.from(ref, "base64").toString("utf-8")
          : undefined;

        const playlistUrl = assertHttpUrl(decodedUrl).href;

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
          return h.response(body).type("text/plain");
        }

        // --- NEW REWRITE LOGIC ---
        
        // Regex to find:
        // 1. URI="([^"]+)" (captures the URL in group 2)
        // 2. A line that is not a tag and not empty (captures the URL in group 3)
        const urlRegex = /(URI="([^"]+)")|((^[^#\n\r].*)$)/gm;

        const rewritten = body.replace(
          urlRegex,
          (match, uriAttribute, uriValue, segmentUrl) => {
            // Determine which part of the regex matched
            const urlToRewrite = uriValue || segmentUrl;
            if (!urlToRewrite) return match;

            const absolute = new URL(urlToRewrite, playlistUrl).href;
            const b64url = Buffer.from(absolute).toString("base64");
            const b64ref = referer
              ? Buffer.from(referer).toString("base64")
              : undefined;

            let proxiedUrl: string;

            // Check if the URL is another playlist or a segment
            if (urlToRewrite.endsWith(".m3u8") || urlToRewrite.includes(".m3u8?")) {
              // It's a playlist, proxy it through this /api/proxy endpoint
              proxiedUrl = `/api/proxy?url=${b64url}` + (b64ref ? `&ref=${b64ref}` : "");
            } else {
              // It's a segment, proxy it through the /api/proxy/stream endpoint
              proxiedUrl = getProxiedUrl(absolute, referer);
            }

            if (uriValue) {
              // Re-wrap it in the URI="..." attribute
              return `URI="${proxiedUrl}"`;
            } else {
              // It was a plain URL, so just return the proxied URL
              return proxiedUrl;
            }
          }
        );
        // --- END NEW LOGIC ---

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
