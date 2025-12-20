import { ServerRoute } from "@hapi/hapi";
import http from "http";
import https from "https";

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
        const upstreamReq = client.get(
          decodedUrl,
          {
            headers: {
              "Accept-Encoding": "gzip, deflate, br",
              Accept: "*/*",
              Connection: "keep-alive",
            },
          },
          (upstreamRes) => {
            // ✅ wrap upstream Node stream in Hapi response
            const response = h.response(upstreamRes);

            response
              .code(upstreamRes.statusCode || 200)
              .type("video/mp2t")
              .header("Cache-Control", "no-cache")
              .header("Connection", "keep-alive");

            // forward upstream headers
            if (upstreamRes.headers["content-length"]) {
              response.header(
                "Content-Length",
                upstreamRes.headers["content-length"]
              );
            }
            if (upstreamRes.headers["accept-ranges"]) {
              response.header(
                "Accept-Ranges",
                upstreamRes.headers["accept-ranges"]
              );
            }

            resolve(response);
          }
        );

        upstreamReq.on("error", (err) => {
          console.error("Proxy error:", err);
          reject(h.response("Proxy failed").code(500));
        });
      });
    },
  },
];