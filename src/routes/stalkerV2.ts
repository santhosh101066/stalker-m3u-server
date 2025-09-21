import { ServerRoute } from "@hapi/hapi";
import { readJSON, writeJSON } from "@/utils/storage";
import { initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";
import { Genre, Channel } from "@/types/types";

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
        const category = await stalkerApi.getChannelGroups();
        const filteredCategory = category.js.filter(
          (group) => group.censored != 1
        );
        writeJSON("channel-groups.json", filteredCategory);
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
        const groups = readJSON("channel-groups.json");
        if (groups.length === 0) {
          return h.redirect("/api/v2/refresh-groups");
        }
        return groups;
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
        const channels = await stalkerApi.getChannels();
        const filteredChannels = channels.js.data.filter(
          (channel) => String(channel.censored) !== "1"
        );
        writeJSON("channels.json", filteredChannels);
        const genres = readJSON<Genre>("channel-groups.json");
        return (filteredChannels ?? []).filter((channel) => {
          const genre = genres.find((r) => r.id === channel.tv_genre_id);
          return genre && initialConfig.groups.includes(genre.title);
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
        const channels = readJSON<Channel>("channels.json");
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-channels");
        }
        const genres = readJSON<Genre>("channel-groups.json");
        return (channels ?? []).filter((channel) => {
          const genre = genres.find((r) => r.id === channel.tv_genre_id);
          return genre && initialConfig.groups.includes(genre.title);
        });
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
        const groups = await stalkerApi.getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => channel.censored != 1
        );
        writeJSON("movie-groups.json", filteredChannels);
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
        const channels = readJSON("movie-groups.json");
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
          isPortal: initialConfig.contextPath == "",
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
        const groups = await stalkerApi.getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => channel.censored != 1
        );
        writeJSON("movies.json", []);
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
        } = request.query;

        if (category == 0) {
          return h.redirect("/api/v2/movie-groups");
        }

        const itemsPerApiPage = 14;
        const pagesToFetchAtOnce = 1;
        const startApiPage = Number(page);

        const fetchPage = async (pageNum: number) => {
          try {
            const res = await stalkerApi.getMovies({
              category,
              page: pageNum,
              movieId,
              seasonId,
              episodeId,
              search,
              token,
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

        // Build list of API pages to fetch for this proxy page
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

        // Safeguard if firstResult.data is undefined or not an array
        const firstPageData = Array.isArray(firstResult.data)
          ? firstResult.data
          : [];

        // Use total_items from first successful result (fallback to 0)
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
          isPortal: initialConfig.contextPath == "",
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
          ...others
        } = request.query;

        if (category == 0) {
          return h.redirect("/api/v2/series-groups");
        }

        const itemsPerApiPage = 14;
        const pagesToFetchAtOnce = 1;
        const startApiPage = Number(page);

        const fetchPage = async (pageNum: number) => {
          try {
            const res = await stalkerApi.getSeries({
              category,
              page: pageNum,
              movieId,
              seasonId,
              episodeId,
              search,
              token,
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

        // Build list of API pages to fetch for this proxy page
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

        // Safeguard if firstResult.data is undefined or not an array
        const firstPageData = Array.isArray(firstResult.data)
          ? firstResult.data
          : [];

        // Use total_items from first successful result (fallback to 0)
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
          isPortal: initialConfig.contextPath == "",
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
        const movieLink = await stalkerApi.getMovieLink({
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
        const groups = await stalkerApi.getSeriesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => channel.censored != 1
        );
        writeJSON("series-groups.json", filteredChannels);
        return { success: true, data: filteredChannels };
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
        const channels = readJSON("series-groups.json");
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-series-groups");
        }
        return channels;
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
        const channelLink = await stalkerApi.getChannelLink(
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
];
