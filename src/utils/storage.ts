// import { Channel, Movie, Serie } from "@/types/types";
import fs from "fs";
import path from "path";

// const storagePath = path.resolve(__dirname, "./.memdb");
// if (!fs.existsSync(storagePath)) {
//   fs.mkdirSync(storagePath);
// }

// function writeJSON(filename: string, data: any) {
//   fs.writeFileSync(
//     path.join(storagePath, filename),
//     JSON.stringify(data, null, 2)
//   );
// }

// function readJSON<T>(filename: string): T[] {
//   const filePath = path.join(storagePath, filename);
//   if (!fs.existsSync(filePath)) return [];
//   return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T[];
// }

// export interface IStorage {
//   // Channels
//   getChannels(group?: string): Promise<Channel[]>;
//   getChannelById(id: number): Promise<Channel | undefined>;
//   createChannel(channel: Channel): Promise<Channel>;
//   updateChannel(
//     id: number,
//     channel: Partial<Channel>
//   ): Promise<Channel | undefined>;

//   // Movies
//   getMovies(group?: string): Promise<Movie[]>;
//   getMovieById(id: number): Promise<Movie | undefined>;
//   createMovie(movie: Movie): Promise<Movie>;

//   // Series
//   getSeries(group?: string): Promise<Serie[]>;
//   getSeriesById(id: number): Promise<Serie | undefined>;
//   createSeries(series: Serie): Promise<Serie>;

//   // Sessions
//   getCurrentSession(): Promise<Session | undefined>;
//   createSession(session: InsertSession): Promise<Session>;
//   updateSession(
//     id: number,
//     session: Partial<InsertSession>
//   ): Promise<Session | undefined>;
//   deleteExpiredSessions(): Promise<void>;
// }

// export class MemStorage implements IStorage {
//   private channels: Map<number, Channel>;
//   private movies: Map<number, Movie>;
//   private series: Map<number, Series>;
//   private sessions: Map<number, Session>;
//   private currentId: {
//     channels: number;
//     movies: number;
//     series: number;
//     sessions: number;
//   };

//   constructor() {
//     this.channels = new Map();
//     this.movies = new Map();
//     this.series = new Map();
//     this.sessions = new Map();
//     this.currentId = { channels: 1, movies: 1, series: 1, sessions: 1 };

//     const restore = <T>(filename: string): Map<number, T> => {
//       const list = readJSON<T>(filename);
//       const map = new Map<number, T>();
//       let maxId = 0;
//       for (const item of list) {
//         const id = (item as any).id;
//         map.set(id, item);
//         if (id > maxId) maxId = id;
//       }
//       return { map, maxId };
//     };

//     const ch = restore<Channel>("channels.json");
//     this.channels = ch.map;
//     this.currentId.channels = ch.maxId + 1;

//     const mv = restore<Movie>("movies.json");
//     this.movies = mv.map;
//     this.currentId.movies = mv.maxId + 1;

//     const sr = restore<Series>("series.json");
//     this.series = sr.map;
//     this.currentId.series = sr.maxId + 1;

//     const ss = restore<Session>("sessions.json");
//     this.sessions = ss.map;
//     this.currentId.sessions = ss.maxId + 1;
//   }

//   // Channels
//   async getChannels(group?: string): Promise<Channel[]> {
//     const allChannels = Array.from(this.channels.values());
//     if (group) {
//       return allChannels.filter((channel) => channel.group === group);
//     }
//     return allChannels;
//   }

//   async getChannelById(id: number): Promise<Channel | undefined> {
//     return this.channels.get(id);
//   }

//   async createChannel(insertChannel: InsertChannel): Promise<Channel> {
//     const id = this.currentId.channels++;
//     const channel: Channel = {
//       ...insertChannel,
//       id,
//       createdAt: new Date(),
//     };
//     this.channels.set(id, channel);
//     writeJSON("channels.json", Array.from(this.channels.values()));
//     return channel;
//   }

//   async updateChannel(
//     id: number,
//     updateData: Partial<InsertChannel>
//   ): Promise<Channel | undefined> {
//     const channel = this.channels.get(id);
//     if (!channel) return undefined;

//     const updatedChannel = { ...channel, ...updateData };
//     this.channels.set(id, updatedChannel);
//     writeJSON("channels.json", Array.from(this.channels.values()));
//     return updatedChannel;
//   }

//   // Movies
//   async getMovies(group?: string): Promise<Movie[]> {
//     const allMovies = Array.from(this.movies.values());
//     if (group) {
//       return allMovies.filter((movie) => movie.group === group);
//     }
//     return allMovies;
//   }

//   async getMovieById(id: number): Promise<Movie | undefined> {
//     return this.movies.get(id);
//   }

//   async createMovie(insertMovie: InsertMovie): Promise<Movie> {
//     const id = this.currentId.movies++;
//     const movie: Movie = {
//       ...insertMovie,
//       id,
//       createdAt: new Date(),
//     };
//     this.movies.set(id, movie);
//     writeJSON("movies.json", Array.from(this.movies.values()));
//     return movie;
//   }

//   // Series
//   async getSeries(group?: string): Promise<Series[]> {
//     const allSeries = Array.from(this.series.values());
//     if (group) {
//       return allSeries.filter((s) => s.group === group);
//     }
//     return allSeries;
//   }

//   async getSeriesById(id: number): Promise<Series | undefined> {
//     return this.series.get(id);
//   }

//   async createSeries(insertSeries: InsertSeries): Promise<Series> {
//     const id = this.currentId.series++;
//     const seriesItem: Series = {
//       ...insertSeries,
//       id,
//       createdAt: new Date(),
//     };
//     this.series.set(id, seriesItem);
//     writeJSON("series.json", Array.from(this.series.values()));
//     return seriesItem;
//   }

//   // Sessions
//   async getCurrentSession(): Promise<Session | undefined> {
//     const now = new Date();
//     const validSessions = Array.from(this.sessions.values()).filter(
//       (session) => session.expiresAt > now
//     );
//     return validSessions[0];
//   }

//   async createSession(insertSession: InsertSession): Promise<Session> {
//     const id = this.currentId.sessions++;
//     const session: Session = {
//       ...insertSession,
//       id,
//       createdAt: new Date(),
//     };
//     this.sessions.set(id, session);
//     writeJSON("sessions.json", Array.from(this.sessions.values()));
//     return session;
//   }

//   async updateSession(
//     id: number,
//     updateData: Partial<InsertSession>
//   ): Promise<Session | undefined> {
//     const session = this.sessions.get(id);
//     if (!session) return undefined;

//     const updatedSession = { ...session, ...updateData };
//     this.sessions.set(id, updatedSession);
//     writeJSON("sessions.json", Array.from(this.sessions.values()));
//     return updatedSession;
//   }

//   async deleteExpiredSessions(): Promise<void> {
//     const now = new Date();
//     for (const [id, session] of this.sessions.entries()) {
//       if (session.expiresAt <= now) {
//         this.sessions.delete(id);
//       }
//     }
//     writeJSON("sessions.json", Array.from(this.sessions.values()));
//   }
// }

// export const storage = new MemStorage();


const storagePath = path.resolve(__dirname, "../../.mem");
if (!fs.existsSync(storagePath)) {
  fs.mkdirSync(storagePath);
}

export function writeJSON(filename: string, data: any) {
  fs.writeFileSync(
    path.join(storagePath, filename),
    JSON.stringify(data, null, 2)
  );
}

export function readJSON<T>(filename: string): T[] {
  const filePath = path.join(storagePath, filename);
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T[];
}