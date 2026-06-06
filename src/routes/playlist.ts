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

export const playlistRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/playlist.m3u",
    handler: async (_request, h) => {
      const m3u = await getM3uV2(h.request.headers.host);

      return h
        .response(m3u)
        .type("application/vnd.apple.mpegurl")
        .header("Content-Disposition", 'inline; filename="iptv.m3u"');
    },
  },
  {
    method: "GET",
    path: "/playlist",
    handler: async () => {
      const m3u: Channel[] = await getPlaylistV2();
      return m3u;
    },
  },
  {
    method: "GET",
    path: "/vod/playlist.m3u",
    handler: async (_request, h) => {
      const m3u = await getVodM3uV2(h.request.headers.host);

      return h
        .response(m3u)
        .type("application/vnd.apple.mpegurl")
        .header("Content-Disposition", 'inline; filename="vod.m3u"');
    },
  },
  {
    method: "GET",
    path: "/epg.xml",
    handler: async (_request, h) => {
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
        refreshVodCache(h.request.headers.host);
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
