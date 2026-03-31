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
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1,
        );
        await writeGenres(filteredChannels, "movie", profileId);
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
    path: "/api/v2/reset-movies",
    handler: async (request, h) => {
      try {
        const groups = await serverManager.getProvider().getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1,
        );

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

        const fetchPage = async (pageNum: number) => {
          try {
            let sortParam = "added";
            if (sort === "alphabetic") sortParam = "name";

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
        const profileId = await getActiveProfileId();
        const groups = await serverManager.getProvider().getSeriesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1,
        );
        await writeGenres(filteredChannels, "series", profileId);
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
];
