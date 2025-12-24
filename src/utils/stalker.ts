import { initialConfig } from "@/config/server";
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
import axios, { AxiosError, AxiosRequestConfig } from "axios";
import { httpClient } from "@/utils/httpClient";
import NodeCache from "node-cache";
import { Token } from "@/models/Token";
import pLimit from "p-limit";

// Limit concurrent requests to the Portal to 5 at a time
const requestLimit = pLimit(5);

async function httpRequest<T = any>(
  url: string,
  params: Record<string, any> = {},
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = { timeout: 120000 }
): Promise<T> {
  return httpClient
    .request<T>({
      url,
      params,
      method: options.method || "GET",
      headers: options.headers,
      timeout: 120000,
    })
    .then((res) => {
      // Maintain original behavior: throw if not 200
      if (res.status !== 200) {
        throw new Error(`Request failed with status ${res.status}`);
      }
      return res.data;
    });
}

export class StalkerAPI implements IProvider {
  private cache = new NodeCache({ stdTTL: 3700, checkperiod: 600 });
  private random: string = "";
  private uid: string = "";
  private isProfileFetching: boolean = false;

  private profileRefreshPromise: Promise<string | null> | null = null;

  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogStarted: boolean = false;
  private activeChannelId: string = "0";

  constructor() {
    this.loadTokenFromDB();
  }

  private async loadTokenFromDB() {
    try {
      const tokenRecord = await Token.findOne({ where: { isValid: true } });
      if (tokenRecord?.token) {
        console.log(`[StalkerAPI] Restored valid token from DB: ${tokenRecord.token}`);
        this.cache.set("auth_token", tokenRecord.token, 3600);
        // this.startWatchdog();
      }
    } catch (err) {
      console.warn("[StalkerAPI] Could not restore token from DB");
    }
  }

  getBaseUrl() {
    return `http://${initialConfig.hostname}:${initialConfig.port}${initialConfig.contextPath != "" ? `/${initialConfig.contextPath}` : ""
      }`;
  }

  // Used for Content Requests AND Auth (Dynamic based on context)
  getPhpUrl() {
    return initialConfig.contextPath != "" ? "/server/load.php" : "/portal.php";
  }

  async startWatchdog(interval: number = 30) {
    if (this.watchdogInterval) {
      return;
    }
    this.watchdogStarted = true;
    console.log(`[Watchdog] Starting service with ${interval}s interval...`);

    // Run once immediately to establish state
    await this.runWatchdogCheck(true);

    // Start the loop
    this.watchdogInterval = setInterval(() => {
      this.runWatchdogCheck();
    }, interval * 1000);
  }

  setActiveChannel(channelId: string) {
    this.activeChannelId = channelId;
    console.log(`[Watchdog] Active channel ID updated to: ${channelId}`);
  }

  runWatchdogCheck = async (init = false) => {
    try {
      let currentToken = this.cache.get<string>("auth_token");

      if (!currentToken) {
        console.log("[Watchdog] Token missing, fetching new token...");
        currentToken = (await this.getToken(false)) || "";
      }

      if (!currentToken) return;

      const currentTime = new Date().toISOString().split("T")[1].split(".")[0];

      // Watchdog usually goes to getPhpUrl() (load.php or portal.php depending on config)
      // kept as getPhpUrl() unless this specifically needs portal.php too.
      // Usually watchdog events come from the load balancer/server script.
      const res = await httpClient.get(
        `${this.getBaseUrl()}${this.getPhpUrl()}`,
        this._getAxiosRequestConfig(
          {
            type: "watchdog",
            action: "get_events",
            init,
            cur_play_type: "1",
            event_active_id: this.activeChannelId,
            JsHttpRequest: "1-xml",
          },
          currentToken,
          {
            validateStatus: (status) => true,
            withCredentials: true,
            contentType: "application/json",
          }
        )
      );

      if (res.status === 200) {
        // Log success silently or verbose
      } else {
        console.warn(`[Watchdog] Unexpected status code: ${res.status}`);
      }

      this.handleWatchdogEvents(res.data);
    } catch (err) {
      console.error("[Watchdog] Error during check:", (err as Error).message);
    }
  };

  stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
      this.watchdogStarted = false;
      console.log("[Watchdog] Service stopped.");
    }
  }

  private handleWatchdogEvents(data: any) {
    if (!data || !data.event) {
      return;
    }
    switch (data.event) {
      case "reboot":
        console.warn("[Watchdog] Event: REBOOT required.");
        break;
      case "reload_portal":
        console.warn("[Watchdog] Event: RELOAD PORTAL.");
        break;
      case "send_msg":
        console.log("[Watchdog] Event: Message received.");
        break;
      case "update_channels":
        console.log("[Watchdog] Event: Channel update available.");
        break;
      case "update_epg":
        console.log("[Watchdog] Event: EPG update requested.");
        break;
      default:
        console.log("[Watchdog] Unhandled event:", data.event);
    }
  }

  private _getAxiosRequestConfig(
    params: Record<string, any>,
    token: string,
    options?: {
      contentType?: string;
      withCredentials?: boolean;
      validateStatus?: (status: number) => boolean;
      referrer?: string;
    }
  ): AxiosRequestConfig {
    return {
      params: {
        ...params,
        mac: initialConfig.mac,
        token,
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (STB) WebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.101 Safari/537.36",
        "X-User-Agent": `Model: ${initialConfig.stbType}; Link: WiFi`,
        Cookie: `mac=${initialConfig.mac}; stb_lang=en; timezone=America/New_York`,
        Authorization: `Bearer ${token}`,
        SN: initialConfig.serialNumber!,
        "Accept-Encoding": "gzip, deflate, br",
        Accept: "*/*",
        Connection: "keep-alive",
        "Content-Type": options?.contentType || "application/json",
        Referrer: options?.referrer || this.getBaseUrl(),
      },
      timeout: 120000,
      validateStatus: options?.validateStatus || ((status) => status === 200),
      withCredentials: options?.withCredentials || true,
    };
  }

  private async performHandshake(token: string = "") {
    // --- UPDATED: Uses getPhpUrl() (Dynamic: load.php if context exists, portal.php if empty) ---
    return httpRequest(
      `${this.getBaseUrl()}${this.getPhpUrl()}`,
      {
        type: "stb",
        action: "handshake",
        mac: initialConfig.mac,
        device_id: initialConfig.deviceId1,
        device_id2: initialConfig.deviceId2,
        serial_number: initialConfig.serialNumber,
        stb_type: initialConfig.stbType,
        JsHttpRequest: "1-xml",
      },
      (() => {
        const config = this._getAxiosRequestConfig({}, token, {
          referrer: this.getBaseUrl(),
        });
        return {
          method: config.method,
          headers: config.headers as Record<string, string>,
          timeout: config.timeout,
        };
      })()
    );
  }

  async getToken(refreshToken: boolean) {
    try {
      const cachedToken = this.cache.get<string>("auth_token");
      const ttl = this.cache.getTtl("auth_token");

      if (!refreshToken && cachedToken && ttl && ttl - Date.now() > 5 * 60 * 1000) {
        return cachedToken;
      }

      if (this.profileRefreshPromise) {
        console.log("Waiting for in-progress token refresh...");
        return this.profileRefreshPromise;
      }

      this.profileRefreshPromise = (async () => {
        try {
          this.isProfileFetching = true;
          const currentToken = this.cache.get<string>("auth_token");

          if (currentToken) {
            try {
              await this.__refreshToken();
              const newToken = this.cache.get<string>("auth_token");
              this.isProfileFetching = false;
              return newToken || null;
            } catch (refreshError) {
              console.warn("Token refresh failed, forcing full re-handshake.");
            }
          }

          console.log("Performing full handshake...");
          this.cache.del("auth_token");

          const response: any = await this.performHandshake();

          if (response?.js?.token) {
            const newToken = response.js.token;
            this.random = response.js.random;

            this.cache.set("auth_token", newToken, 3600);
            this.updateTokenInDB(newToken);

            await this.__refreshToken();

            this.isProfileFetching = false;
            return newToken;
          } else {
            throw new Error("Authentication failed - Invalid handshake response");
          }
        } catch (err) {
          console.error("getToken inner promise error:", err);
          this.cache.del("auth_token");
          this.isProfileFetching = false;
          throw err;
        } finally {
          this.profileRefreshPromise = null;
        }
      })();

      return this.profileRefreshPromise;
    } catch (error) {
      console.error("getToken outer error:", error);
      this.profileRefreshPromise = null;
      throw error;
    }
  }

  async fetchNewToken() {
    try {
      console.log("Forcing fetch of NEW token via handshake...");
      // remove current token to force fresh handshake
      this.cache.del("auth_token");
      // call getToken with refresh=true logic implicit in cache deletion
      const token = await this.getToken(true);
      return { token };
    } catch (error) {
      console.error("fetchNewToken failed:", error);
      return { token: null, error };
    }
  }

  private async updateTokenInDB(token: string) {
    try {
      // Keeping only one valid token for simplicity in home use, 
      // or append if you prefer history.
      await Token.destroy({ where: {} });
      await Token.create({ token, isValid: true });
    } catch (e) { console.error("DB Token update failed", e) }
  }

  clearCache() {
    this.cache.del("auth_token");
    this.random = "";
  }

  async getExpiry(): Promise<string | null> {
    try {
      const currentToken = this.cache.get<string>("auth_token");
      if (!currentToken) {
        await this.getToken(false);
      }
      // We can reuse the logic from __refreshToken or just call get_profile directly
      // But __refreshToken is private and complex.
      // Let's make a direct call similar to __refreshToken but returning the date.

      const token = this.cache.get<string>("auth_token");
      if (!token) return null;

      const profile = await httpRequest(
        `${this.getBaseUrl()}${this.getPhpUrl()}`,
        {
          type: "stb",
          action: "get_profile",
          hd: 1,
          num_banks: 2,
          stb_type: initialConfig.stbType,
          sn: initialConfig.serialNumber,
          mac: initialConfig.mac,
          token: token,
          JsHttpRequest: "1-xml",
        },
        (() => {
          const config = this._getAxiosRequestConfig({}, token, {
            referrer: this.getBaseUrl(),
          });
          return {
            method: config.method,
            headers: config.headers as Record<string, string>,
            timeout: config.timeout,
          };
        })()
      );

      if (profile && profile.js && profile.js.expire_billing_date) {
        return profile.js.expire_billing_date;
      }
      return null;

    } catch (e) {
      console.error("Failed to get expiry:", e);
      return null;
    }
  }

  private async __refreshToken(secondAuth = 0) {
    const currentToken = this.cache.get<string>("auth_token");
    if (!currentToken) {
      throw new Error("No token to refresh");
    }
    try {
      this.stopWatchdog();

      // --- UPDATED: Uses getPhpUrl() (Dynamic: load.php if context exists, portal.php if empty) ---
      const profile = await httpRequest(
        `${this.getBaseUrl()}${this.getPhpUrl()}`,
        {
          type: "stb",
          action: "get_profile",
          hd: 1,
          auth_second_step: secondAuth,
          num_banks: 2,
          timestamp: Math.floor(Date.now() / 1000),
          image_version: "218",
          video_out: "hdmi",
          stb_type: initialConfig.stbType,
          ver: "ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; PORTAL version: 5.1.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566",
          hw_version_2: "500482917046b738ac8dea718bc1e8c3",
          hw_version: "1.7-BD-00",
          not_valid_token: 0,
          client_type: "STB",
          api_signature: "263",
          metrics: {
            mac: initialConfig.mac,
            sn: initialConfig.serialNumber,
            model: initialConfig.stbType,
            type: "STB",
            uid: this.uid,
            random: this.random,
          },
          device_id: initialConfig.deviceId1,
          device_id2: initialConfig.deviceId2,
          signature: "",
          sn: initialConfig.serialNumber,
          mac: initialConfig.mac,
          token: currentToken,
          JsHttpRequest: "1-xml",
        },
        (() => {
          const config = this._getAxiosRequestConfig({}, currentToken, {
            referrer: this.getBaseUrl(),
          });
          return {
            method: config.method,
            headers: config.headers as Record<string, string>,
            timeout: config.timeout,
          };
        })()
      );

      if (typeof profile !== "object" || !profile.js) {
        throw new Error(
          "Profile refresh failed, invalid response. Likely auth failure."
        );
      }

      console.log("Expires on : ", profile.js.expire_billing_date);

      if (profile.js.status === 2 && secondAuth == 0) {
        await this.__refreshToken(1);
      } else {
        this.cache.ttl("auth_token", 3600);
        // await this.startWatchdog();
      }
    } catch (error) {
      console.error(
        "__refreshToken error:",
        (error as AxiosError).message || error
      );
      throw error;
    }
  }

  async makeRequest<T = any>(
    endpoint: string,
    params: Record<string, any> = {},
    isFetch = true,
    loop = false
  ): Promise<T> {

    // --- QUEUE LIMITER APPLIED HERE ---
    return requestLimit(async () => {
      let token = this.cache.get<string>("auth_token");
      if (!token) {
        token = (await this.getToken(false)) || "";
      }

      const url = `${this.getBaseUrl()}${endpoint}`;

      try {
        const response = await httpRequest(
          url,
          { ...params, uid: this.uid, JsHttpRequest: "1-xml" },
          (() => {
            const config = this._getAxiosRequestConfig({}, token!, {
              referrer: this.getBaseUrl(),
            });
            return {
              method: config.method,
              headers: config.headers as Record<string, string>,
              timeout: config.timeout,
            };
          })()
        );

        if (
          (typeof response === "string" && response.startsWith("Authorization failed.")) ||
          response === "Authorization failed."
        ) {
          if (!loop && !this.isProfileFetching) {
            console.log("Auth failed. Refreshing token and retrying request...");
            await this.getToken(true);
            return this.makeRequest(endpoint, params, isFetch, true);
          }
          throw new Error("Authorization Failed.");
        }

        return response;

      } catch (error: any) {
        if (axios.isAxiosError(error) && error.response?.status === 401) {
          if (!loop) {
            console.warn("401 detected. Retrying with fresh token...");
            this.cache.del("auth_token");
            await this.getToken(true);
            return this.makeRequest(endpoint, params, isFetch, true);
          }
        }
        throw error;
      }
    });
  }

  // --- CONTENT METHODS USE getPhpUrl() (Server Load PHP) ---

  async getChannelGroups() {
    return this.makeRequest<Data<Genre[]>>(this.getPhpUrl(), {
      type: "itv",
      action: "get_genres",
    });
  }

  async getChannels() {
    return this.makeRequest<Data<Programs<Channel>>>(this.getPhpUrl(), {
      type: "itv",
      action: "get_all_channels",
    });
  }

  async getChannelLink(cmd: string) {
    return this.makeRequest<Data<Program>>(
      this.getPhpUrl(),
      {
        type: "itv",
        action: "create_link",
        cmd,
        disable_ad: "0",
      },
      true
    );
  }

  async getMoviesGroups() {
    return this.makeRequest<Data<Genre[]>>(this.getPhpUrl(), {
      type: "vod",
      action: "get_categories",
    });
  }

  async getMovies({
    category,
    page,
    movieId = 0,
    seasonId = 0,
    episodeId = 0,
    disableProfile = false,
    search = "",
    sort,
  }: MoviesApiParams) {
    const params: any = {
      type: "vod",
      action: "get_ordered_list",
      category,
      genre: "*",
      p: page,
      sortby: sort || "added",
      movie_id: movieId,
      season_id: seasonId,
      episode_id: episodeId,
    };

    if (search) {
      params.search = search;
    }

    return this.makeRequest<Data<Programs<Video>>>(
      this.getPhpUrl(),
      params,
      true,
      false
    );
  }

  async getSeries({
    category,
    page,
    movieId = 0,
    seasonId = 0,
    episodeId = 0,
    disableProfile = false,
    search = "",
    sort,
    ...others
  }: MoviesApiParams) {
    const params: any = {
      type: "series",
      action: "get_ordered_list",
      category,
      genre: "*",
      p: page,
      sortby: sort || "added",
      movie_id: movieId,
      season_id: seasonId,
      episode_id: episodeId,
      ...others,
    };

    if (search) {
      params.search = search;
    }

    return this.makeRequest<Data<Programs<Video>>>(
      this.getPhpUrl(),
      params,
      true,
      false
    );
  }


  async getMovieLink({
    series,
    id,
    download = 0,
  }: {
    series: string;
    id: number;
    download: number;
  }) {
    const params = {
      type: "vod",
      action: "create_link",
      force_ch_link_check: "0",
      disable_ad: "0",
      download: 0,
      forced_storage: "",
      series: Number(series),
      cmd: initialConfig.contextPath === "" ? id : `/media/file_${id}.mpg`,
    };

    // Note: getMovieLink explicitly used "/server/load.php" in original.
    // getPhpUrl() will return that anyway if contextPath exists.
    return this.makeRequest<Data<Programs<Video>>>(
      "/server/load.php",
      params
    );
  }

  async getSeriesLink({
    series,
    id,
    download = 0,
  }: {
    series: string;
    id: number;
    download: number;
  }) {
    return this.makeRequest<Data<Programs<Video>>>(this.getPhpUrl(), {
      type: "series",
      action: "create_link",
      force_ch_link_check: "0",
      disable_ad: "0",
      download,
      forced_stop_range: "",
      series: series,
      cmd: initialConfig.contextPath === "" ? id : `/media/file_${id}.mpg`,
    });
  }

  async getSeriesGroups() {
    return this.makeRequest<Data<Genre[]>>(this.getPhpUrl(), {
      type: "series",
      action: "get_categories",
    });
  }

  async getEPG(channelId: string) {
    return this.makeRequest<ArrayData<EPG_List>>(this.getPhpUrl(), {
      type: "epg",
      action: "get_all_program_for_ch",
      ch_id: channelId,
    });
  }

  async addToken(token: string) {
    try {
      await Token.findOrCreate({ where: { token } });
      if (!initialConfig.tokens.includes(token)) {
        initialConfig.tokens.push(token);
      }
    } catch (err) {
      console.error("Failed to save token to DB:", err);
    }
  }

  async removeToken(token: string) {
    try {
      await Token.destroy({ where: { token } });
      initialConfig.tokens = initialConfig.tokens.filter((t) => t !== token);
    } catch (err) {
      console.error("Failed to remove token from DB:", err);
    }
  }
}

export const stalkerApi = new StalkerAPI();
