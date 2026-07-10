import { Channel } from "@/types/types";
import {
  getEPGV2,
  getM3uV2,
  getPlaylistV2,
  getVodM3uV2,
  refreshVodCache,
  getVodRefreshStatus,
} from "@/utils/getM3uUrls";
import { ServerRoute } from "@hapi/hapi";
import { resolveXtreamUser } from "./xtream";
import { getPublicOrigin } from "@/utils/publicUrl";

export const playlistRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/playlist.m3u",
    handler: async (request, h) => {
      const { username, password } = request.query as Record<string, string>;
      if (!await resolveXtreamUser(username, password)) {
        return h.response("Unauthorized").code(401);
      }
      const m3u = await getM3uV2(getPublicOrigin(request));

      return h
        .response(m3u)
        .type("application/vnd.apple.mpegurl")
        .header("Content-Disposition", 'inline; filename="iptv.m3u"');
    },
  },
  {
    method: "GET",
    path: "/playlist",
    handler: async (request, h) => {
      const { username, password } = request.query as Record<string, string>;
      if (!await resolveXtreamUser(username, password)) {
        return h.response({ error: "Unauthorized" }).code(401);
      }
      const m3u: Channel[] = await getPlaylistV2();
      return m3u;
    },
  },
  {
    method: "GET",
    path: "/vod/playlist.m3u",
    handler: async (request, h) => {
      const { username, password } = request.query as Record<string, string>;
      if (!await resolveXtreamUser(username, password)) {
        return h.response("Unauthorized").code(401);
      }
      const m3u = await getVodM3uV2(getPublicOrigin(request));

      return h
        .response(m3u)
        .type("application/vnd.apple.mpegurl")
        .header("Content-Disposition", 'inline; filename="vod.m3u"');
    },
  },
  {
    method: "GET",
    path: "/epg.xml",
    handler: async (request, h) => {
      const { username, password } = request.query as Record<string, string>;
      if (!await resolveXtreamUser(username, password)) {
        return h.response("Unauthorized").code(401);
      }
      const epg = await getEPGV2();
      return h
        .response(epg)
        .type("application/xml")
        .header("Content-Disposition", 'inline; filename="epg.xml"');
    },
  },
  {
    method: "POST",
    path: "/api/refresh/vod",
    handler: async (_request, h) => {
      try {
        refreshVodCache(getPublicOrigin(h.request));
        return h
          .response({ success: true, message: "VOD cache refresh started in background" })
          .code(202);
      } catch (error) {
        return h
          .response({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/refresh/vod/status",
    handler: async (_request, h) => {
      const status = getVodRefreshStatus();
      return h.response(status).code(200);
    },
  },
];
