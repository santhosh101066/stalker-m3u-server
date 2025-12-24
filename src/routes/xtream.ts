import { ServerRoute } from "@hapi/hapi";
import { Channel } from "@/models/Channel";
import { liveStreamService } from "@/services/LiveStreamService";
import { serverManager } from "@/serverManager";
import { logger } from "@/utils/logger";
import { initialConfig } from "@/config/server";


export const xtreamRoutes: ServerRoute[] = [
    // Live Stream Proxy
    {
        method: "GET",
        path: "/live/{username}/{password}/{streamId}.m3u8",
        handler: async (request, h) => {
            const { streamId } = request.params;
            const channel = await Channel.findByPk(streamId);
            if (!channel) {
                return h.response("Channel not found").code(404);
            }

            // Reuse existing logic directly
            if (initialConfig.proxy) {
                const result = await liveStreamService.getPlaylist(channel.cmd, undefined);
                if (typeof result === 'string') {
                    return h.response(result).type("application/vnd.apple.mpegurl");
                } else {
                    return h.response({ error: result.error }).code(result.code);
                }
            } else {
                try {
                    const redirectedUrl = await serverManager.getProvider().getChannelLink(channel.cmd).then(res => res.js.cmd);
                    if (redirectedUrl) {
                        return h.redirect(redirectedUrl).code(302);
                    }
                    return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
                } catch (err: any) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.error(`Non-proxy error: ${message}`);
                    return h.response({ error: "Stream fetch failed" }).code(500);
                }
            }
        }
    },
    {
        method: "GET",
        path: "/live/{username}/{password}/{streamId}.ts",
        handler: async (request, h) => {
            const { streamId } = request.params;
            const channel = await Channel.findByPk(streamId);
            if (!channel) {
                return h.response("Channel not found").code(404);
            }

            // Reuse existing logic directly
            if (initialConfig.proxy) {
                // TS segments are handled via /player/{resourceId} usually, but for Xtream API compatibility
                // we might need to rethink this. The current LiveStreamService returns rewritten playlists pointing to /player/...
                // If the client requests .ts directly here, it's likely expecting a direct stream or redirect.

                // For now, let's redirect to the upstream URL if possible, or fail if proxy is strictly required for segments.
                // Ideally, the m3u8 returned above should have pointed to /player/... which handles segments.
                // If a client is guessing .ts URLs, this might fail with the new architecture.

                return h.response("Direct TS access via this route not supported in new proxy engine").code(501);
            } else {
                try {
                    const redirectedUrl = await serverManager.getProvider().getChannelLink(channel.cmd).then(res => res.js.cmd);
                    if (redirectedUrl) {
                        return h.redirect(redirectedUrl).code(302);
                    }
                    return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
                } catch (err: any) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.error(`Non-proxy error: ${message}`);
                    return h.response({ error: "Stream fetch failed" }).code(500);
                }
            }
        }
    }
];
