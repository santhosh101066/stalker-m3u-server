import {
  ArrayData,
  Channel,
  Data,
  EPG_List,
  Genre,
  MoviesApiParams,
  Program,
  Programs,
  Video,
} from "@/types/types";
import { IProvider } from "@/interfaces/Provider";
import axios from "axios";
import { initialConfig } from "@/config/server";
import NodeCache from "node-cache";

function parseDurationToMinutes(durationStr: string | undefined): number {
  if (!durationStr) return 0;
  const parts = durationStr.split(":");
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseInt(parts[2], 10) || 0;
    return hours * 60 + minutes + Math.round(seconds / 60);
  }
  return parseInt(durationStr, 10) || 0;
}

function parseDateTimeToTimestamp(dateTimeStr: string): string {
  if (!dateTimeStr) return "";
  const match = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [_, year, month, day, hour, minute, second] = match;
    const date = new Date(Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(minute, 10),
      parseInt(second, 10)
    ));
    return Math.floor(date.getTime() / 1000).toString();
  }
  return Math.floor(new Date(dateTimeStr).getTime() / 1000).toString();
}

function isBase64(str: string): boolean {
  if (!str || typeof str !== "string") return false;
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64Regex.test(str)) return false;
  if (str.length % 4 !== 0) return false;
  return true;
}

function decodeBase64Safe(str: string): string {
  if (!str) return "";
  try {
    if (isBase64(str)) {
      const decoded = Buffer.from(str, "base64").toString("utf-8");
      const isReadable = /^[\x20-\x7E\s\u00A0-\uFFFD]+$/.test(decoded);
      if (isReadable) {
        return decoded;
      }
    }
  } catch (e) {
    // Ignore error
  }
  return str;
}

export class XtreamClient implements IProvider {
  private baseUrl: string;
  private username: string;
  private password: string;
  private lastRequestTime: number = 0;
  private cache = new NodeCache({ stdTTL: 21600, checkperiod: 60 });
  // Deduplicates concurrent requests for the same upstream key
  private inFlight = new Map<string, Promise<any>>();

  constructor() {
    const protocol = "http";
    this.baseUrl = `${protocol}://${initialConfig.hostname}:${initialConfig.port}`;
    this.username = initialConfig.username || "";
    this.password = initialConfig.password || "";
  }

  private getApiUrl() {
    return `${this.baseUrl}/player_api.php`;
  }

  private getCacheKey(params: Record<string, any>): string {
    return Object.keys(params)
      .sort()
      .map((key) => `${key}:${params[key]}`)
      .join("|");
  }

  private async makeRequest(params: Record<string, any>) {
    this.lastRequestTime = Date.now();
    const cacheKey = this.getCacheKey(params);
    const cachedData = this.cache.get(cacheKey);
    if (cachedData !== undefined) {
      return cachedData;
    }

    // Deduplicate: if an identical request is already in-flight, wait for it
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const request = axios
      .get(this.getApiUrl(), {
        params: {
          username: this.username,
          password: this.password,
          ...params,
        },
        headers: {
          "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
        },
        timeout: 120000, // 120 s — prevents server timeout on massive upstream payloads
      })
      .then((response) => {
        this.cache.set(cacheKey, response.data);
        return response.data;
      })
      .catch((error) => {
        console.error("XtreamClient request failed:", error?.message ?? error);
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, request);
    return request;
  }

  async getToken(refreshToken: boolean): Promise<string | null> {
    const data = await this.makeRequest({});
    if (data.user_info && data.user_info.auth === 1) {
      return "valid";
    }
    return null;
  }

  async getExpiry(): Promise<string | null> {
    const data = await this.makeRequest({});
    if (data.user_info && data.user_info.exp_date) {
      const exp = data.user_info.exp_date;
      if (!isNaN(exp)) {
        return new Date(parseInt(exp) * 1000).toLocaleString();
      }
      return exp;
    }
    return null;
  }

  clearCache(): void {
    this.cache.flushAll();
  }

  async getChannelGroups(): Promise<Data<Genre[]>> {
    const data = await this.makeRequest({ action: "get_live_categories" });
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getChannelGroups expected an array, but got:", typeof data, data);
      return { js: [] };
    }

    const genres: Genre[] = data.map((item: any) => ({
      id: item.category_id,
      title: item.category_name,
      number: 0,
      alias: item.category_name,
      censored: 0,
    }));
    return { js: genres };
  }

  async getChannels(): Promise<Data<Programs<Channel>>> {
    const data = await this.makeRequest({ action: "get_live_streams" });
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getChannels expected an array, but got:", typeof data, data);
      return { js: { total_items: 0, max_page_items: 0, data: [] } };
    }

    const channels: Channel[] = data.map((item: any) => ({
      id: item.stream_id,
      name: item.name,
      cmd: `http://${initialConfig.hostname}:${initialConfig.port}/live/${this.username}/${this.password}/${item.stream_id}.m3u8`,
      number: item.num,
      logo: item.stream_icon,
      tv_genre_id: item.category_id,
      censored: "0",
    }));

    return {
      js: {
        total_items: channels.length,
        max_page_items: channels.length,
        data: channels,
      },
    };
  }

  async getChannelLink(cmd: string): Promise<Data<Program>> {
    return {
      js: {
        id: "0",
        name: "",
        cmd: cmd,
      },
    };
  }

  async getEPG(channelId: string): Promise<ArrayData<EPG_List>> {
    try {
      const data = await this.makeRequest({
        action: "get_short_epg",
        stream_id: channelId,
      });

      let listings: any[] = [];
      if (Array.isArray(data)) {
        listings = data;
      } else if (data && Array.isArray(data.epg_listings)) {
        listings = data.epg_listings;
      }

      const epgList: EPG_List[] = listings.map((item: any) => {
        const title = decodeBase64Safe(item.title || "");
        const startTimestamp = item.start_timestamp || (item.start ? parseDateTimeToTimestamp(item.start) : "");
        const stopTimestamp = item.stop_timestamp || (item.end ? parseDateTimeToTimestamp(item.end) : "");

        return {
          start_timestamp: startTimestamp,
          stop_timestamp: stopTimestamp,
          name: title,
        };
      });

      return { js: epgList };
    } catch (error) {
      console.error(`XtreamClient.getEPG failed for channel ${channelId}:`, error);
      return { js: [] };
    }
  }

  async getMoviesGroups(): Promise<Data<Genre[]>> {
    const data = await this.makeRequest({ action: "get_vod_categories" });
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getMoviesGroups expected an array, but got:", typeof data, data);
      return { js: [] };
    }

    const genres: Genre[] = data.map((item: any) => ({
      id: item.category_id,
      title: item.category_name,
      number: 0,
      alias: item.category_name,
      censored: 0,
    }));
    return { js: genres };
  }

  async getMovies(params: MoviesApiParams): Promise<Data<Programs<Video>>> {
    if (params.movieId && Number(params.movieId) !== 0) {
      try {
        const data = await this.makeRequest({
          action: "get_vod_info",
          vod_id: params.movieId,
        });

        if (data && data.info) {
          const info = data.info;
          const movieData = data.movie_data || {};
          const extension = info.container_extension || movieData.container_extension || "mp4";

          const video: any = {
            id: params.movieId,
            name: info.name || movieData.name || "",
            cmd: `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${params.movieId}.${extension}`,
            screenshot_uri: info.cover_big || info.movie_image || "",
            category_id: info.category_id || "",
            time: info.added ? parseInt(info.added) : 0,
            rating_imdb: info.rating || "0",
            runtime: info.duration_secs
              ? Math.floor(parseInt(info.duration_secs) / 60)
              : info.duration
                ? parseDurationToMinutes(info.duration)
                : 0,
            description: (info.description || info.plot || "").trim() || "No description available",
            director: (info.director || "").trim() || "-",
            actors: (info.actors || info.cast || "").trim() || "-",
            year: (info.releasedate ? info.releasedate.split("-")[0] : "").trim() || "-",
            country: (info.country || "").trim() || "-",
            genres_str: (info.genre || "").trim() || "-",
          };

          return {
            js: {
              total_items: 1,
              max_page_items: 1,
              data: [video],
            },
          };
        }
      } catch (err) {
        console.error("Error fetching get_vod_info for movieId:", params.movieId, err);
      }
      return { js: { total_items: 0, max_page_items: 1, data: [] } };
    }

    const reqParams: any = { action: "get_vod_streams" };
    if (params.category && params.category !== "*" && params.category !== "0") {
      reqParams.category_id = params.category;
    }

    const data = await this.makeRequest(reqParams);
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getMovies expected an array, but got:", typeof data, data);
      return { js: { total_items: 0, max_page_items: 0, data: [] } };
    }

    const videos: Video[] = data.map((item: any) => ({
      id: item.stream_id,
      name: item.name,
      cmd: `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${item.stream_id}.${item.container_extension}`,

      screenshot_uri: item.stream_icon,
      category_id: item.category_id,
      time: item.added ? parseInt(item.added) : 0,
      rating_imdb: item.rating,
      runtime: item.duration_secs
        ? Math.floor(parseInt(item.duration_secs) / 60)
        : 0,
    }));

    let filteredVideos = params.search
      ? videos.filter((v) =>
          v.name.toLowerCase().includes(params.search!.toLowerCase()),
        )
      : videos;

    if (params.sort) {
      const s = params.sort.toLowerCase();
      if (s === "latest" || s === "added") {
        filteredVideos.sort((a, b) => b.time - a.time);
      } else if (s === "oldest") {
        filteredVideos.sort((a, b) => a.time - b.time);
      } else if (s === "alphabetic" || s === "name") {
        filteredVideos.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    const page = params.page ? Number(params.page) : 1;
    const limit = 14; // Items per page
    const startIndex = (page - 1) * limit;
    const paginatedVideos = filteredVideos.slice(startIndex, startIndex + limit);

    return {
      js: {
        total_items: filteredVideos.length,
        max_page_items: limit,
        data: paginatedVideos,
      },
    };
  }

  async getMovieLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any> {
    let extension = "mp4";
    try {
      const data = await this.makeRequest({
        action: "get_vod_info",
        vod_id: params.id,
      });
      if (data) {
        if (data.movie_data && data.movie_data.container_extension) {
          extension = data.movie_data.container_extension;
        } else if (data.info && data.info.container_extension) {
          extension = data.info.container_extension;
        }
      }
    } catch (e) {
      console.error("Error fetching movie container extension:", e);
    }
    const url = `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${params.id}.${extension}`;

    return {
      js: {
        cmd: url,
      },
    };
  }

  async getSeriesGroups(): Promise<Data<Genre[]>> {
    const data = await this.makeRequest({ action: "get_series_categories" });
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getSeriesGroups expected an array, but got:", typeof data, data);
      return { js: [] };
    }

    const genres: Genre[] = data.map((item: any) => ({
      id: item.category_id,
      title: item.category_name,
      number: 0,
      alias: item.category_name,
      censored: 0,
    }));
    return { js: genres };
  }

  async getSeries(params: MoviesApiParams): Promise<Data<Programs<Video>>> {
    if (params.movieId && params.seasonId) {
      const data = await this.makeRequest({
        action: "get_series_info",
        series_id: params.movieId, // Request info using Series ID
      });

      const episodes: Video[] = [];
      const seasonNumStr = params.seasonId.toString();

      // Check if data exists and the requested season exists
      if (data && data.episodes && data.episodes[seasonNumStr]) {
        const seasonEpisodes = data.episodes[seasonNumStr];
        
        if (Array.isArray(seasonEpisodes)) {
          seasonEpisodes.forEach((ep: any) => {
            let duration = 0;
            if (ep.info?.duration_secs) {
              duration = Math.floor(parseInt(ep.info.duration_secs) / 60);
            } else if (ep.info?.duration) {
              duration = parseDurationToMinutes(ep.info.duration);
            }

            episodes.push({
              id: ep.id,
              name: ep.title || `Episode ${ep.episode_num}`,
              cmd: `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${ep.id}.${ep.container_extension || "mp4"}`,
              screenshot_uri: ep.info?.movie_image || data.info?.cover,
              category_id: data.info?.category_id,
              time: duration,
              rating_imdb: data.info?.rating,
              series: [], // Important: Empty for episodes
              is_episode: 1, // Flagging as episode
              series_number: parseInt(seasonNumStr),
              episode_number: parseInt(ep.episode_num),
              // Enriched Metadata
              description: (ep.info?.plot || data.info?.plot || "").trim() || "No description available",
              director: (ep.info?.director || data.info?.director || "").trim() || "-",
              actors: (ep.info?.cast || data.info?.cast || "").trim() || "-",
              genres_str: (data.info?.genre || "").trim() || "-",
              year: (ep.info?.releaseDate ? ep.info.releaseDate.split("-")[0] : (data.info?.releaseDate ? data.info.releaseDate.split("-")[0] : "")).trim() || "-",
              country: (data.info?.country || "").trim() || "-",
            });
          });
        }
      }

      // Apply Pagination (Since UI sends page=1)
      const page = params.page ? Number(params.page) : 1;
      const limit = 14; // Items per page
      const startIndex = (page - 1) * limit;
      const paginatedEpisodes = episodes.slice(startIndex, startIndex + limit);

      return {
        js: {
          total_items: episodes.length,
          max_page_items: limit,
          data: paginatedEpisodes, // Returning ONLY the episodes
        },
      };
    }
    // 1. Handle Series Info (Seasons & Episodes together)
    if (params.movieId && Number(params.movieId) !== 0) {
      const data = await this.makeRequest({
        action: "get_series_info",
        series_id: params.movieId,
      });

      const seasons: Video[] = [];

      if (data && data.episodes) {
        Object.keys(data.episodes).forEach((seasonNum) => {
          const seasonNumber = parseInt(seasonNum);
          const seasonEpisodesRaw = data.episodes[seasonNum];
          const episodesForSeason: Video[] = [];

          // Map the episodes for this specific season
          if (Array.isArray(seasonEpisodesRaw)) {
            seasonEpisodesRaw.forEach((ep: any) => {
              let duration = 0;
              if (ep.info?.duration_secs) {
                duration = Math.floor(parseInt(ep.info.duration_secs) / 60);
              } else if (ep.info?.duration) {
                duration = parseDurationToMinutes(ep.info.duration);
              }

              episodesForSeason.push({
                id: ep.id,
                name: ep.title || `Episode ${ep.episode_num}`,
                cmd: `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${ep.id}.${ep.container_extension || "mp4"}`,
                screenshot_uri: ep.info?.movie_image || data.info?.cover,
                category_id: data.info?.category_id,
                time: duration,
                rating_imdb: data.info?.rating,
                series: [], // Episodes don't have nested series
                is_episode: 1,
                series_number: seasonNumber,
                episode_number: parseInt(ep.episode_num),
              });
            });
          }

          // Push the season with its episodes nested inside the 'series' array
          seasons.push({
            id: seasonNum,
            name: `Season ${seasonNum}`,
            cmd: "",
            screenshot_uri: data.info?.cover,
            category_id: data.info?.category_id,
            time: 0,
            rating_imdb: data.info?.rating,
            series: [], // <-- THIS IS THE FIX! Nesting episodes here
            is_season: 1,
            // Enriched Metadata
            description: (data.info?.plot || "").trim() || "No description available",
            director: (data.info?.director || "").trim() || "-",
            actors: (data.info?.cast || "").trim() || "-",
            genres_str: (data.info?.genre || "").trim() || "-",
            year: (data.info?.releaseDate ? data.info.releaseDate.split("-")[0] : "").trim() || "-",
            country: (data.info?.country || "").trim() || "-",
          });
        });
      }

      return {
        js: {
          total_items: seasons.length,
          max_page_items: seasons.length,
          data: seasons,
        },
      };
    }

    // 2. Handle Series List (Main Directory)
    const reqParams: any = { action: "get_series" };
    if (params.category && params.category !== "*" && params.category !== "0") {
      reqParams.category_id = params.category;
    }

    const data = await this.makeRequest(reqParams);
    
    if (!Array.isArray(data)) {
      console.warn("XtreamClient.getSeries expected an array, but got:", typeof data, data);
      return { js: { total_items: 0, max_page_items: 0, data: [] } };
    }

    const series: Video[] = data.map((item: any) => ({
      id: item.series_id,
      name: item.name,
      cmd: "",
      screenshot_uri: item.cover,
      category_id: item.category_id,
      time: item.last_modified
        ? parseInt(item.last_modified)
        : item.added
          ? parseInt(item.added)
          : 0,
      rating_imdb: item.rating,
      series: [],
      is_series: 1,
      // Enriched Metadata
      description: (item.plot || "").trim() || "No description available",
      director: (item.director || "").trim() || "-",
      actors: (item.cast || "").trim() || "-",
      genres_str: (item.genre || "").trim() || "-",
      year: (item.releaseDate ? item.releaseDate.split("-")[0] : "").trim() || "-",
      country: (item.country || "").trim() || "-",
    }));

    let filteredSeries = params.search
      ? series.filter((s) =>
          s.name.toLowerCase().includes(params.search!.toLowerCase()),
        )
      : series;

    if (params.sort) {
      const s = params.sort.toLowerCase();
      if (s === "latest" || s === "added") {
        filteredSeries.sort((a, b) => b.time - a.time);
      } else if (s === "oldest") {
        filteredSeries.sort((a, b) => a.time - b.time);
      } else if (s === "alphabetic" || s === "name") {
        filteredSeries.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    const page = params.page ? Number(params.page) : 1;
    const limit = 14; // Items per page
    const startIndex = (page - 1) * limit;
    const paginatedSeries = filteredSeries.slice(startIndex, startIndex + limit);

    return {
      js: {
        total_items: filteredSeries.length,
        max_page_items: limit,
        data: paginatedSeries,
      },
    };
  }

  async getSeriesLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any> {
    let extension = "mp4";
    try {
      const data = await this.makeRequest({
        action: "get_series_info",
        series_id: params.series,
      });
      if (data && data.episodes) {
        for (const seasonNum of Object.keys(data.episodes)) {
          const episodes = data.episodes[seasonNum];
          if (Array.isArray(episodes)) {
            const ep = episodes.find((e: any) => Number(e.id) === Number(params.id));
            if (ep && ep.container_extension) {
              extension = ep.container_extension;
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error("Error fetching episode container extension:", e);
    }
    const url = `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${params.id}.${extension}`;
    return {
      js: {
        cmd: url,
      },
    };
  }

  isIdle(thresholdMs: number = 30000) {
    return Date.now() - this.lastRequestTime > thresholdMs;
  }
}
