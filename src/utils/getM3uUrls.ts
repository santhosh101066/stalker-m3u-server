import { Channel, M3U, M3ULine } from "@/types/types";
import { initialConfig, seriesFlag } from "@/config/server";
import { readChannels, readGenres } from "./storage";
import { serverManager } from "@/serverManager";
import { SystemConfig } from "@/models/SystemConfig";

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
      console.log("Restored live playlist from DB cache.");
    }
    const vod = await SystemConfig.findByPk("vod_cache");
    if (vod?.value) {
      vodCache = vod.value;
      vodCacheTime = Date.now();
      console.log("Restored VOD cache from DB.");
    }
  } catch (e) {
    console.error("Failed to load playlist cache:", e);
  }
}

async function saveToCache(key: string, value: string): Promise<void> {
  try {
    await SystemConfig.upsert({ key, value });
  } catch (e) {
    console.error(`Failed to save ${key} to cache:`, e);
  }
}

function channelToM3u(channel: Channel, group: string, host: string): M3ULine {
  const logoUrl = channel.logo
    ? channel.logo.startsWith("http")
      ? channel.logo
      : decodeURI(
          `http://${initialConfig.hostname}:${initialConfig.port}${
            initialConfig.contextPath !== "" ? "/" + initialConfig.contextPath : ""
          }/misc/logos/320/${channel.logo}`,
        )
    : "";

  const cleanName = channel.name.replaceAll(",", "").replaceAll(" - ", "-");

  return {
    title: `TV - ${group}`,
    name: cleanName,
    header: `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${cleanName}"${
      logoUrl ? ` tvg-logo="${logoUrl}"` : ""
    } group-title="TV - ${group}",${cleanName}`,
    command: channel.cmd.includes(initialConfig.hostname)
      ? `http://${host}/portal/proxy?url=${encodeURIComponent(
          btoa(channel.cmd.split(" ").at(1) ?? ""),
        )}`
      : `http://${host}/live.m3u8?cmd=${encodeURIComponent(channel.cmd)}&id=${channel.id}`,
  };
}

function matchesGroups(genreTitle: string): boolean {
  if (!initialConfig.groups || initialConfig.groups.length === 0) return true;
  return initialConfig.groups.includes(genreTitle);
}

export async function getPlaylistV2() {
  const genres = await readGenres("channel");
  const allPrograms = await readChannels();
  const m3u = (allPrograms ?? []).filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    if (!genre) return false;
    return matchesGroups(genre.title);
  });
  return m3u;
}

export async function getM3uV2(host: string) {
  const genres = await readGenres("channel");
  const allPrograms = await readChannels();

  if (!genres?.length || !allPrograms?.length) {
    return liveCache;
  }

  const m3u = (allPrograms ?? [])
    .filter((channel) => {
      const genre = genres.find((r) => r.id === channel.tv_genre_id);
      if (!genre) return false;
      return matchesGroups(genre.title);
    })
    .map((channel) => {
      const genre = genres.find((r) => r.id === channel.tv_genre_id)!;
      return channelToM3u(channel, genre.title, host);
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
  const genres = await readGenres("channel");
  const allPrograms = await serverManager.getProvider().getChannels();
  const channels = (allPrograms.js.data ?? []).filter((channel) => {
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
        console.error(
          `Failed to fetch EPG data for channel ${channel.name}:`,
          error,
        );
      }
    }),
  );

  xmltv += "</tv>";
  return xmltv;
}

async function buildVodM3u(host: string): Promise<string> {
  const groups = await readGenres("movie");
  const m3uLines: any[] = [];

  for (const group of groups) {
    if (group.id === "*") continue;
    let page = 1;
    while (true) {
      const result = await serverManager.getProvider().getMovies({ category: group.id, page });
      if (!result?.js?.data) break;
      const items = Array.isArray(result.js.data) ? result.js.data : [];
      if (items.length === 0) break;

      for (const item of items) {
        const logoUrl = (item as any).screenshot_uri
          ? (item as any).screenshot_uri.startsWith("http")
            ? (item as any).screenshot_uri
            : `http://${initialConfig.hostname}:${initialConfig.port}${(item as any).screenshot_uri}`
          : "";
        const cleanName = item.name.replaceAll(",", "").replaceAll(" - ", "-");
        const isSeries = (item as any)[seriesFlag] == 1;
        const groupTitle = isSeries ? `Series - ${group.title}` : `VOD - ${group.title}`;

        m3uLines.push({
          title: groupTitle,
          name: cleanName,
          header: `#EXTINF:-1 tvg-id="${item.id}" tvg-name="${cleanName}"${
            logoUrl ? ` tvg-logo="${logoUrl}"` : ""
          } group-title="${groupTitle}",${cleanName}`,
          command: `http://${host}/api/vod/play?id=${encodeURIComponent(item.id)}&category=${encodeURIComponent(group.id)}`,
        });
      }

      if (items.length < 14) break;
      page++;
    }
  }

  return new M3U(m3uLines).print(initialConfig);
}

export async function refreshVodCache(host: string) {
  if (vodRefreshInProgress) {
    console.log("VOD cache refresh already in progress, skipping...");
    return;
  }

  vodRefreshInProgress = true;
  vodRefreshStatus = "fetching";
  console.log("Refreshing VOD cache in background...");

  // Run in background, don't await
  (async () => {
    try {
      vodCache = await buildVodM3u(host);
      vodCacheTime = Date.now();
      await saveToCache("vod_cache", vodCache);
      vodRefreshStatus = "complete";
      console.log("VOD cache refresh complete.");
    } catch (e) {
      vodRefreshStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
      console.error("VOD cache refresh failed:", e);
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

export async function getVodM3uV2(host: string) {
  if (vodCache === "#EXTM3U") {
    refreshVodCache(host);
    return vodCache;
  }

  if (Date.now() - vodCacheTime > VOD_CACHE_TTL) {
    refreshVodCache(host);
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
