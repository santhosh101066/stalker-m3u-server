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
  getToken(refreshToken: boolean): Promise<string | null>;
  clearCache(): void;
  getExpiry(): Promise<string | null>;
  isIdle(thresholdMs?: number): boolean;

  getChannelGroups(): Promise<Data<Genre[]>>;
  getChannels(): Promise<Data<Programs<Channel>>>;
  getChannelLink(cmd: string): Promise<Data<Program>>;
  getEPG(channelId: string): Promise<ArrayData<EPG_List>>;

  getMoviesGroups(): Promise<Data<Genre[]>>;
  getMovies(params: MoviesApiParams): Promise<Data<Programs<Video>>>;
  getMovieLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any>;

  getSeriesGroups(): Promise<Data<Genre[]>>;
  getSeries(params: MoviesApiParams): Promise<Data<Programs<Video>>>;
  getSeriesLink(params: {
    series: string;
    id: number;
    download: number;
  }): Promise<any>;
}
