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

    constructor() {
        // Construct base URL from config
        // Assuming config.hostname is the XC server host
        const protocol = "http"; // Or https if supported/configured
        this.baseUrl = `${protocol}://${initialConfig.hostname}:${initialConfig.port}`;
        this.username = initialConfig.username || "";
        this.password = initialConfig.password || "";
    }

    private getApiUrl() {
        return `${this.baseUrl}/player_api.php`;
    }



    private async makeRequest(params: Record<string, any>) {
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
        // Xtream Codes doesn't typically use a token like Stalker.
        // We can verify credentials here.
        const data = await this.makeRequest({});
        if (data.user_info && data.user_info.auth === 1) {
            return "valid";
        }
        return null;
    }

    async getExpiry(): Promise<string | null> {
        const data = await this.makeRequest({});
        if (data.user_info && data.user_info.exp_date) {
            // Convert unix timestamp to readable date if needed, or return as is
            // XC usually returns unix timestamp
            const exp = data.user_info.exp_date;
            if (!isNaN(exp)) {
                return new Date(parseInt(exp) * 1000).toLocaleString();
            }
            return exp;
        }
        return null;
    }

    clearCache(): void {
        // No cache implemented yet
    }

    // --- Live TV ---

    async getChannelGroups(): Promise<Data<Genre[]>> {
        const data = await this.makeRequest({ action: "get_live_categories" });
        // Map XC categories to Genre[]
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
        // Map XC streams to Channel[]
        const channels: Channel[] = data.map((item: any) => ({
            id: item.stream_id,
            name: item.name,
            cmd: `http://${initialConfig.hostname}:${initialConfig.port}/live/${this.username}/${this.password}/${item.stream_id}.ts`, // Direct stream URL
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
        // For XC, the cmd is already the URL (or we construct it).
        // Stalker expects a "create_link" action which returns a URL.
        // Here we just return the cmd as the URL.
        console.log(cmd);

        return {
            js: {
                id: "0",
                name: "",
                cmd: cmd, // The cmd in getChannels is the full URL
            },
        };
    }

    async getEPG(channelId: string): Promise<ArrayData<EPG_List>> {
        // XC EPG is usually via XMLTV or specific API actions.
        // get_short_epg or get_simple_data_table might work depending on XC version.
        // For now, returning empty as specific EPG mapping is complex.
        return { js: [] };
    }

    // --- VOD ---

    async getMoviesGroups(): Promise<Data<Genre[]>> {
        const data = await this.makeRequest({ action: "get_vod_categories" });
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
        if (params.category && params.category !== '*' && params.category !== '0') {
            reqParams.category_id = params.category;
        }

        const data = await this.makeRequest(reqParams);

        const videos: Video[] = data.map((item: any) => ({
            id: item.stream_id,
            name: item.name,
            cmd: `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${item.stream_id}.${item.container_extension}`,
            // logo: item.stream_icon, // Removed as per Video interface
            screenshot_uri: item.stream_icon,
            category_id: item.category_id,
            time: item.added ? parseInt(item.added) : 0,
            rating_imdb: item.rating,
            runtime: item.duration_secs ? Math.floor(parseInt(item.duration_secs) / 60) : 0,
        }));

        let filteredVideos = params.search
            ? videos.filter((v) => v.name.toLowerCase().includes(params.search!.toLowerCase()))
            : videos;

        if (params.sort) {
            if (params.sort === 'latest') {
                filteredVideos.sort((a, b) => b.time - a.time);
            } else if (params.sort === 'oldest') {
                filteredVideos.sort((a, b) => a.time - b.time);
            } else if (params.sort === 'alphabetic') {
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

    async getMovieLink(params: { series: string; id: number; download: number }): Promise<any> {
        // Construct direct URL
        const url = `http://${initialConfig.hostname}:${initialConfig.port}/movie/${this.username}/${this.password}/${params.id}.mp4`; // Fallback extension

        return {
            js: {
                cmd: url
            }
        }
    }

    // --- Series ---

    async getSeriesGroups(): Promise<Data<Genre[]>> {
        const data = await this.makeRequest({ action: "get_series_categories" });
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
        // If movieId is present, we are fetching episodes for a specific series
        if (params.movieId) {
            const data = await this.makeRequest({ action: "get_series_info", series_id: params.movieId });
            // data.episodes is an object where keys are season numbers (strings) and values are arrays of episodes
            // We need to flatten this into a list of episodes
            const episodes: Video[] = [];

            if (data && data.episodes) {
                Object.keys(data.episodes).forEach(seasonNum => {
                    const seasonEpisodes = data.episodes[seasonNum];
                    if (Array.isArray(seasonEpisodes)) {
                        seasonEpisodes.forEach((ep: any) => {
                            episodes.push({
                                id: ep.id, // Episode ID
                                name: ep.title || `Episode ${ep.episode_num}`,
                                cmd: `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${ep.id}.${ep.container_extension || 'mp4'}`,
                                screenshot_uri: ep.info?.movie_image || data.info?.cover,
                                category_id: data.info?.category_id,
                                time: ep.info?.duration_secs ? Math.floor(parseInt(ep.info.duration_secs) / 60) : 0,
                                rating_imdb: data.info?.rating,
                                series: [],
                                is_episode: 1,
                                series_number: parseInt(seasonNum), // Season number
                                episode_number: parseInt(ep.episode_num),
                                // We can add more fields if needed
                            });
                        });
                    }
                });
            }

            return {
                js: {
                    total_items: episodes.length,
                    max_page_items: episodes.length,
                    data: episodes,
                },
            };
        }

        // Otherwise, fetch list of series
        const reqParams: any = { action: "get_series" };
        if (params.category && params.category !== '*' && params.category !== '0') {
            reqParams.category_id = params.category;
        }

        const data = await this.makeRequest(reqParams);
        const series: Video[] = data.map((item: any) => ({
            id: item.series_id,
            name: item.name,
            cmd: "", // Series don't have a single CMD
            // logo: item.cover, // Removed
            screenshot_uri: item.cover,
            category_id: item.category_id,
            time: item.last_modified ? parseInt(item.last_modified) : (item.added ? parseInt(item.added) : 0),
            rating_imdb: item.rating,
            // censored: "0", // Removed
            series: [], // Populate if needed
            is_series: 1
        }));

        let filteredSeries = params.search
            ? series.filter((s) => s.name.toLowerCase().includes(params.search!.toLowerCase()))
            : series;

        if (params.sort) {
            if (params.sort === 'latest') {
                filteredSeries.sort((a, b) => b.time - a.time);
            } else if (params.sort === 'oldest') {
                filteredSeries.sort((a, b) => a.time - b.time);
            } else if (params.sort === 'alphabetic') {
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

    async getSeriesLink(params: { series: string; id: number; download: number }): Promise<any> {
        // Similar to movies, construct URL
        const url = `http://${initialConfig.hostname}:${initialConfig.port}/series/${this.username}/${this.password}/${params.id}.mp4`;
        return {
            js: {
                cmd: url
            }
        }
    }
}
