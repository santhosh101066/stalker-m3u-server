import { ServerRoute } from "@hapi/hapi";
import { Channel } from "@/models/Channel";
import { Genre } from "@/models/Genre";
import { EpgCache } from "@/models/EpgCache";
import { initialConfig } from "@/config/server";
import { liveStreamService } from "@/services/LiveStreamService";
import { serverManager } from "@/serverManager";
import { logger } from "@/utils/logger";

// Dynamic User Data
const getUserInfo = () => ({
    username: initialConfig.username || "user",
    password: initialConfig.password || "password",
    message: "Authorized",
    auth: 1,
    status: "Active",
    exp_date: "1700000000", // Future date
    is_trial: "0",
    active_cons: "0",
    created_at: "1600000000",
    max_connections: "10",
    allowed_output_formats: ["m3u8", "ts", "rtmp"],
});

const MOCK_SERVER_INFO = {
    url: initialConfig.hostname,
    port: initialConfig.port,
    https_port: "443",
    server_protocol: "http",
    rtmp_port: "8880",
    timezone: "UTC",
    timestamp_now: Math.floor(Date.now() / 1000),
    time_now: new Date().toISOString(),
    process: true,
};

export const xtreamRoutes: ServerRoute[] = [
    {
        method: "GET",
        path: "/player_api.php",
        handler: async (request, h) => {
            const { username, password, action } = request.query as {
                username?: string;
                password?: string;
                action?: string;
            };

            // Simple Auth Check (Accept any for now as per plan, or specific mock)
            // if (username !== MOCK_USER.username || password !== MOCK_USER.password) {
            //   return h.response({ user_info: { auth: 0 }, error: "Invalid credentials" }).code(401);
            // }

            if (action === "get_live_categories") {
                const genres = await Genre.findAll();
                return genres.map((g) => ({
                    category_id: g.id,
                    category_name: g.title,
                    parent_id: 0,
                }));
            }

            if (action === "get_live_streams") {
                const channels = await Channel.findAll();
                return channels.map((c) => ({
                    num: c.number,
                    name: c.name,
                    stream_type: "live",
                    stream_id: c.id,
                    stream_icon: c.logo,
                    epg_channel_id: c.id,
                    added: "1600000000",
                    category_id: c.tv_genre_id,
                    custom_sid: "",
                    tv_archive: 0,
                    direct_source: "",
                    tv_archive_duration: 0,
                }));
            }

            if (action === "get_vod_categories") {
                return []; // VOD not supported yet
            }

            if (action === "get_vod_streams") {
                return []; // VOD not supported yet
            }

            // Default: Login Action
            return {
                user_info: getUserInfo(),
                server_info: {
                    ...MOCK_SERVER_INFO,
                    url: request.info.host, // Dynamic host
                    port: request.info.host.split(':')[1] || 80,
                    timestamp_now: Math.floor(Date.now() / 1000),
                    time_now: new Date().toISOString(),
                },
            };
        },
    },
    {
        method: "GET",
        path: "/xmltv.php",
        handler: async (request, h) => {
            // Fetch latest EPG data
            const epg = await EpgCache.findOne({
                order: [["timestamp", "DESC"]],
            });

            if (!epg || !epg.data) {
                return h.response('<?xml version="1.0" encoding="UTF-8"?><tv></tv>').type("application/xml");
            }

            // For now, returning basic XML to satisfy the endpoint existence.
            return h.response('<?xml version="1.0" encoding="UTF-8"?><tv></tv>').type("application/xml");
        },
    },
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
