import { ServerRoute } from "@hapi/hapi";
import { Channel } from "@/models/Channel";
import { ConfigProfile } from "@/models/ConfigProfile";
import { liveStreamService } from "@/services/LiveStreamService";
import { serverManager } from "@/serverManager";
import { logger } from "@/utils/logger";
import { initialConfig } from "@/config/server";
import { handleProxyStream } from "./proxy";

export const xtreamRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { streamId } = request.params;
      const { proxy: proxyParam } = request.query as { proxy?: string };
      const activeProfile = await ConfigProfile.findOne({
        where: { isActive: true },
      });
      const profileId = activeProfile ? activeProfile.id : 1;
      const channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        return h.response("Channel not found").code(404);
      }

      const useProxy = initialConfig.proxy && proxyParam !== "0";

      if (useProxy) {
        // Pass the real upstream channel cmd (not a loopback URL) so
        // LiveStreamService fetches directly from the Xtream provider.
        const result = await liveStreamService.getPlaylist(
          channel.cmd,
          undefined,
        );
        if (typeof result === "string") {
          return h.response(result).type("application/vnd.apple.mpegurl");
        } else {
          return h.response({ error: result.error }).code(result.code);
        }
      } else {
        try {
          const redirectedUrl = await serverManager
            .getProvider()
            .getChannelLink(channel.cmd)
            .then((res) => res.js.cmd);
          if (redirectedUrl) {
            return h.redirect(redirectedUrl).code(302);
          }
          return h
            .response({ error: "Unable to fetch stream [Non Proxy]" })
            .code(400);
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Non-proxy error: ${message}`);
          return h.response({ error: "Stream fetch failed" }).code(500);
        }
      }
    },
  },
  {
    method: "GET",
    path: "/live/{username}/{password}/{streamId}.ts",
    handler: async (request, h) => {
      const { streamId } = request.params;
      const { proxy: proxyParam } = request.query as { proxy?: string };
      const activeProfile = await ConfigProfile.findOne({
        where: { isActive: true },
      });
      const profileId = activeProfile ? activeProfile.id : 1;
      const channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        return h.response("Channel not found").code(404);
      }

      const useProxy = initialConfig.proxy && proxyParam !== "0";

      if (useProxy) {
        try {
          // Proxy the TS segment directly from the upstream Xtream provider.
          return await handleProxyStream(request, h, channel.cmd);
        } catch (err: any) {
          logger.error(`Error proxying live TS stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      } else {
        try {
          const redirectedUrl = await serverManager
            .getProvider()
            .getChannelLink(channel.cmd)
            .then((res) => res.js.cmd);
          if (redirectedUrl) {
            return h.redirect(redirectedUrl).code(302);
          }
          return h
            .response({ error: "Unable to fetch stream [Non Proxy]" })
            .code(400);
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Non-proxy error: ${message}`);
          return h.response({ error: "Stream fetch failed" }).code(500);
        }
      }
    },
  },
  {
    method: "GET",
    path: "/movie/{username}/{password}/{streamId}.{extension}",
    handler: async (request, h) => {
      const { streamId, extension } = request.params;
      const upstreamUrl = `http://${initialConfig.hostname}:${initialConfig.port}/movie/${initialConfig.username}/${initialConfig.password}/${streamId}.${extension}`;

      if (initialConfig.proxy) {
        try {
          return await handleProxyStream(request, h, upstreamUrl);
        } catch (err: any) {
          logger.error(`Error proxying movie stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      } else {
        return h.redirect(upstreamUrl).code(302);
      }
    },
  },
  {
    method: "GET",
    path: "/series/{username}/{password}/{episodeId}.{extension}",
    handler: async (request, h) => {
      const { episodeId, extension } = request.params;
      const upstreamUrl = `http://${initialConfig.hostname}:${initialConfig.port}/series/${initialConfig.username}/${initialConfig.password}/${episodeId}.${extension}`;

      if (initialConfig.proxy) {
        try {
          return await handleProxyStream(request, h, upstreamUrl);
        } catch (err: any) {
          logger.error(`Error proxying series stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      } else {
        return h.redirect(upstreamUrl).code(302);
      }
    },
  },
];
