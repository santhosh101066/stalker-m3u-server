import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
import { httpClient } from "@/utils/httpClient";
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

// Reusable streaming handler
export async function handleProxyStream(request: any, h: any, decodedUrl: string, referer?: string) {
  // Pass essential headers from the client to the upstream server
  const requestHeaders: Record<string, string | undefined> = {
    'Referer': referer, // Only use the explicitly passed referer, not the browser's
    'User-Agent': 'VLC/3.0.16 LibVLC/3.0.16', // Mimic VLC
    'Accept': '*/*', // Accept everything
    // 'Accept-Encoding': request.headers['accept-encoding'], // Let axios handle this or default
  };
  if (request.headers.range) {
    requestHeaders['Range'] = request.headers.range;
  }

  const response = await httpClient.get(decodedUrl, {
    responseType: 'stream',
    headers: requestHeaders,
  });

  const stream = response.data as http.IncomingMessage;
  const hapiResponse = h.response(stream).code(response.status);

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

  // Add CORS headers
  hapiResponse.header('Access-Control-Allow-Origin', '*');
  hapiResponse.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  hapiResponse.header('Access-Control-Allow-Headers', 'Content-Type, Range');

  return hapiResponse;
}

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

        return await handleProxyStream(request, h, decodedUrl, referer);
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

        // --- SMART PROXY LOGIC ---
        // 1. Check Content-Type via HEAD request first
        try {
          const headRes = await httpClient.head(playlistUrl, { headers });
          const contentType = headRes.headers['content-type'] || '';

          // If it looks like a video or binary stream, use the streaming handler directly
          if (contentType.includes('video/') || contentType.includes('application/octet-stream')) {
            console.log(`[SmartProxy] Detected binary content (${contentType}), streaming directly.`);
            return await handleProxyStream(request, h, playlistUrl, referer);
          }
        } catch (headErr) {
          console.warn("[SmartProxy] HEAD request failed, falling back to GET", headErr);
        }

        // 2. If not binary, fetch as text (assuming playlist)
        const resp = await httpClient.get<string>(playlistUrl, {
          responseType: "text",
          headers,
        });

        if (resp.status < 200 || resp.status >= 300) {
          return h.response({ error: "Failed to fetch stream" }).code(resp.status);
        }

        const body = resp.data || "";

        const finalUrl = resp.request?.res?.responseUrl || playlistUrl;

        // 3. Double check content if HEAD failed or lied
        if (!body.startsWith("#EXTM3U")) {
          // If it doesn't look like a playlist, maybe it's a text-based error or something else.
          // But if we are here, we probably expected a playlist. 
          // If it's actually binary data that axios tried to read as text, 'body' might be garbage.
          // Ideally we should have caught this with Content-Type.
          // For now, return as plain text.
          return h.response(body).type("text/plain");
        }

        // --- REWRITE LOGIC (Existing) ---

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

            const absolute = new URL(urlToRewrite, finalUrl).href;
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
        // --- END REWRITE LOGIC ---

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
