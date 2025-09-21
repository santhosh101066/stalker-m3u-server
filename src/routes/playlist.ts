import { Channel } from "@/types/types";
import {
  getEPGV2,
  getM3uV2,
  getPlaylistV2,
} from "@/utils/getM3uUrls";
import { ServerRoute } from "@hapi/hapi";

const isEmptyM3u = (content: string) => content.trim() === "#EXTM3U";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const playlistRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/playlist.m3u",
    handler: async (request, h) => {
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
    handler: async (request, h) => {
      let m3u: Channel[] = await getPlaylistV2();
      return m3u;
    },
  },
  {
    method: "GET",
    path: "/epg.xml",
    handler: async (request, h) => {
      const epg = await getEPGV2();
      return h
        .response(epg)
        .type("application/xml")
        .header("Content-Disposition", 'inline; filename="epg.xml"');
    },
  },
];
