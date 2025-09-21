import {
  ServerRoute,
} from "@hapi/hapi";
import { readJSON, writeJSON } from "@/utils/storage";
import { initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";

export const stalkerV2: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      const slug: string = request.params.slug;
      return h.redirect(
        `http://${initialConfig.hostname}:${initialConfig.port}/${slug}`
      );
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-groups",
    handler: async (request, h) => {
      const category = await stalkerApi.getChannelGroups();
      console.log(category);

      const filteredCategory = category.js.filter(
        (group) => group.censored != 1
      );
      writeJSON("channel-groups.json", filteredCategory);
      return filteredCategory;
    },
  },
  {
    method: "GET",
    path: "/api/v2/groups",
    handler: async (request, h) => {
      const groups = readJSON("channel-groups.json");
      if (groups.length === 0) {
        return h.redirect("/api/v2/refresh-groups");
      }
      return groups;
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-channels",
    handler: async (request, h) => {
      const channels = await stalkerApi.getChannels();
      const filteredChannels = channels.js.data.filter(
        (channel) => String(channel.censored) !== "1"
      );
      writeJSON("channels.json", filteredChannels);
      return filteredChannels;
    },
  },
  {
    method: "GET",
    path: "/api/v2/channels",
    handler: async (request, h) => {
      const channels = readJSON("channels.json");
      if (channels.length === 0) {
        return h.redirect("/api/v2/refresh-channels");
      }
      return channels;
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-movie-groups",
    handler: async (request, h) => {
      const groups = await stalkerApi.getMoviesGroups();
      const filteredChannels = groups.js.filter(
        (channel) => channel.censored != 1
      );
      writeJSON("movie-groups.json", filteredChannels);
      return filteredChannels;
    },
  },
  {
    method: "GET",
    path: "/api/v2/movie-groups",
    handler: async (request, h) => {
      const channels = readJSON("movie-groups.json");
      if (channels.length === 0) {
        return h.redirect("/api/v2/refresh-movie-groups");
      }
      return {
        page: Number(1),
        pageAtaTime: Number(1),
        total_items: channels.length,
        actual_length: channels.length,
        total_loaded: channels.length,
        data: channels,
        errors: false,
        isPortal: initialConfig.contextPath == "",
      }

    },
  },
  {
    method: "GET",
    path: "/api/v2/reset-movies",
    handler: async (request, h) => {
      const groups = await stalkerApi.getMoviesGroups();
      console.log(groups);

      const filteredChannels = groups.js.filter(
        (channel) => channel.censored != 1
      );
      writeJSON("movies.json", []);
      return filteredChannels;
    },
  },
  //   {
  //     method: "GET",
  //     path: "/api/v2/movies",
  //     handler: async (request, h) => {
  //       const {
  //         category = 0,
  //         movieId = 0,
  //         seasonId = 0,
  //         episodeId = 0,

  //       } = h.request.query;
  //       if(category ==0){
  //         return h.redirect('/api/v2/movie-groups')
  //       }

  //       const firstPage = await stalkerApi.getMovies({
  //         category,
  //         page: 1,
  //         movieId,
  //         seasonId,
  //         episodeId,
  //       });
  //       const totalItems = firstPage?.js?.total_items ?? 0;
  //       const pageSize = firstPage?.js?.data?.length ?? 0;
  //       const totalPages = Math.ceil(totalItems / pageSize);
  //       const allMovies = [...(firstPage?.js?.data || [])];

  //       if (totalPages > 1) {
  //         const pageRequests = [];
  //         for (let page = 2; page <= totalPages; page++) {
  //           pageRequests.push(stalkerApi.getMovies({ category, page }));
  //         }
  //         const responses = await Promise.all(pageRequests);
  //         for (const res of responses) {
  //           allMovies.push(...(res?.js?.data || []));
  //         }
  //       }

  //       return { total_items: allMovies.length, data: allMovies };
  //     },
  //   },
  {
    method: "GET",
    path: "/api/v2/movies",
    handler: async (request, h) => {
      const {
        category = 0,
        movieId = 0,
        seasonId = 0,
        episodeId = 0,
        page = 1,
        pageAtaTime = 8, // number of API pages to group
        search = "",
        token,
      } = request.query;

      if (category == 0) {
        return h.redirect("/api/v2/movie-groups");
      }

      const itemsPerApiPage = 14;
      const pagesToFetchAtOnce = Number(pageAtaTime);
      const startApiPage = (Number(page) - 1) * pagesToFetchAtOnce + 1;

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
          .response({ message: `Failed to fetch page ${pagesToFetch.at(0)}` })
          .code(500);
      }

      // Safeguard if firstResult.data is undefined or not an array
      const firstPageData = Array.isArray(firstResult.data)
        ? firstResult.data
        : [];

      // Fetch all pages in parallel
      // const results = await Promise.all(pagesToFetch.slice(1).map(fetchPage));
      // const erroredPages = results.filter(({ error }) => error);
      // console.log(erroredPages);

      // if (erroredPages.length > 0) {
      //   return h
      //     .response({
      //       message: `Failed to fetch page ${erroredPages
      //         .map((v) => v.page)
      //         .join(", ")}`,
      //     })
      //     .code(500);
      // }

      // Flatten all data
      const collectedMovies = [
        ...firstPageData,
        // ...results.flatMap((res) => (Array.isArray(res?.data) ? res.data : [])),
      ];

      // Use total_items from first successful result (fallback to 0)
      const actualTotalItems = firstResult.total_items ?? 0;

      return {
        page: Number(page),
        pageAtaTime: Number(pageAtaTime),
        total_items: actualTotalItems,
        actual_length: itemsPerApiPage * pageAtaTime,
        total_loaded: collectedMovies.length,
        data: collectedMovies,
        errors: false,
        isPortal: initialConfig.contextPath == "",
      };
    },
  },
  {
    method: "GET",
    path: "/api/v2/series",
    handler: async (request, h) => {
      const {
        category = 0,
        movieId = 0,
        seasonId = 0,
        episodeId = 0,
        page = 1,
        pageAtaTime = 8, // number of API pages to group
        search = "",
        token,
        ...others
      } = request.query;

      if (category == 0) {
        return h.redirect("/api/v2/series-groups");
      }

      const itemsPerApiPage = 14;
      const pagesToFetchAtOnce = Number(pageAtaTime);
      const startApiPage = (Number(page) - 1) * pagesToFetchAtOnce + 1;

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
          .response({ message: `Failed to fetch page ${pagesToFetch.at(0)}` })
          .code(500);
      }

      // Safeguard if firstResult.data is undefined or not an array
      const firstPageData = Array.isArray(firstResult.data)
        ? firstResult.data
        : [];

      // Fetch all pages in parallel
      // const results = await Promise.all(pagesToFetch.slice(1).map(fetchPage));
      // const erroredPages = results.filter(({ error }) => error);
      // console.log(erroredPages);

      // if (erroredPages.length > 0) {
      //   return h
      //     .response({
      //       message: `Failed to fetch page ${erroredPages
      //         .map((v) => v.page)
      //         .join(", ")}`,
      //     })
      //     .code(500);
      // }

      // Flatten all data
      const collectedMovies = [
        ...firstPageData,
        // ...results.flatMap((res) => (Array.isArray(res?.data) ? res.data : [])),
      ];

      // Use total_items from first successful result (fallback to 0)
      const actualTotalItems = firstResult.total_items ?? 0;

      return {
        page: Number(page),
        pageAtaTime: Number(pageAtaTime),
        total_items: actualTotalItems,
        actual_length: itemsPerApiPage * pageAtaTime,
        total_loaded: collectedMovies.length,
        data: collectedMovies,
        errors: false,
        isPortal: initialConfig.contextPath == "",
      };
    },
  },
  {
    method: "GET",
    path: "/api/v2/movie-link",
    handler: async (request, h) => {
      try {
        const { series = "", id = "", download = 0, token } = request.query;
        return await stalkerApi.getMovieLink({ series, id, download });
      } catch (err) {
        console.error(err);
        throw err;
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-series-groups",
    handler: async (request, h) => {
      const groups = await stalkerApi.getSeriesGroups();
      const filteredChannels = groups.js.filter(
        (channel) => channel.censored != 1
      );
      writeJSON("series-groups.json", filteredChannels);
      return filteredChannels;
    },
  },

  {
    method: "GET",
    path: "/api/v2/series-groups",
    handler: async (request, h) => {
      const channels = readJSON("series-groups.json");
      if (channels.length === 0) {
        return h.redirect("/api/v2/refresh-series-groups");
      }
      return channels;
    },
  },
  {
    method: "GET",
    path: "/api/v2/channel-link",
    handler: async (request, h) => {
      return stalkerApi.getChannelLink(request.query.cmd as any);
    },
  },
];
