import { ServerRoute } from "@hapi/hapi";
import { serverManager } from "@/serverManager";
import axios from "axios";
import { logger } from "@/utils/logger";

export const vodRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/vod/play",
    handler: async (request, h) => {
      const { cmd, url } = request.query as {
        cmd: string;
        url?: string;
      };

      if (!cmd) {
        return h.response({ error: "Missing cmd parameter" }).code(400);
      }

      let streamUrl = url;
      if (!streamUrl) {
        try {
          const linkResult = await serverManager
            .getProvider()
            .getChannelLink(cmd);
          streamUrl = linkResult?.js?.cmd;
        } catch (e) {
          logger.error(`Error resolving stream URL: ${e}`);
        }
      }

      if (!streamUrl) {
        return h.response({ error: "Could not resolve stream URL" }).code(404);
      }

      logger.info(`[VOD Proxy] Streaming: ${streamUrl}`);

      const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
      const headers: Record<string, string> = {
        "User-Agent": userAgent,
        Referer: streamUrl,
      };

      if (request.headers.range) {
        headers["Range"] = request.headers.range;
        logger.info(`[VOD Proxy] Forwarding Range: ${request.headers.range}`);
      }

      try {
        const response = await axios({
          method: "get",
          url: streamUrl,
          headers: headers,
          responseType: "stream",
          validateStatus: () => true,
        });

        const proxyResponse = h.response(response.data);

        if (response.headers["content-type"]) {
          proxyResponse.type(response.headers["content-type"]);
        } else {
          proxyResponse.type("video/mp4");
        }

        if (response.headers["content-length"]) {
          proxyResponse.header(
            "Content-Length",
            response.headers["content-length"],
          );
        }

        if (response.headers["content-range"]) {
          proxyResponse.header(
            "Content-Range",
            response.headers["content-range"],
          );
        }

        if (response.headers["accept-ranges"]) {
          proxyResponse.header(
            "Accept-Ranges",
            response.headers["accept-ranges"],
          );
        }

        proxyResponse.code(response.status);

        return proxyResponse;
      } catch (error: any) {
        logger.error(`[VOD Proxy] Error: ${error.message}`);
        return h.response({ error: "Stream proxy failed" }).code(502);
      }
    },
  },
];
