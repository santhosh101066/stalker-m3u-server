import { Channel, M3U, M3ULine } from "@/types/types";
import { initialConfig, seriesFlag } from "@/config/server";
import { readChannels, readGenres } from "./storage";
import { serverManager } from "@/serverManager";
import { SystemConfig } from "@/models/SystemConfig";
import { ConfigProfile } from "@/models/ConfigProfile";
import {
  applyGenreOverrides,
  applyChannelOverrides,
  applyPortalItemOverrides,
} from "@/utils/overrides";
import { xtreamCache } from "@/routes/xtream";
import { ContentOverride } from "@/models/ContentOverride";
import { proxiedLogoPath } from "@/utils/portalAssets";
import { logger } from "@/utils/logger";

// Cache
let liveCache: string = "#EXTM3U";
let vodCache: string = "#EXTM3U";
let vodCacheTime: number = 0;
let vodRefreshInProgress: boolean = false;
let vodRefreshStatus: string = "idle";
const VOD_CACHE_TTL = 21600000; // 6 hours

export async function loadPlaylistCache(): Promise<void> {
  try {
    const live = await SystemConfig.findByPk("playlist_cache");
    if (live?.value) {
      liveCache = live.value;
      logger.info("Restored live playlist from DB cache.");
    }
    const vod = await SystemConfig.findByPk("vod_cache");
    if (vod?.value) {
      vodCache = vod.value;
      vodCacheTime = Date.now();
      logger.info("Restored VOD cache from DB.");
    }
  } catch (e) {
    logger.error(`Failed to load playlist cache: ${e}`);
  }
}

async function saveToCache(key: string, value: string): Promise<void> {
  try {
    await SystemConfig.upsert({ key, value });
  } catch (e) {
    logger.error(`Failed to save ${key} to cache: ${e}`);
  }
}

// serverUrl is a full origin, e.g. "https://stream.example.com" or "http://192.168.1.2:3010"
function channelToM3u(channel: Channel, group: string, serverUrl: string): M3ULine {
  const logoUrl = channel.logo
    ? channel.logo.startsWith("http")
      ? channel.logo
      : decodeURI(`${serverUrl}${proxiedLogoPath(channel.logo)}`)
    : "";

  const cleanName = channel.name.replaceAll(",", "").replaceAll(" - ", "-");

  return {
    title: `TV - ${group}`,
    name: cleanName,
    header: `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${cleanName}"${
      logoUrl ? ` tvg-logo="${logoUrl}"` : ""
    } group-title="TV - ${group}",${cleanName}`,
    command: channel.cmd.includes(initialConfig.hostname)
      ? `${serverUrl}/portal/proxy?url=${encodeURIComponent(
          btoa(channel.cmd.includes(" ") ? (channel.cmd.split(" ").at(1) ?? "") : channel.cmd),
        )}`
      : `${serverUrl}/live.m3u8?cmd=${encodeURIComponent(channel.cmd)}&id=${channel.id}`,
  };
}

function matchesGroups(genreTitle: string): boolean {
  if (!initialConfig.groups || initialConfig.groups.length === 0) return true;
  return initialConfig.groups.includes(genreTitle);
}

export async function getPlaylistV2() {
  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;
  const genres = await readGenres("channel", profileId);
  const allPrograms = await readChannels(profileId);
  const m3u = (allPrograms ?? []).filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    if (!genre) return false;
    return matchesGroups(genre.title);
  });
  return m3u;
}

export async function getM3uV2(serverUrl: string) {
  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;
  const genres = await readGenres("channel", profileId);
  const allPrograms = await readChannels(profileId);

  if (!genres?.length || !allPrograms?.length) {
    return liveCache;
  }

  const originalTitleMap = new Map(genres.map((g: any) => [g.id, g.title]));
  const visibleGenres = await applyGenreOverrides(genres, "channel");
  const genreMap = new Map(visibleGenres.map((g: any) => [g.id, g]));
  const visibleChannels = await applyChannelOverrides(allPrograms);

  const m3u = visibleChannels
    .filter((channel) => {
      const genre = genreMap.get(channel.tv_genre_id);
      if (!genre) return false;
      return matchesGroups(originalTitleMap.get(channel.tv_genre_id) ?? genre.title);
    })
    .map((channel) => {
      const genre = genreMap.get(channel.tv_genre_id)!;
      return channelToM3u(channel, genre.title, serverUrl);
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name),
    );

  const result = new M3U(m3u).print(initialConfig);
  liveCache = result;
  await saveToCache("playlist_cache", result);
  return result;
}

export async function getEPGV2() {
  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;
  const genres = await readGenres("channel", profileId);
  const allPrograms = await readChannels(profileId);
  const channels = (allPrograms ?? []).filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    if (!genre) return false;
    return matchesGroups(genre.title);
  });

  let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xmltv += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  xmltv += '<tv generator-info-name="Stalker M3U Server">\n';

  channels.forEach((channel) => {
    xmltv += `  <channel id="${channel.id}">\n`;
    xmltv += `    <display-name>${channel.name}</display-name>\n`;
    xmltv += `    <icon src="${
      channel.logo
        ? decodeURI(
            `http://${initialConfig.hostname}:${initialConfig.port}${
              initialConfig.contextPath !== ""
                ? "/" + initialConfig.contextPath
                : ""
            }/misc/logos/320/${channel.logo}`,
          )
        : ""
    }"/>\n`;
    xmltv += `  </channel>\n`;
  });

  await Promise.all(
    channels.map(async (channel) => {
      try {
        const epg = await serverManager.getProvider().getEPG(channel.id);
        if (epg?.js) {
          epg.js.forEach((program) => {
            xmltv += `  <programme start="${formatTimestamp(
              program.start_timestamp,
            )}" stop="${formatTimestamp(program.stop_timestamp)}" channel="${
              channel.id
            }">\n`;
            xmltv += `    <title>${escapeXML(program.name)}</title>\n`;
            xmltv += `  </programme>\n`;
          });
        }
      } catch (error) {
        logger.error(`Failed to fetch EPG data for channel ${channel.name}: ${error}`);
      }
    }),
  );

  xmltv += "</tv>";
  return xmltv;
}

async function buildVodM3u(serverUrl: string): Promise<string> {
  const groups = await readGenres("movie");
  const visibleGroups = await applyGenreOverrides(groups, "movie");

  const getVodCache = (catId: string) =>
    xtreamCache.get<any[]>(`vod_streams_${catId}`).then((v) => v ?? []);
  const getSeriesCache = (catId: string) =>
    xtreamCache.get<any[]>(`series_list_${catId}`).then((v) => v ?? []);

  const buildLine = (item: any, isSeries: boolean, groupTitle: string, groupId: string | number) => {
    const rawLogo = (item as any).screenshot_uri || (item as any).stream_icon || (item as any).cover || "";
    const proto = initialConfig.https ? "https" : "http";
    const logoUrl = rawLogo
      ? rawLogo.startsWith("http") ? rawLogo : `${proto}://${initialConfig.hostname}:${initialConfig.port}${rawLogo}`
      : "";
    const cleanName = item.name.replaceAll(",", "").replaceAll(" - ", "-");
    const label = isSeries ? `Series - ${groupTitle}` : `VOD - ${groupTitle}`;
    return {
      title: label,
      name: cleanName,
      header: `#EXTINF:-1 tvg-id="${item.id}" tvg-name="${cleanName}"${logoUrl ? ` tvg-logo="${logoUrl}"` : ""} group-title="${label}",${cleanName}`,
      command: `${serverUrl}/api/vod/play?id=${encodeURIComponent(item.id)}&category=${encodeURIComponent(groupId)}`,
    };
  };

  // Process all groups in parallel
  const groupResults = await Promise.all(
    visibleGroups
      .filter((group) => group.id !== "*")
      .map(async (group) => {
        const lines: any[] = [];

        if (String(group.id).startsWith("vcat_")) {
          // Virtual categories: no portal backing — read from ContentOverride + xtreamCache
          const [movedMovies, movedSeries] = await Promise.all([
            ContentOverride.findAll({ where: { item_type: "movie", target_category_id: String(group.id) }, raw: true }),
            ContentOverride.findAll({ where: { item_type: "series", target_category_id: String(group.id) }, raw: true }),
          ]);
          for (const ov of movedMovies) {
            if (ov.hidden || !ov.original_category_id) continue;
            const itemId = ov.item_key.replace("movie_", "");
            const srcItems = await getVodCache(ov.original_category_id);
            const srcItem = srcItems.find((i: any) => String(i.stream_id) === itemId);
            if (!srcItem) continue;
            lines.push(buildLine({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name }, false, group.title, group.id));
          }
          for (const ov of movedSeries) {
            if (ov.hidden || !ov.original_category_id) continue;
            const itemId = ov.item_key.replace("series_", "");
            const srcItems = await getSeriesCache(ov.original_category_id);
            const srcItem = srcItems.find((i: any) => String(i.series_id) === itemId);
            if (!srcItem) continue;
            lines.push(buildLine({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name }, true, group.title, group.id));
          }
          return lines;
        }

        // Regular category: paginate through provider
        const allRawMovies: any[] = [];
        const allRawSeries: any[] = [];
        let page = 1;
        while (true) {
          const result = await serverManager.getProvider().getMovies({ category: group.id, page });
          if (!result?.js?.data) break;
          const rawItems = Array.isArray(result.js.data) ? result.js.data : [];
          if (rawItems.length === 0) break;
          allRawMovies.push(...rawItems.filter((i: any) => i[seriesFlag] != 1));
          allRawSeries.push(...rawItems.filter((i: any) => i[seriesFlag] == 1));
          if (rawItems.length < 14) break;
          page++;
        }

        const [overriddenMovies, overriddenSeries] = await Promise.all([
          applyPortalItemOverrides(allRawMovies, "movie", String(group.id), getVodCache),
          applyPortalItemOverrides(allRawSeries, "series", String(group.id), getSeriesCache),
        ]);

        for (const item of overriddenMovies) lines.push(buildLine(item, false, group.title, group.id));
        for (const item of overriddenSeries) lines.push(buildLine(item, true, group.title, group.id));
        return lines;
      }),
  );

  const m3uLines = groupResults.flat();
  return new M3U(m3uLines).print(initialConfig);
}

export function invalidateVodCache(): void {
  vodCache = "#EXTM3U";
  vodCacheTime = 0;
}

export async function refreshVodCache(serverUrl: string) {
  if (vodRefreshInProgress) {
    logger.info("VOD cache refresh already in progress, skipping...");
    return;
  }

  vodRefreshInProgress = true;
  vodRefreshStatus = "fetching";
  logger.info("Refreshing VOD cache in background...");

  // Run in background, don't await
  (async () => {
    try {
      vodCache = await buildVodM3u(serverUrl);
      vodCacheTime = Date.now();
      await saveToCache("vod_cache", vodCache);
      vodRefreshStatus = "complete";
      logger.info("VOD cache refresh complete.");
    } catch (e) {
      vodRefreshStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
      logger.error(`VOD cache refresh failed: ${e}`);
    } finally {
      vodRefreshInProgress = false;
    }
  })();
}

export function getVodRefreshStatus() {
  return {
    inProgress: vodRefreshInProgress,
    status: vodRefreshStatus,
  };
}

export async function getVodM3uV2(serverUrl: string) {
  if (vodCache === "#EXTM3U") {
    refreshVodCache(serverUrl);
    return vodCache;
  }

  if (Date.now() - vodCacheTime > VOD_CACHE_TTL) {
    refreshVodCache(serverUrl);
  }

  return vodCache;
}


function formatTimestamp(timestamp: string): string {
  const date = new Date(parseInt(timestamp) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");

  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  return `${year}${month}${day}${hours}${minutes}${seconds} +0000`;
}

function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
