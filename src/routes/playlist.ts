import { generateGroup } from "@/utils/generateGroups";
import { getEPG, getM3u } from "@/utils/getM3uUrls";
import { ServerRoute } from "@hapi/hapi";

const isEmptyM3u = (content: string) => content.trim() === "#EXTM3U";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const playlistRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/playlist.m3u",
    handler: async (request, h) => {
      let m3u = "";
      const maxRetries = 2;

      for (let i = 0; i <= maxRetries; i++) {
        m3u = await getM3u();
        if (!isEmptyM3u(m3u)) break;
        if (i < maxRetries) await delay(1000); // 1 second delay between retries
      }

      return h
        .response(m3u)
        .type("application/vnd.apple.mpegurl")
        .header("Content-Disposition", 'inline; filename="iptv.m3u"');
    },
  },
  {
    method: "GET",
    path: "/epg.xml",
    handler: async (request, h) => {
      const epg = await getEPG();
      return h
        .response(epg)
        .type("application/xml")
        .header("Content-Disposition", 'inline; filename="epg.xml"');
    },
  },
];
