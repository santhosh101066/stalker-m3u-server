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
import { ConfigProfile } from "@/models/ConfigProfile"; // Import ConfigProfile

// Helper to get active profile ID
const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  return activeProfile?.id;
};

export const stalkerV2: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      try {
        const slug: string = request.params.slug;
        return h.redirect(
          `http://${initialConfig.hostname}:${initialConfig.port}/${slug}`
        );
      } catch (err) {
        console.error(err);
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
        const profileId = await getActiveProfileId(); // Get ID
        const category = await serverManager.getProvider().getChannelGroups();
        const filteredCategory = category.js.filter(
          (group) => initialConfig.playCensored || group.censored != 1
        );
        await writeGenres(filteredCategory, "channel", profileId); // Write with ID
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
        const profileId = await getActiveProfileId(); // Get ID
        const { all } = request.query as { all?: string };
        const groups = await readGenres("channel", profileId); // Read with ID

        if (groups.length === 0) {
          return h.redirect("/api/v2/refresh-groups");
        }

        // If 'all' is requested (for Admin), return everything
        if (all === "true") {
          return groups;
        }

        // Otherwise (for UI browsing), filter based on the config
        const filteredGroups = groups.filter((group) =>
          initialConfig.groups.length === 0 || initialConfig.groups.includes(group.title)
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
        const profileId = await getActiveProfileId(); // Get ID
        const channels = await serverManager.getProvider().getChannels();
        const filteredChannels = channels.js.data.filter(
          (channel) => initialConfig.playCensored || String(channel.censored) !== "1"
        );
        await writeChannels(filteredChannels, profileId); // Write with ID
        const genres = await readGenres("channel", profileId);
        return (filteredChannels ?? []).filter((channel) => {
          const genre = genres.find((r) => r.id === channel.tv_genre_id);
          return genre && (initialConfig.groups.length === 0 || initialConfig.groups.includes(genre.title));
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
        const profileId = await getActiveProfileId(); // Get ID
        const channels = await readChannels(profileId); // Read with ID
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-channels");
        }
        const genres = await readGenres("channel", profileId);
        return (channels ?? [])
          .filter((channel) => {
            const genre = genres.find((r) => r.id === channel.tv_genre_id);
            return genre && (initialConfig.groups.length === 0 || initialConfig.groups.includes(genre.title));
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
        const profileId = await getActiveProfileId(); // Get ID
        const groups = await serverManager.getProvider().getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1
        );
        await writeGenres(filteredChannels, "movie", profileId); // Write with ID
        return filteredChannels;
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
        const profileId = await getActiveProfileId(); // Get ID
        const channels = await readGenres("movie", profileId); // Read with ID
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
          data: channels,
          errors: false,
          isPortal: initialConfig.providerType === 'stalker',
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
    path: "/api/v2/reset-movies",
    handler: async (request, h) => {
      try {
        // This seems to just fetch from Stalker again without saving?
        // Or if 'writeJSON' was used previously, it should be updated.
        // Assuming this route is for debug/reset.
        const groups = await serverManager.getProvider().getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1
        );
        // writeJSON is deprecated/legacy. If you want to clear DB:
        // await writeGenres([], "movie", await getActiveProfileId());
        return { success: true, data: filteredChannels };
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to reset movies." })
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
            let sortParam = 'added';
            if (sort === 'alphabetic') sortParam = 'name';
            // 'latest' and 'oldest' map to 'added'

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
          (_, i) => startApiPage + i
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

        const firstPageData = Array.isArray(firstResult.data)
          ? firstResult.data
          : [];

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
          isPortal: initialConfig.providerType === 'stalker',
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

        const fetchPage = async (pageNum: number) => {
          try {
            let sortParam = 'added';
            if (sort === 'alphabetic') sortParam = 'name';
            // 'latest' and 'oldest' map to 'added'

            const res = await serverManager.getProvider().getSeries({
              category,
              page: pageNum,
              movieId,
              seasonId,
              episodeId,
              search,
              token,
              sort: sortParam,
              ...others,
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
          (_, i) => startApiPage + i
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

        const firstPageData = Array.isArray(firstResult.data)
          ? firstResult.data
          : [];
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
          isPortal: initialConfig.providerType === 'stalker',
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
        const { series = "", id = "", download = 0, token } = request.query;
        const movieLink = await serverManager.getProvider().getMovieLink({
          series,
          id,
          download,
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
    path: "/api/v2/refresh-series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId(); // Get ID
        const groups = await serverManager.getProvider().getSeriesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1
        );
        await writeGenres(filteredChannels, "series", profileId); // Write with ID
        return filteredChannels;
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
    method: "GET",
    path: "/api/v2/series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId(); // Get ID
        const channels = await readGenres("series", profileId); // Read with ID
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
          // Sort by number if available, otherwise keep original order
          data: channels.sort((a, b) => (a.number || 0) - (b.number || 0)),
          errors: false,
          isPortal: initialConfig.providerType === 'stalker',
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
        const channelLink = await serverManager.getProvider().getChannelLink(
          request.query.cmd as any
        );
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
        const cache = await getEpgCache(); // Now handles profileId internally
        if (cache) {
          return cache;
        }
        // const epgData = await fetchAndCacheEpg(); // Now handles profileId internally
        // return epgData;
        return []
      } catch (err) {
        console.error(err);
        return h
          .response({ success: false, error: "Failed to retrieve EPG." })
          .code(500);
      }
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
          .response({ success: false, error: "Failed to retrieve expiry date." })
          .code(500);
      }
    },
  },
];