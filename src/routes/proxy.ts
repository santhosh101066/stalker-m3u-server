import { ServerRoute, Request, ResponseToolkit } from "@hapi/hapi";
import { httpClient } from "@/utils/httpClient";
import http from "http";
import https, { RequestOptions } from "https";

function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  return u;
}

export function getProxiedUrl(url: string, referer?: string): string {
  const b64url = Buffer.from(url).toString("base64");
  if (referer) {
    const b64ref = Buffer.from(referer).toString("base64");
    return `/api/proxy/stream?url=${b64url}&ref=${b64ref}`;
  }
  return `/api/proxy/stream?url=${b64url}`;
}

export async function handleProxyStream(
  request: any,
  h: any,
  decodedUrl: string,
  referer?: string,
) {
  const requestHeaders: Record<string, string | undefined> = {
    Referer: referer,
    "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
    Accept: "*/*",
  };
  if (request.headers.range) {
    requestHeaders["Range"] = request.headers.range;
  }

  const response = await httpClient.get(decodedUrl, {
    responseType: "stream",
    headers: requestHeaders,
  });

  const stream = response.data as http.IncomingMessage;
  const hapiResponse = h.response(stream).code(response.status);

  const headersToCopy = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "date",
    "last-modified",
    "etag",
  ];

  for (const [key, value] of Object.entries(response.headers)) {
    if (value && headersToCopy.includes(key.toLowerCase())) {
      hapiResponse.header(key, value.toString());
    }
  }

  hapiResponse.header("Access-Control-Allow-Origin", "*");
  hapiResponse.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  hapiResponse.header("Access-Control-Allow-Headers", "Content-Type, Range");

  return hapiResponse;
}

export const proxy: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/proxy/stream",
    handler: async (request, h) => {
      const { url, ref } = request.query as Record<string, string | undefined>;
      if (!url) {
        return h.response({ error: "No URL provided" }).code(400);
      }

      try {
        const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
        const referer = ref
          ? Buffer.from(ref, "base64").toString("utf-8")
          : undefined;

        return await handleProxyStream(request, h, decodedUrl, referer);
      } catch (error: any) {
        console.error("[/proxy/stream] error:", error.message || error);
        if (error.response) {
          return h
            .response({ error: "Failed to fetch upstream content" })
            .code(error.response.status);
        }
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/proxy",
    handler: async (request, h) => {
      try {
        const { url, ref } = request.query as Record<
          string,
          string | undefined
        >;
        if (!url) return h.response({ error: "No URL provided" }).code(400);

        const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
        const referer = ref
          ? Buffer.from(ref, "base64").toString("utf-8")
          : undefined;

        const playlistUrl = assertHttpUrl(decodedUrl).href;

        const headers: Record<string, string> = {};
        if (referer) headers["Referer"] = referer;

        try {
          const headRes = await httpClient.head(playlistUrl, { headers });
          const contentType = headRes.headers["content-type"] || "";

          if (
            contentType.includes("video/") ||
            contentType.includes("application/octet-stream")
          ) {
            console.log(
              `[SmartProxy] Detected binary content (${contentType}), streaming directly.`,
            );
            return await handleProxyStream(request, h, playlistUrl, referer);
          }
        } catch (headErr) {
          console.warn(
            "[SmartProxy] HEAD request failed, falling back to GET",
            headErr,
          );
        }

        const resp = await httpClient.get<string>(playlistUrl, {
          responseType: "text",
          headers,
        });

        if (resp.status < 200 || resp.status >= 300) {
          return h
            .response({ error: "Failed to fetch stream" })
            .code(resp.status);
        }

        const body = resp.data || "";

        const finalUrl = resp.request?.res?.responseUrl || playlistUrl;

        if (!body.startsWith("#EXTM3U")) {
          return h.response(body).type("text/plain");
        }

        const urlRegex = /(URI="([^"]+)")|((^[^#\n\r].*)$)/gm;

        const rewritten = body.replace(
          urlRegex,
          (match, uriAttribute, uriValue, segmentUrl) => {
            const urlToRewrite = uriValue || segmentUrl;
            if (!urlToRewrite) return match;

            const absolute = new URL(urlToRewrite, finalUrl).href;
            const b64url = Buffer.from(absolute).toString("base64");
            const b64ref = referer
              ? Buffer.from(referer).toString("base64")
              : undefined;

            let proxiedUrl: string;

            if (
              urlToRewrite.endsWith(".m3u8") ||
              urlToRewrite.includes(".m3u8?")
            ) {
              proxiedUrl =
                `/api/proxy?url=${b64url}` + (b64ref ? `&ref=${b64ref}` : "");
            } else {
              proxiedUrl = getProxiedUrl(absolute, referer);
            }

            if (uriValue) {
              return `URI="${proxiedUrl}"`;
            } else {
              return proxiedUrl;
            }
          },
        );

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
