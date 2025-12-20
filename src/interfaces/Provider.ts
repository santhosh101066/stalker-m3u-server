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

export interface IProvider {
    // Auth / Lifecycle
    getToken(refreshToken: boolean): Promise<string | null>;
    clearCache(): void;
    getExpiry(): Promise<string | null>;

    // Live TV
    getChannelGroups(): Promise<Data<Genre[]>>;
    getChannels(): Promise<Data<Programs<Channel>>>;
    getChannelLink(cmd: string): Promise<Data<Program>>;
    getEPG(channelId: string): Promise<ArrayData<EPG_List>>;

    // VOD (Movies)
    getMoviesGroups(): Promise<Data<Genre[]>>;
    getMovies(params: MoviesApiParams): Promise<Data<Programs<Video>>>;
    getMovieLink(params: { series: string; id: number; download: number }): Promise<any>;
    // Series
    getSeriesGroups(): Promise<Data<Genre[]>>;
    getSeries(params: MoviesApiParams): Promise<Data<Programs<Video>>>;
    getSeriesLink(params: { series: string; id: number; download: number }): Promise<any>;
}
