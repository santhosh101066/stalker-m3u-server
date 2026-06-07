import { ServerRoute } from "@hapi/hapi";
import { initialConfig } from "@/config/server";
import { serverManager } from "@/serverManager";
import axios from "axios";
import {
  readGenres,
  writeGenres,
  readChannels,
  writeChannels,
} from "@/utils/storage";
import { ConfigProfile } from "@/models/ConfigProfile";
import { ContentCache } from "@/models/ContentCache";
import { stalkerApi } from "@/utils/stalker";
import { Readable } from "stream";
import crypto from "crypto";
import { getEpgCache } from "@/utils/epg";

const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // Exact 4 Hours Configuration Window

const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id;
};

// Generates dynamic deterministic keys for parameters
const generateCacheKey = (type: string, queryParams: any): string => {
  const sortedString = JSON.stringify(
    queryParams,
    Object.keys(queryParams).sort(),
  );
  return `${type}_${crypto.createHash("md5").update(sortedString).digest("hex")}`;
};

const mapChannel = (channel: any) => {
  let cmdUrl = channel.cmd;
  if (initialConfig.providerType === "stalker") {
    cmdUrl = `/live.m3u8?cmd=${encodeURIComponent(channel.cmd)}&id=${channel.id}&proxy=1`;
  }
  return {
    ...channel,
    cmd: cmdUrl,
    screenshot_uri: channel.logo || channel.screenshot_uri || "",
    isPortal: initialConfig.providerType === "stalker",
  };
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
        const mappedChannels = filteredChannels.map(mapChannel);
        const genres = await readGenres("channel", profileId);
        if (genres.length === 0) {
          return mappedChannels ?? [];
        }
        return (mappedChannels ?? []).filter((channel) => {
          const genre = genres.find(
            (r) => r.id === String(channel.tv_genre_id),
          );
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
        const mapped = (channels ?? []).map(mapChannel);
        if (genres.length === 0) {
          return mapped.sort((a, b) => a.name.localeCompare(b.name));
        }
        return mapped
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
        const profileId = (await getActiveProfileId()) || 0;
        const query = request.query as any;
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
        } = query;

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/movie-groups");
        }

        // Generate custom parameter key hash
        const cacheKey = generateCacheKey("movies", query);

        // Skip cache checks if live filter operations are targeted
        if (!search) {
          const cachedRecord = await ContentCache.findOne({
            where: { profileId, cacheKey },
          });

          if (cachedRecord && new Date() < cachedRecord.expiresAt) {
            return cachedRecord.response;
          }
        }

        const itemsPerApiPage = 14;
        let sortParam = query.sort === "alphabetic" ? "name" : "added";

        const res = await serverManager.getProvider().getMovies({
          category,
          page: Number(page),
          movieId,
          seasonId,
          episodeId,
          search,
          token: query.token,
          sort: sortParam,
        });

        if (res && res.js && Array.isArray(res.js.data)) {
          const isSeasonContext = !!seasonId && !episodeId;
          const isSeriesContext = !!movieId && !seasonId && !episodeId;
          res.js.data = res.js.data.map((item: any) => {
            const isEpisode =
              isSeasonContext || !!item.series_number || item.is_episode;
            const isSeason = isSeriesContext && !isEpisode;
            return {
              ...item,
              is_episode: isEpisode ? 1 : item.is_episode,
              ...(isSeason && { is_season: true }),
            };
          });
        }

        let firstPageData =
          res && res.js && Array.isArray(res.js.data) ? res.js.data : [];
        const actualTotalItems =
          (res && res.js && Number(res.js.total_items)) ?? 0;

        const responsePayload = {
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

        // Write payload to DB Cache table if not a volatile search operation
        if (!search && res && res.js) {
          await ContentCache.upsert({
            profileId,
            cacheKey,
            response: responsePayload,
            expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
          });
        }

        return responsePayload;
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
        const profileId = (await getActiveProfileId()) || 0;
        const query = request.query as any;
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
          sort,
          ...others
        } = query;

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/series-groups");
        }

        const cacheKey = generateCacheKey("series", query);

        if (!search) {
          const cachedRecord = await ContentCache.findOne({
            where: { profileId, cacheKey },
          });

          if (cachedRecord && new Date() < cachedRecord.expiresAt) {
            return cachedRecord.response;
          }
        }

        const itemsPerApiPage = 14;
        let sortParam = sort === "alphabetic" ? "name" : "added";

        const res = await serverManager.getProvider().getSeries({
          category,
          page: Number(page),
          movieId,
          seasonId,
          episodeId,
          search,
          token: query.token,
          sort: sortParam,
          ...others,
        });

        if (res && res.js && Array.isArray(res.js.data)) {
          res.js.data = res.js.data.map((item: any) => {
            const isEpisode =
              !!seasonId || !!item.series_number || item.is_episode;
            return {
              ...item,
              is_episode: isEpisode ? 1 : item.is_episode,
            };
          });
        }

        let firstPageData =
          res && res.js && Array.isArray(res.js.data) ? res.js.data : [];
        const actualTotalItems =
          (res && res.js && Number(res.js.total_items)) ?? 0;

        const responsePayload = {
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

        if (!search && res && res.js) {
          await ContentCache.upsert({
            profileId,
            cacheKey,
            response: responsePayload,
            expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
          });
        }

        return responsePayload;
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
        const {
          series = "",
          id = "",
          download = 0,
          token,
          cmd,
        } = request.query;
        const isSeries =
          series && series !== "0" && series !== "false" && series !== "";
        let movieLink: any;
        if (isSeries) {
          movieLink = await serverManager.getProvider().getSeriesLink({
            series: series as string,
            id: Number(id),
            download: Number(download),
            cmd: cmd as string,
          });
        } else {
          movieLink = await serverManager.getProvider().getMovieLink({
            series: series as string,
            id: Number(id),
            download: Number(download),
            cmd: cmd as string,
          });
        }

        if (movieLink && (download == 1 || download === "1")) {
          const rawUrl = movieLink?.js?.cmd || movieLink?.cmd;
          if (
            typeof rawUrl === "string" &&
            (rawUrl.startsWith("/") || rawUrl.includes("get_download_link.php"))
          ) {
            const proxiedDownloadUrl = `/api/v2/download?path=${encodeURIComponent(rawUrl)}`;
            if (movieLink.js) {
              movieLink.js.cmd = proxiedDownloadUrl;
            } else {
              movieLink.cmd = proxiedDownloadUrl;
            }
          }
        }

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
        if (cache) return cache;
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
  {
    method: "GET",
    path: "/api/v2/download",
    handler: async (request, h) => {
      try {
        const { path, id, series, isSeries, cmd } = request.query as {
          path?: string;
          id?: string;
          series?: string;
          isSeries?: string;
          cmd?: string;
        };

        const provider = serverManager.getProvider();

        // If direct resolution parameters are provided
        if (id) {
          if (initialConfig.providerType === "stalker") {
            const stalker = provider as any;
            let token = stalker.cache.get("auth_token");
            if (!token) {
              token = await stalker.getToken(false);
            }

            const isSeriesBool = isSeries === "1" || isSeries === "true";
            
            // Try download mode (download=1)
            let linkData: any;
            if (isSeriesBool) {
              linkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: cmd,
              });
            } else {
              linkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: cmd,
              });
            }

            let resolvedUrl = linkData?.js?.cmd || linkData?.cmd;
            if (resolvedUrl && resolvedUrl.startsWith("/")) {
              resolvedUrl = `${stalker.getBaseUrl()}${resolvedUrl}`;
            }

            // If we got a valid download link, let's request it
            if (resolvedUrl && !resolvedUrl.includes("error=nothing_to_play") && !(linkData?.js?.error === "nothing_to_play")) {
              const config = stalker._getAxiosRequestConfig({}, token || "");
              
              // Validate that get_download_link.php doesn't return 404
              const validateRes = await axios({
                method: "get",
                url: resolvedUrl,
                headers: config.headers,
                params: config.params,
                validateStatus: () => true,
              });

              // If it's valid, request stream proxy
              if (validateRes.status === 200 || validateRes.status === 206) {
                // If it returned nothing_to_play in data, skip to play fallback
                const dataStr = typeof validateRes.data === "string" ? validateRes.data : JSON.stringify(validateRes.data);
                if (!dataStr.includes("nothing_to_play")) {
                  const response = await axios({
                    method: "get",
                    url: resolvedUrl,
                    headers: config.headers,
                    params: config.params,
                    responseType: "stream",
                    validateStatus: () => true,
                  });

                  const proxyResponse = h.response(response.data);
                  const headersToCopy = ["content-type", "content-length", "content-disposition", "accept-ranges", "content-range"];
                  for (const [key, value] of Object.entries(response.headers)) {
                    if (value && headersToCopy.includes(key.toLowerCase())) {
                      proxyResponse.header(key, value.toString());
                    }
                  }
                  proxyResponse.code(response.status);
                  return proxyResponse;
                }
              }
            }

            // Fallback: Try play mode (download=0)
            let playLinkData: any;
            if (isSeriesBool) {
              playLinkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: cmd,
              });
            } else {
              playLinkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: cmd,
              });
            }

            let playUrl = playLinkData?.js?.cmd || playLinkData?.cmd;
            if (playUrl && playUrl.startsWith("/")) {
              playUrl = `${stalker.getBaseUrl()}${playUrl}`;
            }
            if (playUrl) {
              const config = stalker._getAxiosRequestConfig({}, token || "");

              // If playUrl is an m3u8 playlist, serve the playlist file as attachment
              if (playUrl.includes(".m3u8") || playUrl.includes("index.m3u8")) {
                const playRes = await axios({
                  method: "get",
                  url: playUrl,
                  headers: config.headers,
                  responseType: "text",
                });
                
                const filename = `stream_${id}.m3u8`;
                return h.response(playRes.data)
                  .header("Content-Type", "application/x-mpegurl")
                  .header("Content-Disposition", `attachment; filename="${filename}"`)
                  .code(200);
              } else {
                // Otherwise stream the play link direct file
                const response = await axios({
                  method: "get",
                  url: playUrl,
                  headers: config.headers,
                  params: config.params,
                  responseType: "stream",
                  validateStatus: () => true,
                });

                const proxyResponse = h.response(response.data);
                const headersToCopy = ["content-type", "content-length", "content-disposition", "accept-ranges", "content-range"];
                for (const [key, value] of Object.entries(response.headers)) {
                  if (value && headersToCopy.includes(key.toLowerCase())) {
                    proxyResponse.header(key, value.toString());
                  }
                }
                proxyResponse.code(response.status);
                return proxyResponse;
              }
            }
            return h.response({ error: "Failed to resolve stream link for download" }).code(404);
          } else {
            // For Xtream and others
            let playUrl = "";
            if (path && path.startsWith("/")) {
              playUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
            } else if (path) {
              playUrl = path;
            } else if (cmd) {
              playUrl = cmd;
            }
            if (playUrl) {
              const response = await axios({
                method: "get",
                url: playUrl,
                headers: { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" },
                responseType: "stream",
                validateStatus: () => true,
              });

              const proxyResponse = h.response(response.data);
              const headersToCopy = ["content-type", "content-length", "content-disposition", "accept-ranges", "content-range"];
              for (const [key, value] of Object.entries(response.headers)) {
                if (value && headersToCopy.includes(key.toLowerCase())) {
                  proxyResponse.header(key, value.toString());
                }
              }
              proxyResponse.code(response.status);
              return proxyResponse;
            }
            return h.response({ error: "Failed to resolve playUrl" }).code(404);
          }
        }

        // Old path parameter fallback
        if (!path) {
          return h.response({ error: "Missing path or id parameter" }).code(400);
        }

        let targetUrl = path;
        let headers: Record<string, string> = {};
        let params: Record<string, any> = {};

        if (initialConfig.providerType === "stalker") {
          const stalker = provider as any;
          let token = stalker.cache.get("auth_token");
          if (!token) {
            token = await stalker.getToken(false);
          }

          if (path.startsWith("/")) {
            targetUrl = `${stalker.getBaseUrl()}${path}`;
          }

          const config = stalker._getAxiosRequestConfig({}, token || "");
          headers = config.headers;
          params = config.params || {};
        } else {
          if (path.startsWith("/")) {
            targetUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
          }
          headers = {
            "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
          };
        }

        const response = await axios({
          method: "get",
          url: targetUrl,
          headers: headers,
          params: params,
          responseType: "stream",
          validateStatus: () => true,
        });

        const proxyResponse = h.response(response.data);

        const headersToCopy = [
          "content-type",
          "content-length",
          "content-disposition",
          "accept-ranges",
          "content-range",
        ];
        for (const [key, value] of Object.entries(response.headers)) {
          if (value && headersToCopy.includes(key.toLowerCase())) {
            proxyResponse.header(key, value.toString());
          }
        }

        proxyResponse.code(response.status);
        return proxyResponse;
      } catch (error: any) {
        console.error("Download proxy error:", error.message);
        return h.response({ error: "Failed to proxy download" }).code(500);
      }
    },
  },
];
