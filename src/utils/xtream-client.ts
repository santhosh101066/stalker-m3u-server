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

export class XtreamClient implements IProvider {
  private baseUrl: string;
  private username: string;
  private password: string;
  private lastRequestTime: number = 0;

  constructor() {
    const protocol = "http";
    this.baseUrl = `${protocol}://${initialConfig.hostname}:${initialConfig.port}`;
    this.username = initialConfig.username || "";
    this.password = initialConfig.password || "";
  }

  private getApiUrl() {
    return `${this.baseUrl}/player_api.php`;
  }

  private async makeRequest(params: Record<string, any>) {
    this.lastRequestTime = Date.now();
    try {
      const response = await axios.get(this.getApiUrl(), {
        params: {
          username: this.username,
          password: this.password,
          ...params,
        },
      });
      return response.data;
    } catch (error) {
      console.error("XtreamClient request failed:", error);
      throw error;
    }
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

  clearCache(): void {}

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
    console.log(cmd);

    return {
      js: {
        id: "0",
        name: "",
        cmd: cmd,
      },
    };
  }

  async getEPG(channelId: string): Promise<ArrayData<EPG_List>> {
    return { js: [] };
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
      if (params.sort === "latest") {
        filteredVideos.sort((a, b) => b.time - a.time);
      } else if (params.sort === "oldest") {
        filteredVideos.sort((a, b) => a.time - b.time);
      } else if (params.sort === "alphabetic") {
        filteredVideos.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    return {
      js: {
        total_items: filteredVideos.length,
        max_page_items: filteredVideos.length,
        data: filteredVideos,
      },
    };
  }

  async getMovieLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any> {
    const url = `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${params.id}.mp4`;

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
            const duration = ep.info?.duration_secs 
              ? Math.floor(parseInt(ep.info.duration_secs) / 60) 
              : 0;

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
              const duration = ep.info?.duration_secs
                ? Math.floor(parseInt(ep.info.duration_secs) / 60)
                : 0;

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
    }));

    let filteredSeries = params.search
      ? series.filter((s) =>
          s.name.toLowerCase().includes(params.search!.toLowerCase()),
        )
      : series;

    if (params.sort) {
      if (params.sort === "latest") {
        filteredSeries.sort((a, b) => b.time - a.time);
      } else if (params.sort === "oldest") {
        filteredSeries.sort((a, b) => a.time - b.time);
      } else if (params.sort === "alphabetic") {
        filteredSeries.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    return {
      js: {
        total_items: filteredSeries.length,
        max_page_items: filteredSeries.length,
        data: filteredSeries,
      },
    };
  }

  async getSeriesLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any> {
    const url = `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${params.id}.mp4`;
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
