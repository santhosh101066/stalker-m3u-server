import { ServerRoute } from "@hapi/hapi";
import {
  writeJSON,
  readChannels,
  writeChannels,
  readGenres,
  writeGenres,
} from "@/utils/storage";
import { initialConfig } from "@/config/server";
import { serverManager } from "@/serverManager";
import { Genre, Channel, EPG_List } from "@/types/types";
import { getEpgCache, fetchAndCacheEpg } from "@/utils/epg";
import { ConfigProfile } from "@/models/ConfigProfile";
import { stalkerApi } from "@/utils/stalker";
import { Readable } from "stream";
import { XtreamCache } from "@/models/XtreamCache";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, catchupScan, xtreamCache } from "@/routes/xtream";
import { logger } from "@/utils/logger";

const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id;
};

export const stalkerV2: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      try {
        const { slug } = request.params;
        const targetUrl = `http://${initialConfig.hostname}:${initialConfig.port}/${slug}`;

        const response = await fetch(targetUrl);

        if (!response.ok || !response.body) {
          return h
            .response({ success: false, message: "Image not found" })
            .code(404);
        }

        const contentType =
          response.headers.get("content-type") || "image/jpeg";

        const nodeStream = Readable.fromWeb(response.body as any);

        return h
          .response(nodeStream)
          .type(contentType)
          .header("cache-control", "max-age=3600");
      } catch (err) {
        console.error("Piping error:", err);
        return h
          .response({ success: false, error: "An unexpected error occurred." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const category = await serverManager.getProvider().getChannelGroups();
        const filteredCategory = category.js.filter(
          (group) => initialConfig.playCensored || group.censored != 1,
        );
        await writeGenres(filteredCategory, "channel", profileId);
        return filteredCategory;
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to refresh groups." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const { all } = request.query as { all?: string };
        const groups = await readGenres("channel", profileId);

        if (groups.length === 0) {
          return h.redirect("/api/v2/refresh-groups");
        }

        if (all === "true") {
          return groups;
        }

        const filteredGroups = groups.filter(
          (group) =>
            initialConfig.groups.length === 0 ||
            initialConfig.groups.includes(group.title),
        );
        return filteredGroups;
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve groups." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-channels",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await serverManager.getProvider().getChannels();
        const filteredChannels = channels.js.data.filter(
          (channel) =>
            initialConfig.playCensored || String(channel.censored) !== "1",
        );
        await writeChannels(filteredChannels, profileId);
        const genres = await readGenres("channel", profileId);
        return (filteredChannels ?? []).filter((channel) => {
          const genre = genres.find((r) => r.id === channel.tv_genre_id);
          return (
            genre &&
            (initialConfig.groups.length === 0 ||
              initialConfig.groups.includes(genre.title))
          );
        });
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to refresh channels." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/channels",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readChannels(profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-channels");
        }
        const genres = await readGenres("channel", profileId);
        return (channels ?? [])
          .filter((channel) => {
            const genre = genres.find((r) => r.id === channel.tv_genre_id);
            return (
              genre &&
              (initialConfig.groups.length === 0 ||
                initialConfig.groups.includes(genre.title))
            );
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve channels." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-movie-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const groups = await serverManager.getProvider().getMoviesGroups();
        const allCats = (Array.isArray(groups.js) ? groups.js : []).filter(
          (ch: any) => initialConfig.playCensored || ch.censored != 1,
        );

        const movieCats: any[] = [];
        for (const cat of allCats) {
          if (cat.id === "*") { movieCats.push(cat); continue; }
          try {
            const res = await serverManager.getProvider().getMovies({ category: cat.id, page: 1 });
            const items = Array.isArray(res?.js?.data) ? res.js.data : [];
            if (items.some((item: any) => item.is_series != 1)) movieCats.push(cat);
          } catch { /* skip on 429 or error */ }
        }

        await writeGenres(movieCats, "movie", profileId);
        await xtreamCache.delete("vod_cats");
        warmVodCache().catch((e) => console.error("[warm-xtream-vod]", e));
        return movieCats;
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to refresh movie groups.",
          })
          .code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/movie-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readGenres("movie", profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-movie-groups");
        }
        return {
          success: true,

          page: Number(1),
          pageAtaTime: Number(1),
          total_items: channels.length,
          actual_length: channels.length,
          total_loaded: channels.length,
          data: channels.sort((a, b) => a.title.localeCompare(b.title)),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to retrieve movie groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/movies",
    handler: async (request, h) => {
      try {
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
          token,
          sort,
        } = request.query;

        if (category == 0) {
          return h.redirect("/api/v2/movie-groups");
        }

        const itemsPerApiPage = 14;
        const pagesToFetchAtOnce = 1;
        const startApiPage = Number(page);
        const fetchPage = async (pageNum: number) => {
          try {
            let sortParam = "added";
            if (sort === "alphabetic") sortParam = "name";

            const res = await serverManager.getProvider().getMovies({
              category,
              page: pageNum,
              movieId,
              seasonId,
              episodeId,
              search,
              token,
              sort: sortParam,
            });

            return { page: pageNum, ...res.js };
          } catch (err) {
            console.error(`Failed to fetch page ${pageNum}: ${err}`);
            return {
              page: pageNum,
              data: [],
              total_items: 0,
              error: true,
              isPortal: initialConfig.contextPath == "",
            };
          }
        };

        const pagesToFetch = Array.from(
          { length: pagesToFetchAtOnce },
          (_, i) => startApiPage + i,
        );
        const firstResult = await fetchPage(pagesToFetch.at(0) ?? 0);

        if (firstResult.error) {
          return h
            .response({
              success: false,
              message: `Failed to fetch page ${pagesToFetch.at(0)}`,
            })
            .code(500);
        }

        const rawData = Array.isArray(firstResult.data) ? firstResult.data : [];

        // At the top level (no movieId), exclude series items so only movies show here
        const firstPageData = Number(movieId) === 0
          ? rawData.filter((item: any) => item.is_series != 1)
          : rawData;

        // For episode-level requests the cmd in get_ordered_list is a stale,
        // IP-restricted CDN URL. Call create_link to get a fresh token.
        if (Number(episodeId) > 0) {
          for (const item of firstPageData as any[]) {
            try {
              const link = await serverManager.getProvider().getMovieLink({
                series: item.series_number ?? "0",
                id: item.id,
                download: 0,
              });
              const freshCmd = link?.js?.cmd;
              if (freshCmd && typeof freshCmd === "string") {
                item.cmd = freshCmd.startsWith("ffrt ") ? freshCmd.slice(5) : freshCmd;
              }
            } catch (err) {
              console.error(`[episode link] failed for id=${item.id}: ${err}`);
            }
          }
        }

        const actualTotalItems = firstResult.total_items ?? 0;
        return {
          success: true,
          page: Number(page),
          pageAtaTime: 1,
          total_items: actualTotalItems,
          actual_length: itemsPerApiPage,
          total_loaded: firstPageData.length,
          data: firstPageData,
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve movies." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/series",
    handler: async (request, h) => {
      try {
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
          token,
          sort,
          ...others
        } = request.query;

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/series-groups");
        }

        const itemsPerApiPage = 14;
        const pagesToFetchAtOnce = 1;
        const startApiPage = Number(page);

        const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
        const isNativeSeries = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;

        const fetchPage = async (pageNum: number) => {
          try {
            let sortParam = "added";
            if (sort === "alphabetic") sortParam = "name";

            const res = isNativeSeries
              ? await serverManager.getProvider().getSeries({ category, page: pageNum, movieId, seasonId, episodeId, search, sort: sortParam })
              : await serverManager.getProvider().getMovies({ category, page: pageNum, movieId, seasonId, episodeId, search, sort: sortParam });
            return { page: pageNum, ...res.js };
          } catch (err) {
            console.error(`Failed to fetch page ${pageNum}: ${err}`);
            return {
              page: pageNum,
              data: [],
              total_items: 0,
              error: true,
              isPortal: initialConfig.contextPath == "",
            };
          }
        };

        const pagesToFetch = Array.from(
          { length: pagesToFetchAtOnce },
          (_, i) => startApiPage + i,
        );
        const firstResult = await fetchPage(pagesToFetch.at(0) ?? 0);

        if (firstResult.error) {
          return h
            .response({
              success: false,
              message: `Failed to fetch page ${pagesToFetch.at(0)}`,
            })
            .code(500);
        }

        const rawData = Array.isArray(firstResult.data) ? firstResult.data : [];
        // Native portals return only series items; VOD-mixed portals need is_series filter
        const firstPageData = Number(movieId) === 0
          ? (isNativeSeries ? rawData : rawData.filter((item: any) => item.is_series == 1))
          : rawData;

        const portalTotal = firstResult.total_items ?? 0;
        // For native portals ratio is always 1; for VOD-mixed scale by series density
        const ratio = isNativeSeries ? 1 : (rawData.length > 0 ? firstPageData.length / rawData.length : 1);
        const actualTotalItems = Number(movieId) === 0
          ? Math.ceil(portalTotal * ratio)
          : portalTotal;

        return {
          success: true,
          page: Number(page),
          pageAtaTime: 1,
          total_items: actualTotalItems,
          actual_length: itemsPerApiPage,
          total_loaded: firstPageData.length,
          data: firstPageData,
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve series." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/movie-link",
    handler: async (request, h) => {
      try {
        const { series = "", id = "", download = 0, category="0", token } = request.query;
        const movieLink = await serverManager.getProvider().getMovieLink({
          series,
          id,
          download,
	  category,
        });
        return movieLink;
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve movie link." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/epg",
    handler: async (request, h) => {
      const { id } = request.query as { id?: string };
      if (!id) return h.response({ error: "id required" }).code(400);
      try {
        const epg = await serverManager.getProvider().getEPG(id);
        return h.response({ channelId: id, count: epg?.js?.length ?? 0, programs: epg?.js?.slice(0, 3) });
      } catch (err: any) {
        return h.response({ error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/vod-item",
    handler: async (request, h) => {
      try {
        const { id } = request.query as { id?: string };
        if (!id) return h.response({ error: "id required" }).code(400);
        const data = await serverManager.getProvider().getMovies({ category: "*", page: 1, movieId: parseInt(id) });
        return h.response({ raw: data?.js?.data || [] });
      } catch (err: any) {
        return h.response({ error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/episode-fetch",
    handler: async (request, h) => {
      const { seriesId, seasonId, category = "*" } = request.query as { seriesId?: string; seasonId?: string; category?: string };
      if (!seriesId || !seasonId) return h.response({ error: "seriesId and seasonId required" }).code(400);
      const provider = serverManager.getProvider();
      const results: any = {};

      const summarise = (r: any) => ({
        jsKeys: Object.keys(r?.js || {}),
        total_items: r?.js?.total_items,
        data_length: r?.js?.data?.length ?? 0,
        first_item: r?.js?.data?.[0] ?? null,
        raw_js: r?.js,
      });

      try {
        results.A_vod_movie_series_season = summarise(
          await provider.getMovies({ category, page: 1, movieId: parseInt(seriesId), seasonId: parseInt(seasonId) })
        );
      } catch (e: any) { results.A_vod_movie_series_season = { error: e.message }; }

      try {
        results.B_vod_movie_season_only = summarise(
          await provider.getMovies({ category, page: 1, movieId: parseInt(seasonId) })
        );
      } catch (e: any) { results.B_vod_movie_season_only = { error: e.message }; }

      try {
        results.C_series_movie_series_season = summarise(
          await provider.getSeries({ category, page: 1, movieId: parseInt(seriesId), seasonId: parseInt(seasonId) })
        );
      } catch (e: any) { results.C_series_movie_series_season = { error: e.message }; }

      try {
        results.D_series_movie_season_only = summarise(
          await provider.getSeries({ category, page: 1, movieId: parseInt(seasonId) })
        );
      } catch (e: any) { results.D_series_movie_season_only = { error: e.message }; }

      return h.response(results);
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();

        // Try native series API first (Type 2 portal)
        const nativeGroups = await serverManager.getProvider().getSeriesGroups();
        const nativeCats = (Array.isArray(nativeGroups?.js) ? nativeGroups.js : []).filter(
          (ch: any) => initialConfig.playCensored || ch.censored != 1,
        );

        if (nativeCats.length > 0) {
          await writeGenres(nativeCats, "series", profileId);
          await XtreamCache.upsert({ key: "portal_series_source", value: JSON.stringify("native"), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
          await xtreamCache.delete("series_cats");
          warmSeriesCache().catch((e) => console.error("[warm-xtream-series]", e));
          return nativeCats;
        }

        // Fall back to VOD-peek (Type 1 portal — series mixed into VOD with is_series flag)
        const groups = await serverManager.getProvider().getMoviesGroups();
        const allCats = (Array.isArray(groups.js) ? groups.js : []).filter(
          (ch: any) => initialConfig.playCensored || ch.censored != 1,
        );

        const seriesCats: any[] = [];
        for (const cat of allCats) {
          if (cat.id === "*") { seriesCats.push(cat); continue; }
          try {
            const res = await serverManager.getProvider().getMovies({ category: cat.id, page: 1 });
            const items = Array.isArray(res?.js?.data) ? res.js.data : [];
            if (items.some((item: any) => item.is_series == 1)) seriesCats.push(cat);
          } catch { /* skip on 429 or error */ }
        }

        await writeGenres(seriesCats, "series", profileId);
        await XtreamCache.upsert({ key: "portal_series_source", value: JSON.stringify("vod"), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
        await xtreamCache.delete("series_cats");
        warmSeriesCache().catch((e) => console.error("[warm-xtream-series]", e));
        return seriesCats;
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to refresh series groups.",
          })
          .code(500);
      }
    },
  },


  {
    method: "POST",
    path: "/api/v2/catchup-scan",
    handler: async (_request, h) => {
      catchupScan().catch((e) => console.error("[catchup-scan]", e));
      return h.response({ success: true, message: "Catch-up scan started in background." });
    },
  },

  {
    method: "GET",
    path: "/api/v2/series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readGenres("series", profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-series-groups");
        }
        return {
          success: true,
          page: Number(1),
          pageAtaTime: Number(1),
          total_items: channels.length,
          actual_length: channels.length,
          total_loaded: channels.length,

          data: channels.sort((a, b) => (a.number || 0) - (b.number || 0)),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to retrieve series groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/channel-link",
    handler: async (request, h) => {
      try {
        const channelLink = await serverManager
          .getProvider()
          .getChannelLink(request.query.cmd as any);
        return channelLink;
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to retrieve channel link.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/epg",
    handler: async (request, h) => {
      try {
        const cache = await getEpgCache();
        if (cache) {
          return cache;
        }

        return [];
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve EPG." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/refresh-epg",
    handler: async (_request, h) => {
      fetchAndCacheEpg().catch((e) => logger.error(`[refresh-epg] ${e}`));
      return h.response({ success: true, message: "EPG refresh started in background." });
    },
  },
  {
    method: "GET",
    path: "/api/v2/expiry",
    handler: async (request, h) => {
      try {
        const expiry = await serverManager.getProvider().getExpiry();
        return { success: true, expiry };
      } catch (err) {
        console.error(err);
        return h
          .response({
            success: false,
            error: "Failed to retrieve expiry date.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/get-token",
    handler: async (request, h) => {
      try {
        const tokenResponse = await stalkerApi.fetchNewToken();
        if (tokenResponse && tokenResponse.token) {
          stalkerApi.addToken(tokenResponse.token);

          const activeProfile = await ConfigProfile.findOne({
            where: { isActive: true },
          });
          if (activeProfile) {
            activeProfile.config.tokens = initialConfig.tokens;
            activeProfile.changed("config", true);
            await activeProfile.save();
          }

          return { success: true, token: tokenResponse.token };
        }
        return h
          .response({ success: false, error: "Failed to fetch token" })
          .code(500);
      } catch (err) {
        console.error("Error fetching new token:", err);
        return h
          .response({ success: false, error: "Failed to fetch new token." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/clear-tokens",
    handler: async (request, h) => {
      try {
        initialConfig.tokens = [];

        const activeProfile = await ConfigProfile.findOne({
          where: { isActive: true },
        });
        if (activeProfile) {
          activeProfile.config.tokens = [];
          activeProfile.changed("config", true);
          await activeProfile.save();
        }

        return { success: true, message: "All tokens cleared." };
      } catch (err) {
        console.error("Error clearing tokens:", err);
        return h
          .response({ success: false, error: "Failed to clear tokens." })
          .code(500);
      }
    },
  },

  {
    method: "POST",
    path: "/api/v2/warm-xtream-vod",
    handler: async (_request, h) => {
      warmVodCache().catch((e) => console.error("[warm-xtream-vod]", e));
      return { success: true, message: "VOD cache warming started in background." };
    },
  },

  {
    method: "POST",
    path: "/api/v2/warm-xtream-series",
    handler: async (_request, h) => {
      warmSeriesCache().catch((e) => console.error("[warm-xtream-series]", e));
      warmSeriesInfoCache().catch((e) => console.error("[warm-xtream-series-info]", e));
      return { success: true, message: "Series cache warming started in background." };
    },
  },

  {
    method: "DELETE",
    path: "/api/v2/clear-xtream-cache",
    handler: async (request, h) => {
      try {
        const count = await XtreamCache.destroy({ where: {} });
        return { success: true, message: `Cleared ${count} xtream cache entries.` };
      } catch (err) {
        console.error("Error clearing xtream cache:", err);
        return h
          .response({ success: false, error: "Failed to clear xtream cache." })
          .code(500);
      }
    },
  },
];
