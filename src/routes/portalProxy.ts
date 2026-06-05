import { ServerRoute } from "@hapi/hapi";
import http from "http";
import https from "https";
import { initialConfig } from "@/config/server";

export const portalProxy: ServerRoute[] = [
  {
    method: "GET",
    path: "/portal/proxy",
    handler: (request, h) => {
      const { url } = request.query as { url?: string };
      if (!url) {
        return h.response("Missing url").code(400);
      }

      const decodedUrl = Buffer.from(url, "base64").toString("utf-8");
      const client = decodedUrl.startsWith("https") ? https : http;

      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          "Accept-Encoding": "gzip, deflate, br",
          Accept: "*/*",
          Connection: "keep-alive",
        };
        if (initialConfig.providerType === "xtream") {
          headers["User-Agent"] = "VLC/3.0.16 LibVLC/3.0.16";
        }

        const upstreamReq = client.get(
          decodedUrl,
          {
            headers,
          },
          (upstreamRes) => {
            const response = h.response(upstreamRes);

            response
              .code(upstreamRes.statusCode || 200)
              .type("video/mp2t")
              .header("Cache-Control", "no-cache")
              .header("Connection", "keep-alive");

            if (upstreamRes.headers["content-length"]) {
              response.header(
                "Content-Length",
                upstreamRes.headers["content-length"],
              );
            }
            if (upstreamRes.headers["accept-ranges"]) {
              response.header(
                "Accept-Ranges",
                upstreamRes.headers["accept-ranges"],
              );
            }

            resolve(response);
          },
        );

        upstreamReq.on("error", (err) => {
          console.error("Proxy error:", err);
          reject(h.response("Proxy failed").code(500));
        });
      });
    },
  },
];
