import { ServerRoute } from "@hapi/hapi";
import { Channel } from "@/models/Channel";
import { XtreamCache } from "@/models/XtreamCache";
import { ConfigProfile } from "@/models/ConfigProfile";
import { liveStreamService } from "@/services/LiveStreamService";
import { serverManager } from "@/serverManager";
import { logger } from "@/utils/logger";
import { initialConfig, seriesFlag, serverProtocol } from "@/config/server";
import { readGenres, readChannels, upsertGenre, deleteGenre } from "@/utils/storage";
import {
  applyXtreamCatOverrides,
  applyXtreamChannelOverrides,
  applyVodOverrides,
  applySeriesOverrides,
  getHiddenGenreIds,
} from "@/utils/overrides";
import { getEpgCache } from "@/utils/epg";
import { fetchMovieMeta, fetchTVMeta, TmdbMeta } from "@/utils/tmdb";
import { SystemConfig } from "@/models/SystemConfig";
import { handleProxyStream } from "./proxy";

const TTL_MS = 24 * 60 * 60 * 1000;

export const xtreamCache = {
  async get<T>(key: string): Promise<T | undefined> {
    const row = await XtreamCache.findOne({ where: { key } });
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  },

  async getWithStaleness<T>(key: string): Promise<{ value: T | undefined; isStale: boolean }> {
    const row = await XtreamCache.findOne({ where: { key } });
    if (!row) return { value: undefined, isStale: true };
    const isStale = row.expiresAt < new Date();
    try {
      return { value: JSON.parse(row.value) as T, isStale };
    } catch {
      return { value: undefined, isStale: true };
    }
  },

  async set(key: string, value: any): Promise<void> {
    const expiresAt = new Date(Date.now() + TTL_MS);
    await XtreamCache.upsert({ key, value: JSON.stringify(value), expiresAt });
  },

  async delete(key: string): Promise<void> {
    await XtreamCache.destroy({ where: { key } });
  },
};

// ── Category versioning ────────────────────────────────────────────────────────
// Each warm cycle that finds new content writes a fresh Unix timestamp as the
// version. The timestamp is appended to every VOD/series category ID in Xtream
// API responses. The player sees new category IDs and re-fetches stream lists.
// Internally all cache lookups always use the bare (unversioned) genre ID, so
// a single vod_cat_version row in SystemConfig is the only moving part.

async function getVodVersion(): Promise<number> {
  try {
    const row = await SystemConfig.findByPk("vod_cat_version");
    return row ? (Number(row.value) || 1) : 1;
  } catch { return 1; }
}

export async function bumpVodVersion(): Promise<void> {
  const ts = Date.now();
  await SystemConfig.upsert({ key: "vod_cat_version", value: ts });
  logger.info(`[Xtream] VOD category version set to ${ts}`);
}

const vodVersioningEnabled = process.env.VOD_CATEGORY_VERSIONING === "true";

function addVer(id: string | number, v: number): string {
  return vodVersioningEnabled ? `${id}_v${v}` : String(id);
}

function stripVer(id: string): string {
  return id.replace(/_v\d+$/, "");
}

function userInfo() {
  return {
    username:               initialConfig.username || "admin",
    password:               initialConfig.password || "admin",
    message:                "Welcome",
    auth:                   1,
    status:                 "Active",
    exp_date:               "9999999999",
    is_trial:               "0",
    active_cons:            "0",
    created_at:             "0",
    max_connections:        "10",
    allowed_output_formats: ["m3u8"],
  };
}

function serverInfo(request: any) {
  const host = request.info.host?.split(":")[0] || "localhost";
  const port = request.info.host?.split(":")[1] || "3000";
  return {
    url:             host,
    port:            port,
    https_port:      "443",
    server_protocol: serverProtocol,
    rtmp_port:       port,
    timezone:        "UTC",
    timestamp_now:   Math.floor(Date.now() / 1000),
    time_now:        new Date().toISOString().replace("T", " ").slice(0, 19),
  };
}

function buildIconUrl(uri: string | undefined): string {
  if (!uri) return "";
  if (uri.startsWith("http")) return uri;
  const proto = initialConfig.https ? "https" : "http";
  return `${proto}://${initialConfig.hostname}:${initialConfig.port}${uri}`;
}

async function fetchAllPages(
  fetcher: (page: number) => Promise<any[]>,
): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const items = await fetcher(page);
    if (items.length === 0) break;
    all.push(...items);
    page++;
  }
  return all;
}

// Fetch pages until a known item is encountered; returns only the new items.
async function fetchUntilKnown(
  fetcher: (page: number) => Promise<any[]>,
  isKnown: (item: any) => boolean,
): Promise<any[]> {
  const newItems: any[] = [];
  let page = 1;
  while (true) {
    const items = await fetcher(page);
    if (items.length === 0) break;
    newItems.push(...items.filter((item) => !isKnown(item)));
    if (items.some((item) => isKnown(item))) break;
    page++;
  }
  return newItems;
}

let seriesWarmRunning = false;
let vodWarmRunning    = false;

function toUnixAdded(added: any): string {
  if (!added) return "";
  const n = Number(added);
  if (!isNaN(n) && n > 1000000000) return String(n);
  const d = new Date(added);
  return isNaN(d.getTime()) ? "" : String(Math.floor(d.getTime() / 1000));
}

function mapVodItem(m: any, num: number, categoryId: string | number): any {
  const added = toUnixAdded(m.added);
  if (m.cmd) xtreamCache.set(`vod_cmd_${m.id}`, m.cmd).catch(() => {});
  xtreamCache.set(`vod_info_${m.id}`, {
    info: {
      name:          m.name,
      cover_big:     buildIconUrl(m.screenshot_uri),
      movie_image:   buildIconUrl(m.screenshot_uri),
      releasedate:   m.year || "",
      director:      m.director || "",
      actors:        m.actors || "",
      plot:          m.description || "",
      rating:        m.rating_imdb || 0,
      backdrop_path: [],
      duration_secs: parseInt(m.time) || 0,
      genre:         m.genres_str || "",
      age:           m.rating_mpaa || m.age || "",
    },
    movie_data: {
      stream_id:           parseInt(m.id),
      name:                m.name,
      added,
      category_id:         String(categoryId),
      container_extension: "m3u8",
      custom_sid:          "",
      direct_source:       "",
    },
  }).catch(() => {});
  return {
    num,
    name:                m.name,
    stream_type:         "movie",
    stream_id:           parseInt(m.id),
    stream_icon:         buildIconUrl(m.screenshot_uri),
    rating:              m.rating_imdb || 0,
    year:                m.year || "",
    added,
    category_id:         String(categoryId),
    container_extension: "m3u8",
    custom_sid:          "",
    direct_source:       "",
  };
}

function mapSeriesItem(s: any, num: number, categoryId: string | number): any {
  return {
    num,
    name:             s.name,
    series_id:        parseInt(s.id),
    cover:            buildIconUrl(s.screenshot_uri),
    plot:             s.description || "",
    cast:             s.actors || "",
    director:         s.director || "",
    genre:            s.genres_str || "",
    releaseDate:      s.year || "",
    last_modified:    s.added || "",
    rating:           s.rating_imdb || 0,
    category_id:      String(categoryId),
    youtube_trailer:  "",
    episode_run_time: "",
    backdrop_path:    [],
  };
}

export async function warmSeriesCache(): Promise<boolean> {
  if (seriesWarmRunning) { logger.info("[XtreamSeries] Warm already running, skipping"); return false; }
  seriesWarmRunning = true;
  let newContentFound = false;
  try {
    const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
    const isNativeSeries = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;
    const genres = await readGenres("series");
    const provider = serverManager.getProvider();

    for (const genre of genres) {
      if (!genre.id || genre.id === "*") continue;
      const cacheKey = `series_list_${genre.id}`;
      try {
        const existing = await xtreamCache.get<any[]>(cacheKey) || [];
        const existingSeriesIds = new Set(existing.map((s: any) => String(s.series_id)));
        const cachedMovies = (await xtreamCache.get<any[]>(`vod_streams_${genre.id}`)) || [];
        const existingMovieIds = new Set(cachedMovies.map((m: any) => String(m.stream_id)));
        const isKnown = (item: any) =>
          existingSeriesIds.has(String(item.id)) || existingMovieIds.has(String(item.id));

        const newRaw = await fetchUntilKnown(
          async (page) => {
            const res = isNativeSeries
              ? await provider.getSeries({ category: genre.id, page })
              : await provider.getMovies({ category: genre.id, page });
            return res?.js?.data || [];
          },
          isKnown,
        );
        const newSeries = isNativeSeries ? newRaw : newRaw.filter((i: any) => i[seriesFlag] == 1);
        const newMovies = isNativeSeries ? [] : newRaw.filter((i: any) => i[seriesFlag] != 1);

        if (newSeries.length === 0 && newMovies.length === 0) {
          if (!isNativeSeries && cachedMovies.length > 0) {
            await upsertGenre(genre, "movie"); // keep genre registered
          }
          if (existing.length > 0) await xtreamCache.set(cacheKey, existing);
          logger.info(`[XtreamSeries] ${cacheKey}: up to date, skipping`);
          continue;
        }

        if (newSeries.length > 0) {
          newContentFound = true;
          const result = [
            ...newSeries.map((s, idx) => mapSeriesItem(s, idx + 1, genre.id)),
            ...existing.map((s: any, idx: number) => ({ ...s, num: newSeries.length + idx + 1 })),
          ];
          await xtreamCache.set(cacheKey, result);
          logger.info(`[XtreamSeries] ${cacheKey}: ${existing.length === 0 ? "warmed" : "added"} ${newSeries.length} series (total=${result.length})`);
        }

        if (newMovies.length > 0) {
          newContentFound = true;
          const vodKey = `vod_streams_${genre.id}`;
          const result = [
            ...newMovies.map((m, idx) => mapVodItem(m, idx + 1, genre.id)),
            ...cachedMovies.map((m: any, idx: number) => ({ ...m, num: newMovies.length + idx + 1 })),
          ];
          await xtreamCache.set(vodKey, result);
          logger.info(`[XtreamSeries] ${vodKey}: ${cachedMovies.length === 0 ? "warmed" : "added"} ${newMovies.length} movies (total=${result.length})`);
          // Category has movies — register it in movie genres so it's visible in the VOD section
          if (!isNativeSeries) await upsertGenre(genre, "movie");

        }

      } catch (e: any) {
        logger.error(`[XtreamSeries] Failed to warm ${cacheKey}: ${e.message}`);
      }
    }

  } finally {
    if (newContentFound) {
      try { await bumpVodVersion(); } catch (e: any) { logger.error(`[XtreamSeries] Failed to bump version: ${e.message}`); }
    }
    seriesWarmRunning = false;
  }
  return newContentFound;
}

export async function warmSeriesInfoCache(): Promise<void> {
  const genres = await readGenres("series");
  const provider = serverManager.getProvider();
  const seen = new Set<number>();

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) continue;

    for (const series of seriesList) {
      const seriesId = series.series_id as number;
      if (!seriesId || seen.has(seriesId)) continue;
      seen.add(seriesId);

      const cacheKey = `series_info_${seriesId}`;
      const existing = await XtreamCache.findOne({ where: { key: cacheKey } });
      if (existing) {
        try {
          const data = JSON.parse(existing.value);
          const hasEpisodes = Object.values(data?.episodes || {}).some((eps: any) => eps?.length > 0);
          const hasContent = (data?.seasons?.length > 0) && hasEpisodes;
          if (hasContent) continue;
        } catch { continue; }
      }

      try {
        // Throttle to avoid 429 from portal
        await new Promise((r) => setTimeout(r, 500));

        const seasonsData = await provider.getMovies({ category: "*", page: 1, movieId: seriesId });
        const allItems = (seasonsData?.js?.data || []) as any[];
        let seasons = allItems.filter((s: any) => s.is_season);
        // Fallback: portal may not set is_season — detect by season_number/season_name
        if (seasons.length === 0) {
          const candidates = allItems.filter((s: any) => !s.is_episode && s.id);
          seasons = candidates.filter((s: any) => s.season_number || s.season_name);
        }
        const seriesItem = allItems.find((i: any) => i[seriesFlag]) || allItems[0];

        logger.info(`[XtreamSeriesInfo] ${cacheKey}: ${allItems.length} items, ${seasons.length} seasons (first keys: ${allItems[0] ? Object.keys(allItems[0]).slice(0, 8).join(",") : "none"})`);

        const episodesMap: Record<string, any[]> = {};
        let totalEpInfo = 0;

        for (const season of seasons) {
          await new Promise((r) => setTimeout(r, 300));
          const seasonNum = String(season.season_number || "1");
          const seasonIdInt = parseInt(season.id);
          let allEps = await fetchAllPages(async (page) => {
            const r = await provider.getMovies({ category: "*", page, movieId: seriesId, seasonId: seasonIdInt });
            return r?.js?.data || [];
          });
          // Fallback: some portals store episodes under type:"series" not type:"vod"
          if (allEps.length === 0) {
            allEps = await fetchAllPages(async (page) => {
              const r = await provider.getSeries({ category: "*", page, movieId: seriesId, seasonId: seasonIdInt });
              return r?.js?.data || [];
            });
          }
          const episodes = allEps.filter((e: any) => e.is_episode);
          // Fallback: portal may not set is_episode flag — use all returned items
          const effectiveEps = episodes.length > 0 ? episodes : allEps;
          logger.info(`[XtreamSeriesInfo] ${cacheKey} season ${seasonNum} (id=${season.id}): ${allEps.length} raw items, ${effectiveEps.length} effective eps`);

          episodesMap[seasonNum] = effectiveEps.map((ep: any, idx: number) => {
            const epNum = parseInt(String(ep.series_number || (idx + 1)));
            xtreamCache.set(`ep_info_${ep.id}`, {
              movieId:   seriesId,
              seasonId:  seasonIdInt,
              seriesNum: epNum,
            }).catch(() => {});
            totalEpInfo++;
            if (ep.cmd) {
              xtreamCache.set(`ep_cmd_${ep.id}`, { cmd: ep.cmd, series_num: epNum }).catch(() => {});
            }
            return {
              id:                  ep.id,
              episode_num:         epNum,
              title:               ep.name || `Episode ${epNum}`,
              container_extension: "m3u8",
              info: {
                season:        parseInt(seasonNum),
                plot:          "",
                duration_secs: 0,
                rating:        0,
                movie_image:   "",
                releasedate:   ep.date_add || "",
              },
              direct_source: "",
            };
          });
        }

        const result = {
          info: {
            name:             seriesItem?.name || "",
            cover:            buildIconUrl(seriesItem?.screenshot_uri),
            plot:             seriesItem?.description || "",
            cast:             seriesItem?.actors || "",
            director:         seriesItem?.director || "",
            genre:            seriesItem?.genres_str || "",
            releaseDate:      seriesItem?.year || "",
            rating:           seriesItem?.rating_imdb || 0,
            backdrop_path:    [],
            youtube_trailer:  "",
            episode_run_time: "",
            category_id:      seriesItem?.category_id || "0",
          },
          episodes: episodesMap,
          seasons: seasons.map((s: any) => ({
            air_date:      s.date_add || "",
            episode_count: parseInt(s.season_series || 0),
            id:            parseInt(s.id),
            name:          s.season_name || `Season ${s.season_number}`,
            overview:      "",
            season_number: parseInt(s.season_number || 1),
            cover:         "",
            cover_big:     "",
          })),
        };

        await xtreamCache.set(cacheKey, result);
        logger.info(`[XtreamSeriesInfo] Warmed ${cacheKey}: ${totalEpInfo} episodes indexed`);
      } catch (e: any) {
        logger.error(`[XtreamSeriesInfo] Failed ${cacheKey}: ${e.message}`);
      }
    }
  }
}

let catchupRunning = false;

export async function catchupScan(): Promise<void> {
  if (catchupRunning) { logger.info("[Catchup] Already running, skipping"); return; }
  catchupRunning = true;
  try {
    const provider = serverManager.getProvider();
    const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
    const isNativeSeries = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;
    const movieGenres = await readGenres("movie");

    for (const genre of movieGenres) {
      if (!genre.id || genre.id === "*") continue;
      const vodKey    = `vod_streams_${genre.id}`;
      const seriesKey = `series_list_${genre.id}`;
      try {
        const page1Res     = await provider.getMovies({ category: genre.id, page: 1 });
        const portalTotal  = Number(page1Res?.js?.total_items ?? 0);
        const page1Items: any[] = page1Res?.js?.data || [];
        if (portalTotal === 0 || page1Items.length === 0) continue;

        const pageSize  = page1Items.length;
        const totalPages = Math.ceil(portalTotal / pageSize);

        const existingMovies = await xtreamCache.get<any[]>(vodKey);
        const existingSeries = isNativeSeries ? null : await xtreamCache.get<any[]>(seriesKey);
        const localTotal = (existingMovies?.length ?? 0) + (existingSeries?.length ?? 0);

        if (localTotal >= portalTotal) {
          logger.info(`[Catchup] ${vodKey}: up to date (local=${localTotal}, portal=${portalTotal}), skipping`);
          continue;
        }

        logger.info(`[Catchup] ${vodKey}: catching up (local=${localTotal}, portal=${portalTotal}, pages=${totalPages}, pageSize=${pageSize})`);

        const existingMovieIds  = new Set((existingMovies || []).map((m: any) => String(m.stream_id)));
        const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));

        const newMovies: any[] = [];
        const oldMovies: any[] = [];
        const newSeries: any[] = [];
        const oldSeries: any[] = [];
        let passedExistingMovies = false;
        let passedExistingSeries = false;

        for (let page = 1; page <= totalPages; page++) {
          const items: any[] = page === 1 ? page1Items : ((await provider.getMovies({ category: genre.id, page }))?.js?.data || []);
          if (items.length === 0) break;

          for (const item of items) {
            if (item[seriesFlag] == 1) {
              if (existingSeriesIds.has(String(item.id))) { passedExistingSeries = true; continue; }
              (passedExistingSeries ? oldSeries : newSeries).push(item);
            } else {
              if (existingMovieIds.has(String(item.id))) { passedExistingMovies = true; continue; }
              (passedExistingMovies ? oldMovies : newMovies).push(item);
            }
          }
        }

        if (newMovies.length > 0 || oldMovies.length > 0) {
          const base = existingMovies || [];
          const all  = [
            ...newMovies.map((m, i) => mapVodItem(m, i + 1, genre.id)),
            ...base.map((m: any, i: number) => ({ ...m, num: newMovies.length + i + 1 })),
            ...oldMovies.map((m, i) => mapVodItem(m, newMovies.length + base.length + i + 1, genre.id)),
          ];
          await xtreamCache.set(vodKey, all);
          logger.info(`[Catchup] ${vodKey}: +${newMovies.length} new, +${oldMovies.length} old (total=${all.length})`);
        }

        if (!isNativeSeries && (newSeries.length > 0 || oldSeries.length > 0)) {
          const base = existingSeries || [];
          const all  = [
            ...newSeries.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
            ...base.map((s: any, i: number) => ({ ...s, num: newSeries.length + i + 1 })),
            ...oldSeries.map((s, i) => mapSeriesItem(s, newSeries.length + base.length + i + 1, genre.id)),
          ];
          await xtreamCache.set(seriesKey, all);
          logger.info(`[Catchup] ${seriesKey}: +${newSeries.length} new, +${oldSeries.length} old (total=${all.length})`);
        }

      } catch (e: any) {
        logger.error(`[Catchup] Failed ${genre.id}: ${e.message}`);
      }
    }

    // Portal A: catch up series-only genres not covered by movie genres loop
    if (!isNativeSeries) {
      const processedMovieGenreIds = new Set(movieGenres.map((g: any) => String(g.id)));
      const seriesGenres = await readGenres("series");
      const seriesOnlyGenres = seriesGenres.filter((g: any) => g.id && g.id !== "*" && !processedMovieGenreIds.has(String(g.id)));

      for (const genre of seriesOnlyGenres) {
        const seriesKey = `series_list_${genre.id}`;
        const vodKey    = `vod_streams_${genre.id}`;
        try {
          const page1Res    = await provider.getMovies({ category: genre.id, page: 1 });
          const portalTotal = Number(page1Res?.js?.total_items ?? 0);
          const page1Items: any[] = page1Res?.js?.data || [];
          if (portalTotal === 0 || page1Items.length === 0) continue;

          const pageSize   = page1Items.length;
          const totalPages = Math.ceil(portalTotal / pageSize);

          const existingSeries = await xtreamCache.get<any[]>(seriesKey);
          const existingMovies = await xtreamCache.get<any[]>(vodKey);
          const localTotal     = (existingSeries?.length ?? 0) + (existingMovies?.length ?? 0);

          if (localTotal >= portalTotal) {
            logger.info(`[Catchup] ${seriesKey}: up to date (local=${localTotal}, portal=${portalTotal}), skipping`);
            continue;
          }

          logger.info(`[Catchup] ${seriesKey}: catching up (local=${localTotal}, portal=${portalTotal}, pages=${totalPages}, pageSize=${pageSize})`);

          const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));
          const existingMovieIds  = new Set((existingMovies  || []).map((m: any) => String(m.stream_id)));

          const newSeries: any[] = [];
          const oldSeries: any[] = [];
          const newMovies: any[] = [];
          const oldMovies: any[] = [];
          let passedExistingSeries = false;
          let passedExistingMovies = false;

          for (let page = 1; page <= totalPages; page++) {
            const items: any[] = page === 1 ? page1Items : ((await provider.getMovies({ category: genre.id, page }))?.js?.data || []);
            if (items.length === 0) break;
            for (const item of items) {
              if (item[seriesFlag] == 1) {
                if (existingSeriesIds.has(String(item.id))) { passedExistingSeries = true; continue; }
                (passedExistingSeries ? oldSeries : newSeries).push(item);
              } else {
                if (existingMovieIds.has(String(item.id))) { passedExistingMovies = true; continue; }
                (passedExistingMovies ? oldMovies : newMovies).push(item);
              }
            }
          }

          if (newSeries.length > 0 || oldSeries.length > 0) {
            const base = existingSeries || [];
            const all  = [
              ...newSeries.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
              ...base.map((s: any, i: number) => ({ ...s, num: newSeries.length + i + 1 })),
              ...oldSeries.map((s, i) => mapSeriesItem(s, newSeries.length + base.length + i + 1, genre.id)),
            ];
            await xtreamCache.set(seriesKey, all);
            logger.info(`[Catchup] ${seriesKey}: +${newSeries.length} new, +${oldSeries.length} old (total=${all.length})`);
          }

          if (newMovies.length > 0 || oldMovies.length > 0) {
            const base = existingMovies || [];
            const all  = [
              ...newMovies.map((m, i) => mapVodItem(m, i + 1, genre.id)),
              ...base.map((m: any, i: number) => ({ ...m, num: newMovies.length + i + 1 })),
              ...oldMovies.map((m, i) => mapVodItem(m, newMovies.length + base.length + i + 1, genre.id)),
            ];
            await xtreamCache.set(vodKey, all);
            logger.info(`[Catchup] ${vodKey}: +${newMovies.length} new, +${oldMovies.length} old (total=${all.length})`);
          }
        } catch (e: any) {
          logger.error(`[Catchup] Failed series-only genre ${genre.id}: ${e.message}`);
        }
      }
    }

    // Portal B: series categories are distinct — catch up via getSeries
    if (isNativeSeries) {
      const seriesGenres = await readGenres("series");
      for (const genre of seriesGenres) {
        if (!genre.id || genre.id === "*") continue;
        const seriesKey = `series_list_${genre.id}`;
        try {
          const page1Res    = await provider.getSeries({ category: genre.id, page: 1 });
          const portalTotal = Number(page1Res?.js?.total_items ?? 0);
          const page1Items: any[] = page1Res?.js?.data || [];
          if (portalTotal === 0 || page1Items.length === 0) continue;

          const pageSize   = page1Items.length;
          const totalPages = Math.ceil(portalTotal / pageSize);

          const existing   = await xtreamCache.get<any[]>(seriesKey);
          const localTotal = existing?.length ?? 0;
          if (localTotal >= portalTotal) continue;

          logger.info(`[Catchup] ${seriesKey}: catching up (local=${localTotal}, portal=${portalTotal}, pages=${totalPages})`);

          const existingIds = new Set((existing || []).map((s: any) => String(s.series_id)));
          const newSeries: any[] = [];
          const oldSeries: any[] = [];
          let passedExisting = false;

          for (let page = 1; page <= totalPages; page++) {
            const items: any[] = page === 1 ? page1Items : ((await provider.getSeries({ category: genre.id, page }))?.js?.data || []);
            if (items.length === 0) break;

            for (const item of items) {
              if (existingIds.has(String(item.id))) { passedExisting = true; continue; }
              (passedExisting ? oldSeries : newSeries).push(item);
            }
          }

          if (newSeries.length > 0 || oldSeries.length > 0) {
            const base = existing || [];
            const all  = [
              ...newSeries.map((s, i) => mapSeriesItem(s, i + 1, genre.id)),
              ...base.map((s: any, i: number) => ({ ...s, num: newSeries.length + i + 1 })),
              ...oldSeries.map((s, i) => mapSeriesItem(s, newSeries.length + base.length + i + 1, genre.id)),
            ];
            await xtreamCache.set(seriesKey, all);
            logger.info(`[Catchup] ${seriesKey}: +${newSeries.length} new, +${oldSeries.length} old (total=${all.length})`);
          }
        } catch (e: any) {
          logger.error(`[Catchup] Failed series ${genre.id}: ${e.message}`);
        }
      }
    }

    await bumpVodVersion();
    logger.info("[Catchup] Scan complete");
  } finally {
    catchupRunning = false;
  }
}

export async function cleanupGenres(): Promise<void> {
  const movieGenres = await readGenres("movie");
  const seriesGenres = await readGenres("series");

  for (const genre of movieGenres) {
    if (!genre.id || genre.id === "*") continue;
    const vodCached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    const seriesCached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    // Delete if vod cache is explicitly empty, or if vod is missing but series has data (confirmed series-only)
    const shouldDelete = (vodCached !== undefined && vodCached.length === 0) ||
                         (vodCached === undefined && seriesCached !== undefined && seriesCached.length > 0);
    if (shouldDelete) {
      await deleteGenre(genre, "movie");
      logger.info(`[Cleanup] Removed movie genre ${genre.id} (${genre.title}) from movie genres`);
    }
  }

  for (const genre of seriesGenres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesCached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    const vodCached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    // Delete if series cache is explicitly empty, or if series is missing but vod has data (confirmed movies-only)
    const noSeriesData = (seriesCached !== undefined && seriesCached.length === 0) ||
                         (seriesCached === undefined && vodCached !== undefined && vodCached.length > 0);
    if (noSeriesData) {
      await deleteGenre(genre, "series");
      logger.info(`[Cleanup] Removed series genre ${genre.id} (${genre.title}) from series genres — no series data`);
      continue;
    }
    // If series exist, check if any have episodes — skip if series_info not yet populated
    if (seriesCached && seriesCached.length > 0) {
      let hasAnyEpisodes = false;
      let allInfoAvailable = true;
      for (const series of seriesCached) {
        const info = await xtreamCache.get<any>(`series_info_${series.series_id}`);
        if (info === undefined) { allInfoAvailable = false; break; }
        const totalEps = Object.values(info.episodes || {}).reduce((sum: number, eps: any) => sum + (Array.isArray(eps) ? eps.length : 0), 0);
        if (totalEps > 0) { hasAnyEpisodes = true; break; }
      }
      if (allInfoAvailable && !hasAnyEpisodes) {
        await deleteGenre(genre, "series");
        logger.info(`[Cleanup] Removed series genre ${genre.id} (${genre.title}) from series genres — all series have 0 episodes`);
      }
    }
  }
}

export async function warmVodCache(): Promise<boolean> {
  if (vodWarmRunning) { logger.info("[XtreamVod] Warm already running, skipping"); return false; }
  vodWarmRunning = true;
  let newContentFound = false;
  try {
    const genres = await readGenres("movie");
    const provider = serverManager.getProvider();

    for (const genre of genres) {
      if (!genre.id || genre.id === "*") continue;
      const cacheKey = `vod_streams_${genre.id}`;
      try {
        const existing = await xtreamCache.get<any[]>(cacheKey) || [];
        const existingSeries = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
        const existingMovieIds  = new Set(existing.map((m: any) => String(m.stream_id)));
        const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));
        const isKnown = (item: any) =>
          existingMovieIds.has(String(item.id)) || existingSeriesIds.has(String(item.id));

        const newRaw = await fetchUntilKnown(
          async (page) => {
            const res = await provider.getMovies({ category: genre.id, page });
            return res?.js?.data || [];
          },
          isKnown,
        );
        const newMovies = newRaw.filter((i: any) => i[seriesFlag] != 1);
        const newSeries = newRaw.filter((i: any) => i[seriesFlag] == 1);

        if (newMovies.length === 0 && newSeries.length === 0) {
          // vod_streams up to date — but check if series were ever discovered for this category
          if (existingSeries === undefined) {
            // First time: full scan to find any series buried in the category
            const seriesKey = `series_list_${genre.id}`;
            const allItems = await fetchAllPages(async (page) => {
              const res = await provider.getMovies({ category: genre.id, page });
              return res?.js?.data || [];
            });
            const seriesItems = allItems.filter((i: any) => i[seriesFlag] == 1);
            if (seriesItems.length > 0) {
              await xtreamCache.set(seriesKey, seriesItems.map((s: any, idx: number) => mapSeriesItem(s, idx + 1, genre.id)));
              await upsertGenre(genre, "series");
              logger.info(`[XtreamVOD] ${seriesKey}: discovered ${seriesItems.length} series (first scan)`);
            } else {
              await xtreamCache.set(seriesKey, []); // mark as scanned so we don't re-scan next time
            }
          } else if (existingSeries.length > 0) {
            await upsertGenre(genre, "series"); // keep genre registered
          }
          if (existing.length > 0) await xtreamCache.set(cacheKey, existing);
          logger.info(`[XtreamVOD] ${cacheKey}: up to date, skipping`);
          continue;
        }

        if (newMovies.length > 0) {
          newContentFound = true;
          const result = [
            ...newMovies.map((m, idx) => mapVodItem(m, idx + 1, genre.id)),
            ...existing.map((m: any, idx: number) => ({ ...m, num: newMovies.length + idx + 1 })),
          ];
          await xtreamCache.set(cacheKey, result);
          logger.info(`[XtreamVOD] ${cacheKey}: ${existing.length === 0 ? "warmed" : "added"} ${newMovies.length} movies (total=${result.length})`);
        }

        if (newSeries.length > 0) {
          newContentFound = true;
          const seriesKey = `series_list_${genre.id}`;
          const result = [
            ...newSeries.map((s, idx) => mapSeriesItem(s, idx + 1, genre.id)),
            ...(existingSeries || []).map((s: any, idx: number) => ({ ...s, num: newSeries.length + idx + 1 })),
          ];
          await xtreamCache.set(seriesKey, result);
          logger.info(`[XtreamVOD] ${seriesKey}: ${(existingSeries || []).length === 0 ? "warmed" : "added"} ${newSeries.length} series (total=${result.length})`);
          // Category has series — register it in series genres so it's visible in the series section
          await upsertGenre(genre, "series");

        }

      } catch (e: any) {
        logger.error(`[XtreamVOD] Failed to warm ${cacheKey}: ${e.message}`);
      }
    }

  } finally {
    if (newContentFound) {
      try { await bumpVodVersion(); } catch (e: any) { logger.error(`[XtreamVod] Failed to bump version: ${e.message}`); }
    }
    vodWarmRunning = false;
  }
  return newContentFound;
}

export const xtreamRoutes: ServerRoute[] = [

  {
    method: "GET",
    path: "/xmltv.php",
    handler: async (_request, h) => {
      const epgCache = await getEpgCache();
      const channels = await readChannels();

      const escXml = (s: string) => s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const fmtTime = (ts: string) => {
        const d = new Date(Number(ts) * 1000);
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
      };

      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Stalker M3U Server">\n';

      for (const ch of channels) {
        xml += `  <channel id="${ch.id}"><display-name>${escXml(ch.name)}</display-name></channel>\n`;
      }

      if (epgCache?.data) {
        for (const [channelId, programs] of Object.entries(epgCache.data as Record<string, any[]>)) {
          for (const p of programs) {
            xml += `  <programme start="${fmtTime(p.start_timestamp)}" stop="${fmtTime(p.stop_timestamp)}" channel="${channelId}"><title>${escXml(p.name)}</title></programme>\n`;
          }
        }
      }

      xml += "</tv>";
      return h.response(xml).type("application/xml").header("Cache-Control", "no-cache");
    },
  },

  {
    method: "GET",
    path: "/player_api.php",
    handler: async (request, h) => {
      const { action } = request.query as Record<string, string>;
      const provider = serverManager.getProvider();

      if (!action) {
        return h.response({
          user_info:   userInfo(),
          server_info: serverInfo(request),
        });
      }

      try {

        // ── Live ────────────────────────────────────────────────────────────

        if (action === "get_live_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("live_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("channel");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("live_cats", raw);
          }
          return h.response(await applyXtreamCatOverrides(raw, "channel"));
        }

        if (action === "get_live_streams") {
          const { category_id } = request.query as Record<string, string>;
          const cacheKey = `live_streams_${category_id || "all"}`;
          let raw: any[];
          const cached = await xtreamCache.get<any[]>(cacheKey);
          if (cached) {
            raw = cached;
          } else {
            const data     = await provider.getChannels();
            const channels = data?.js?.data || [];
            const filtered = category_id
              ? channels.filter((c: any) => c.tv_genre_id === category_id)
              : channels;
            raw = filtered.map((c: any, idx: number) => ({
              num:                 idx + 1,
              name:                c.name?.trim(),
              stream_type:         "live",
              stream_id:           c.id,
              stream_icon:         buildIconUrl(c.logo),
              epg_channel_id:      c.id,
              added:               "",
              category_id:         c.tv_genre_id || "0",
              tv_archive:          0,
              tv_archive_duration: 0,
              direct_source:       "",
            }));
            await xtreamCache.set(cacheKey, raw);
          }
          return h.response(await applyXtreamChannelOverrides(raw));
        }

        // ── VOD ─────────────────────────────────────────────────────────────

        if (action === "get_vod_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("vod_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("movie");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("vod_cats", raw);
          }
          const vodCats = await applyXtreamCatOverrides(raw, "movie");
          const v = await getVodVersion();
          logger.info(`[player_api] get_vod_categories — version=${v} count=${vodCats.length}`);
          return h.response(vodCats.map((c: any) => ({ ...c, category_id: addVer(c.category_id, v) })));
        }

        if (action === "get_vod_streams") {
          const { category_id: rawCatId, search } = request.query as Record<string, string>;
          const category_id = rawCatId ? stripVer(rawCatId) : rawCatId;
          logger.info(`[player_api] get_vod_streams request — raw_category_id=${rawCatId ?? "(none)"} stripped=${category_id ?? "(none)"} search=${search ?? "(none)"}`);
          const getVodCache = (catId: string) =>
            xtreamCache.get<any[]>(`vod_streams_${catId}`).then((v) => v ?? []);
          let rawResult: any[];

          if (search) {
            const genres = await readGenres("movie");
            const hiddenIds = await getHiddenGenreIds("movie");
            const all: any[] = [];
            for (const genre of genres) {
              if (!genre.id || genre.id === "*") continue;
              if (hiddenIds.has(String(genre.id))) continue;
              const cached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
              if (cached) all.push(...cached);
            }
            const term = search.toLowerCase();
            rawResult = all.filter((m: any) => m.name?.toLowerCase().includes(term));
            logger.info(`[player_api] get_vod_streams search="${search}": ${rawResult.length}`);
          } else if (!category_id) {
            const genres = await readGenres("movie");
            const hiddenIds = await getHiddenGenreIds("movie");
            const all: any[] = [];
            for (const genre of genres) {
              if (!genre.id || genre.id === "*") continue;
              if (hiddenIds.has(String(genre.id))) continue;
              const cached = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
              if (cached) all.push(...cached);
            }
            rawResult = all;
            logger.info(`[player_api] get_vod_streams (all): ${all.length} movies`);
          } else if (category_id.startsWith("vcat_")) {
            rawResult = [];
          } else {
            const cacheKey = `vod_streams_${category_id}`;
            const { value: cached, isStale } = await xtreamCache.getWithStaleness<any[]>(cacheKey);

            if (cached && !isStale) {
              rawResult = cached;
            } else if (cached) {
              // Stale — fetch only new items; stop on first known item
              const existingMovieIds = new Set(cached.map((m: any) => String(m.stream_id)));
              const existingSeries = await xtreamCache.get<any[]>(`series_list_${category_id}`);
              const existingSeriesIds = new Set((existingSeries || []).map((s: any) => String(s.series_id)));
              const newRaw = await fetchUntilKnown(
                async (page) => {
                  const res = await provider.getMovies({ category: category_id, page });
                  return res?.js?.data || [];
                },
                (item) => existingMovieIds.has(String(item.id)) || existingSeriesIds.has(String(item.id)),
              );
              const newItems = newRaw.filter((i: any) => i[seriesFlag] != 1);
              if (newItems.length === 0) {
                rawResult = cached;
                await xtreamCache.set(cacheKey, cached);
              } else {
                rawResult = [
                  ...newItems.map((m, idx) => mapVodItem(m, idx + 1, category_id)),
                  ...cached.map((m: any, idx: number) => ({ ...m, num: newItems.length + idx + 1 })),
                ];
                await xtreamCache.set(cacheKey, rawResult);
              }
            } else {
              // Cache miss — full fetch
              const allRawVod = await fetchAllPages(async (page) => {
                const res = await provider.getMovies({ category: category_id, page });
                return res?.js?.data || [];
              });
              if (allRawVod.length === 0) return h.response([]);
              const vodItems = allRawVod.filter((i: any) => i[seriesFlag] != 1);
              rawResult = vodItems.map((m, idx) => mapVodItem(m, idx + 1, category_id));
              await xtreamCache.set(cacheKey, rawResult);
            }
          }

          const vodOverridden = await applyVodOverrides(rawResult, category_id ?? null, getVodCache);
          const vv = await getVodVersion();
          const finalResult = vodOverridden.map((item: any) => ({ ...item, category_id: addVer(item.category_id, vv) }));
          const cat7Sample = finalResult.filter((i: any) => i.category_id === addVer("7", vv)).slice(0, 5);
          if (cat7Sample.length > 0) logger.info(`[player_api] cat7 top5: ${cat7Sample.map((i: any) => `${i.name}(added=${i.added})`).join(", ")}`);
          return h.response(finalResult);
        }

        if (action === "get_vod_info") {
          const { vod_id } = request.query as Record<string, string>;
          if (!vod_id) return h.response({ info: {}, movie_data: {} });
          const cacheKey = `vod_info_${vod_id}`;
          let cached = await xtreamCache.get<any>(cacheKey);

          if (!cached) {
            const data = await provider.getMovies({ category: "*", page: 1, movieId: parseInt(vod_id) });
            const item = data?.js?.data?.[0] as any;
            if (!item) return h.response({ info: {}, movie_data: {} });
            mapVodItem(item, 1, item.category_id || "0");
            cached = await xtreamCache.get<any>(cacheKey);
          }

          if (!cached) return h.response({ info: {}, movie_data: {} });

          const tmdbKey = `tmdb_movie_${vod_id}`;
          let tmdb = await xtreamCache.get<TmdbMeta | { _not_found: true }>(tmdbKey);
          if (!tmdb) {
            const name = cached.movie_data?.name || cached.info?.name || "";
            const year = cached.info?.releasedate || "";
            const meta = await fetchMovieMeta(name, year);
            tmdb = meta ?? { _not_found: true };
            await xtreamCache.set(tmdbKey, tmdb);
          }

          if (tmdb && !("_not_found" in tmdb)) {
            return h.response({
              ...cached,
              info: {
                ...cached.info,
                cover_big:     tmdb.poster   ?? cached.info?.cover_big,
                movie_image:   tmdb.poster   ?? cached.info?.movie_image,
                backdrop_path: tmdb.backdrop ? [tmdb.backdrop] : (cached.info?.backdrop_path ?? []),
                plot:          tmdb.overview ?? cached.info?.plot,
              },
            });
          }
          return h.response(cached);
        }

        // ── Series ───────────────────────────────────────────────────────────

        if (action === "get_series_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("series_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("series");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("series_cats", raw);
          }
          const seriesCats = await applyXtreamCatOverrides(raw, "series");
          const vs = await getVodVersion();
          return h.response(seriesCats.map((c: any) => ({ ...c, category_id: addVer(c.category_id, vs) })));
        }

        if (action === "get_series") {
          const { category_id: rawSeriesCatId, search } = request.query as Record<string, string>;
          const category_id = rawSeriesCatId ? stripVer(rawSeriesCatId) : rawSeriesCatId;
          const getSeriesCache = (catId: string) =>
            xtreamCache.get<any[]>(`series_list_${catId}`).then((v) => v ?? []);
          let rawResult: any[];

          if (search) {
            const genres = await readGenres("series");
            const hiddenIds = await getHiddenGenreIds("series");
            const all: any[] = [];
            for (const genre of genres) {
              if (!genre.id || genre.id === "*") continue;
              if (hiddenIds.has(String(genre.id))) continue;
              const cached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
              if (cached) all.push(...cached);
            }
            const term = search.toLowerCase();
            rawResult = all.filter((s: any) => s.name?.toLowerCase().includes(term));
            logger.info(`[player_api] get_series search="${search}": ${rawResult.length}`);
          } else if (!category_id) {
            const genres = await readGenres("series");
            const hiddenIds = await getHiddenGenreIds("series");
            const all: any[] = [];
            for (const genre of genres) {
              if (!genre.id || genre.id === "*") continue;
              if (hiddenIds.has(String(genre.id))) continue;
              const cached = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
              if (cached) all.push(...cached);
            }
            rawResult = all;
            logger.info(`[player_api] get_series (all): ${all.length} series`);
          } else if (category_id.startsWith("vcat_")) {
            rawResult = [];
          } else {
            const cacheKey = `series_list_${category_id}`;
            const { value: cached, isStale } = await xtreamCache.getWithStaleness<any[]>(cacheKey);
            const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
            const isNativeSeries = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;

            if (cached && !isStale) {
              rawResult = cached;
            } else if (cached) {
              // Stale — fetch only new items
              const existingSeriesIds = new Set(cached.map((s: any) => String(s.series_id)));
              const existingMovies = isNativeSeries ? null : await xtreamCache.get<any[]>(`vod_streams_${category_id}`);
              const existingMovieIds = new Set((existingMovies || []).map((m: any) => String(m.stream_id)));
              const newRaw = await fetchUntilKnown(
                async (page) => {
                  const res = isNativeSeries
                    ? await provider.getSeries({ category: category_id, page })
                    : await provider.getMovies({ category: category_id, page });
                  return res?.js?.data || [];
                },
                (item) => existingSeriesIds.has(String(item.id)) || existingMovieIds.has(String(item.id)),
              );
              const newItems = isNativeSeries ? newRaw : newRaw.filter((i: any) => i[seriesFlag] == 1);
              if (newItems.length === 0) {
                rawResult = cached;
                await xtreamCache.set(cacheKey, cached);
              } else {
                rawResult = [
                  ...newItems.map((s, idx) => mapSeriesItem(s, idx + 1, category_id)),
                  ...cached.map((s: any, idx: number) => ({ ...s, num: newItems.length + idx + 1 })),
                ];
                await xtreamCache.set(cacheKey, rawResult);
              }
            } else {
              // Cache miss — full fetch
              let allRaw: any[];
              let seriesItems: any[];
              if (isNativeSeries) {
                allRaw = await fetchAllPages(async (page) => {
                  const res = await provider.getSeries({ category: category_id, page });
                  return res?.js?.data || [];
                });
                seriesItems = allRaw;
              } else {
                allRaw = await fetchAllPages(async (page) => {
                  const res = await provider.getMovies({ category: category_id, page });
                  return res?.js?.data || [];
                });
                seriesItems = allRaw.filter((i: any) => i[seriesFlag] == 1);
              }
              if (allRaw.length === 0) return h.response([]);
              rawResult = seriesItems.map((s, idx) => mapSeriesItem(s, idx + 1, category_id));
              await xtreamCache.set(cacheKey, rawResult);
            }
          }

          const seriesOverridden = await applySeriesOverrides(rawResult, category_id ?? null, getSeriesCache);
          const vs = await getVodVersion();
          return h.response(
            seriesOverridden.map((item: any) => ({ ...item, category_id: addVer(item.category_id, vs) })),
          );
        }

        if (action === "get_series_info") {
          const { series_id } = request.query as Record<string, string>;
          if (!series_id) return h.response({ info: {}, episodes: {}, seasons: [] });

          const cacheKey = `series_info_${series_id}`;
          const { value: cached, isStale } = await xtreamCache.getWithStaleness<any>(cacheKey);
          if (cached) {
            // Backfill ep_info so stream handler works even on cache hit
            const c = cached as any;
            const seasonIdMap: Record<string, number> = {};
            for (const s of (c.seasons || [])) seasonIdMap[String(s.season_number)] = s.id;
            for (const [seasonNum, eps] of Object.entries(c.episodes || {})) {
              const seasonId = seasonIdMap[seasonNum];
              for (const ep of (eps as any[])) {
                xtreamCache.set(`ep_info_${ep.id}`, {
                  movieId:   parseInt(series_id),
                  seasonId,
                  seriesNum: ep.episode_num,
                });
              }
            }
            if (!isStale) return h.response(cached);
            // Stale — fall through to re-fetch
          }

          // Fetch seasons
          const seasonsData = await provider.getMovies({
            category: "*",
            page:     1,
            movieId:  parseInt(series_id),
          });
          const allItems  = (seasonsData?.js?.data || []) as any[];

          if (allItems.length === 0) {
            if (cached) {
              await xtreamCache.set(cacheKey, cached);
              return h.response(cached);
            }
            return h.response({ info: {}, episodes: {}, seasons: [] });
          }

          let seasons     = allItems.filter((s: any) => s.is_season);
          // Fallback: portal may not set is_season — detect by season_number/season_name
          if (seasons.length === 0) {
            const candidates = allItems.filter((s: any) => !s.is_episode && s.id);
            seasons = candidates.filter((s: any) => s.season_number || s.season_name);
          }
          const seriesItem = allItems.find((i: any) => i[seriesFlag]) || allItems[0];

          const episodesMap: Record<string, any[]> = {};

          for (const season of seasons) {
            const seasonNum   = String(season.season_number || "1");
            const seasonIdInt = parseInt(season.id);
            const seriesIdInt = parseInt(series_id);
            let allEps = await fetchAllPages(async (page) => {
              const r = await provider.getMovies({ category: "*", page, movieId: seriesIdInt, seasonId: seasonIdInt });
              return r?.js?.data || [];
            });
            // Fallback: some portals store episodes under type:"series" not type:"vod"
            if (allEps.length === 0) {
              allEps = await fetchAllPages(async (page) => {
                const r = await provider.getSeries({ category: "*", page, movieId: seriesIdInt, seasonId: seasonIdInt });
                return r?.js?.data || [];
              });
            }
            const episodes = allEps.filter((e: any) => e.is_episode);
            // Fallback: portal may not set is_episode flag — use all returned items
            const effectiveEps = episodes.length > 0 ? episodes : allEps;

            episodesMap[seasonNum] = effectiveEps.map((ep: any, idx: number) => {
              const epNum = parseInt(String(ep.series_number || (idx + 1)));
              // Cache full context so stream handler can mirror browser: getMovies(movieId,seasonId,episodeId) + getMovieLink
              xtreamCache.set(`ep_info_${ep.id}`, {
                movieId:   parseInt(series_id),
                seasonId:  parseInt(season.id),
                seriesNum: epNum,
              });
              if (ep.cmd) {
                xtreamCache.set(`ep_cmd_${ep.id}`, { cmd: ep.cmd, series_num: epNum });
              }
              return {
                id:                  ep.id,
                episode_num:         epNum,
                title:               ep.name || `Episode ${epNum}`,
                container_extension: "m3u8",
                info: {
                  season:        parseInt(seasonNum),
                  plot:          "",
                  duration_secs: 0,
                  rating:        0,
                  movie_image:   "",
                  releasedate:   ep.date_add || "",
                },
                direct_source: "",
              };
            });
          }

          const result = {
            info: {
              name:             seriesItem?.name || "",
              cover:            buildIconUrl(seriesItem?.screenshot_uri),
              plot:             seriesItem?.description || "",
              cast:             seriesItem?.actors || "",
              director:         seriesItem?.director || "",
              genre:            seriesItem?.genres_str || "",
              releaseDate:      seriesItem?.year || "",
              rating:           seriesItem?.rating_imdb || 0,
              backdrop_path:    [],
              youtube_trailer:  "",
              episode_run_time: "",
              category_id:      seriesItem?.category_id || "0",
            },
            episodes: episodesMap,
            seasons: seasons.map((s: any) => ({
              air_date:      s.date_add || "",
              episode_count: parseInt(s.season_series || 0),
              id:            parseInt(s.id),
              name:          s.season_name || `Season ${s.season_number}`,
              overview:      "",
              season_number: parseInt(s.season_number || 1),
              cover:         "",
              cover_big:     "",
            })),
          };

          await xtreamCache.set(cacheKey, result);

          const tmdbKey = `tmdb_tv_${series_id}`;
          let tmdb = await xtreamCache.get<TmdbMeta | { _not_found: true }>(tmdbKey);
          if (!tmdb) {
            const meta = await fetchTVMeta(result.info.name, result.info.releaseDate);
            tmdb = meta ?? { _not_found: true };
            await xtreamCache.set(tmdbKey, tmdb);
          }

          if (tmdb && !("_not_found" in tmdb)) {
            const enriched = {
              ...result,
              info: {
                ...result.info,
                cover:         tmdb.poster   ?? result.info.cover,
                backdrop_path: tmdb.backdrop ? [tmdb.backdrop] : (result.info.backdrop_path ?? []),
                plot:          tmdb.overview ?? result.info.plot,
              },
            };
            return h.response(enriched);
          }
          return h.response(result);
        }

        if (action === "get_short_epg" || action === "get_simple_data_table") {
          const { stream_id, limit = "4" } = request.query as Record<string, string>;
          if (!stream_id) return h.response({ epg_listings: [] });

          const epgCache = await getEpgCache();
          const programs: any[] = epgCache?.data?.[stream_id] || [];
          const now = Math.floor(Date.now() / 1000);
          const upcoming = programs
            .filter((p) => Number(p.stop_timestamp) > now)
            .slice(0, Number(limit));

          const listings = upcoming.map((p, i) => {
            const start = Number(p.start_timestamp);
            const stop  = Number(p.stop_timestamp);
            const dur   = stop - start;
            const h2    = String(Math.floor(dur / 3600)).padStart(2, "0");
            const m2    = String(Math.floor((dur % 3600) / 60)).padStart(2, "0");
            const s2    = String(dur % 60).padStart(2, "0");
            return {
              id:                  String(i + 1),
              epg_id:              stream_id,
              title:               Buffer.from(p.name || "").toString("base64"),
              lang:                "",
              start:               new Date(start * 1000).toISOString().replace("T", " ").slice(0, 19),
              end:                 new Date(stop  * 1000).toISOString().replace("T", " ").slice(0, 19),
              description:         Buffer.from("").toString("base64"),
              channel_id:          stream_id,
              start_timestamp:     start,
              stop_timestamp:      stop,
              now_playing:         (start <= now && stop > now) ? 1 : 0,
              has_archive:         0,
              duration_in_seconds: dur,
              duration:            `${h2}:${m2}:${s2}`,
              thumbnail:           "",
            };
          });

          return h.response({ epg_listings: listings });
        }

        return h.response([]);

      } catch (err: any) {
        logger.error(`[player_api] action=${action} error: ${err.message}`);
        return h.response({ error: err.message }).code(500);
      }
    },
  },

  // ── VOD stream ─────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/movie/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { streamId } = request.params;
      try {
        const provider = serverManager.getProvider();

        // Querying by movie_id returns media-file items with direct CDN URLs
        // (video_id = streamId, id = portal media file id, url/cmd = CDN URL)
        const data = await provider.getMovies({ category: "*", page: 1, movieId: parseInt(streamId) });
        const items: any[] = data?.js?.data || [];

        // Pick highest-quality item that has a direct HTTP URL
        const playable = items
          .filter((m: any) => {
            const u = m.url || m.cmd;
            return u && String(u).startsWith("http");
          })
          .sort((a: any, b: any) => parseInt(b.quality || 0) - parseInt(a.quality || 0));

        const item = playable[0];
        if (!item) {
          logger.error(`[VOD stream] ${streamId} no playable item found`);
          return h.response({ error: "Stream not found" }).code(404);
        }

        // Use create_link with portal item id — same as browser stalker flow
        const link = await provider.getMovieLink({ series: "0", id: parseInt(String(item.id)), download: 0 });
        let url: string = link?.js?.cmd || (item.cmd || item.url) || "";
        if (url.startsWith("ffrt ")) url = url.slice(5);
        logger.info(`[VOD stream] ${streamId} portal_id=${item.id} → ${url}`);
        const b64 = Buffer.from(url).toString("base64");
        return h.redirect(`/api/proxy?url=${b64}`).code(302);
      } catch (err: any) {
        logger.error(`[VOD stream] ${err.message}`);
        return h.response({ error: err.message }).code(500);
      }
    },
  },

  // ── Series stream ──────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/series/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { streamId } = request.params;
      try {
        const provider = serverManager.getProvider();
        let url: string | undefined;

        // Mirror browser: getMovies(movieId, seasonId, episodeId) → getMovieLink(series_number, id)
        const epInfo = await xtreamCache.get<{ movieId: number; seasonId: number; seriesNum: number }>(`ep_info_${streamId}`);
        if (epInfo) {
          const epData = await provider.getMovies({
            category: "*",
            page:     1,
            movieId:  epInfo.movieId,
            seasonId: epInfo.seasonId,
            episodeId: parseInt(streamId),
          });
          const epItem = (epData?.js?.data || []).find((e: any) => String(e.id) === streamId)
            || epData?.js?.data?.[0];
          if (epItem) {
            const seriesNum = epItem.series_number ?? epInfo.seriesNum;
            const link = await provider.getMovieLink({
              series:   String(seriesNum),
              id:       parseInt(String(epItem.id)),
              download: 0,
            });
            url = link?.js?.cmd;
            if (url?.startsWith("ffrt ")) url = url.slice(5);
            logger.info(`[Series stream] ep ${streamId} (s=${seriesNum}) → ${url || "EMPTY"}`);
          }
        }

        // Fallback: getMovieLink with cached series number
        if (!url) {
          const epCache = await xtreamCache.get<{ cmd: string; series_num: number }>(`ep_cmd_${streamId}`);
          const seriesNum = epInfo?.seriesNum ?? epCache?.series_num ?? 0;
          if (epCache?.cmd) {
            const raw = epCache.cmd.startsWith("ffrt ") ? epCache.cmd.slice(5) : epCache.cmd;
            const resolved = await provider.getVodLinkByCmd(raw, seriesNum);
            url = resolved?.js?.cmd;
            if (url?.startsWith("ffrt ")) url = url.slice(5);
          }
          if (!url) {
            const link = await provider.getMovieLink({ series: String(seriesNum), id: parseInt(streamId), download: 0 });
            url = link?.js?.cmd;
            if (url?.startsWith("ffrt ")) url = url.slice(5);
            logger.info(`[Series stream] ep ${streamId} fallback getMovieLink(series=${seriesNum}) → ${url || "EMPTY"}`);
          }
        }

        if (!url) return h.response({ error: "Episode not found" }).code(404);
        logger.info(`[Series stream] ep ${streamId} → ${url}`);
        const b64 = Buffer.from(url).toString("base64");
        return h.redirect(`/api/proxy?url=${b64}`).code(302);
      } catch (err: any) {
        logger.error(`[Series stream] ${err.message}`);
        return h.response({ error: err.message }).code(500);
      }
    },
  },

  // ── Live stream .m3u8 ──────────────────────────────────────────────────────
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
      let channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        const { Op } = await import("sequelize");
        channel = await Channel.findOne({ where: { id: { [Op.like]: `%_${streamId}` } } });
      }
      if (!channel) {
        logger.error(`[Live] Channel not found for streamId=${streamId}`);
        return h.response("Channel not found").code(404);
      }

      const useProxy = initialConfig.proxy && proxyParam !== "0";

      if (useProxy) {
        const result = await liveStreamService.getPlaylist(channel.cmd, undefined);
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
          return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Non-proxy error: ${message}`);
          return h.response({ error: "Stream fetch failed" }).code(500);
        }
      }
    },
  },

  // ── Live stream .ts ────────────────────────────────────────────────────────
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
      let channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        const { Op } = await import("sequelize");
        channel = await Channel.findOne({ where: { id: { [Op.like]: `%_${streamId}` } } });
      }
      if (!channel) return h.response("Channel not found").code(404);

      const useProxy = initialConfig.proxy && proxyParam !== "0";

      if (useProxy) {
        try {
          return await handleProxyStream(request, h, channel.cmd);
        } catch (err: any) {
          logger.error(`Error proxying live TS stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      }

      // Non-proxy path: get the real CDN URL from the provider and redirect
      try {
        const redirectedUrl = await serverManager
          .getProvider()
          .getChannelLink(channel.cmd)
          .then((res) => res.js.cmd);
        if (redirectedUrl) {
          return h.redirect(redirectedUrl).code(302);
        }
        return h.response({ error: "Unable to fetch stream" }).code(400);
      } catch (err: any) {
        logger.error(`[Xtream Live .ts] ${streamId} non-proxy error: ${err.message}`);
        return h.response({ error: "Stream fetch failed" }).code(500);
      }
    },
  },
  // ── Live stream (no prefix, no extension) — some TV players use this format ─
  {
    method: "GET",
    path: "/{username}/{password}/{streamId}",
    handler: async (request, h) => {
      const { streamId, username, password } = request.params;
      return h.redirect(`/live/${username}/${password}/${streamId}.ts`).code(302);
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
