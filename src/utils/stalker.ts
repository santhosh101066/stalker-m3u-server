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
import axios from "axios";
import type { AxiosError, AxiosRequestConfig } from "axios";
import { promises as fsPromises } from "fs";
import path from "path";
import NodeCache from "node-cache"; // ADDED

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
};

async function httpRequest<T = any>(
  url: string,
  params: Record<string, any> = {},
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = { timeout: 20000 }
): Promise<T> {
  return axios
    .request<T>({
      url,
      params,
      method: options.method || "GET",
      headers: options.headers,
      timeout: 30000,
      validateStatus: (status) => status === 200,
    })
    .then((res) => res.data);
}

export class StalkerAPI {
  // CHANGED: Replaced private token variables with NodeCache
  // stdTTL: 3600s (1 hour), checkperiod: 600s (10 mins)
  private cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
  
  private random: string = "";
  private uid: string = "";
  private isProfileFetching: boolean = false;

  private profileRefreshPromise: Promise<string | null> | null = null;

  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogStarted: boolean = false;
  private activeChannelId: string = "0";

  constructor() {}

  getBaseUrl() {
    return `http://${initialConfig.hostname}:${initialConfig.port}${
      initialConfig.contextPath != "" ? `/${initialConfig.contextPath}` : ""
    }`;
  }

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
      // CHANGED: Check cache instead of local variable
      let currentToken = this.cache.get<string>("auth_token");
      
      if (!currentToken) {
        console.log("[Watchdog] Token missing, fetching new token...");
        currentToken = (await this.getToken(false)) || "";
      }

      if (!currentToken) return; // Avoid crashing if token fetch fails

      const currentTime = new Date().toISOString().split("T")[1].split(".")[0];
      console.log(
        `[Watchdog ${currentTime}] Sending heartbeat... (Channel: ${this.activeChannelId}, PlayType: 1)`
      );

      const res = await axios.get(
        `${this.getBaseUrl()}${this.getPhpUrl()}`,
        this._getAxiosRequestConfig(
          {
            type: "watchdog",
            action: "get_events",
            init,
            cur_play_type: "1", // 1 = Live TV
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
        const hasEvents = res.data?.data ? res.data.data.length > 0 : false;
        console.log(
          `[Watchdog] OK. Events received: ${hasEvents ? "Yes" : "None"}`
        );
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

    console.log(`[Watchdog] Processing event: ${data.event}`);

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
      timeout: 10000,
      validateStatus: options?.validateStatus || ((status) => status === 200),
      withCredentials: options?.withCredentials || true,
    };
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async performHandshake(token: string = "") {
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
      // CHANGED: Logic to use NodeCache with 5-minute buffer check
      const cachedToken = this.cache.get<string>("auth_token");
      const ttl = this.cache.getTtl("auth_token"); // Returns timestamp of expiry or undefined
      
      // If token exists, we are not forcing refresh, and we have > 5 minutes (300000ms) remaining
      if (
        !refreshToken &&
        cachedToken &&
        ttl &&
        ttl - Date.now() > 5 * 60 * 1000
      ) {
        return cachedToken;
      }

      // 2. If a refresh is already in progress, wait for it
      if (this.profileRefreshPromise) {
        console.log("Waiting for in-progress token refresh...");
        return this.profileRefreshPromise;
      }

      // 3. Start a new refresh and store the promise
      this.profileRefreshPromise = (async () => {
        try {
          const currentToken = this.cache.get<string>("auth_token");
          // If we have a token, try to refresh it
          if (currentToken) {
            try {
              await this.__refreshToken();
              return this.cache.get<string>("auth_token") || null;
            } catch (refreshError) {
              console.warn(
                "Token refresh failed, forcing full re-handshake.",
                (refreshError as Error).message
              );
              this.clearCache();
            }
          }

          // 4. Full handshake
          this.clearCache();
          const response: any = await this.performHandshake();

          if (response?.js?.token) {
            // CHANGED: Store in Cache
            // Note: We don't set TTL here yet because __refreshToken will confirm validity
            this.cache.set("auth_token", response.js.token, 3600);
            
            this.random = response.js.random;
            
            await this.__refreshToken();
            return this.cache.get<string>("auth_token") || null;
          } else {
            throw new Error("Authentication failed - Invalid handshake response");
          }
        } catch (err) {
          console.error("getToken inner promise error:", err);
          this.clearCache();
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

  clearCache() {
    // CHANGED: Clear NodeCache
    this.cache.del("auth_token");
    this.random = "";
  }

  private async __refreshToken(secondAuth = 0) {
    const currentToken = this.cache.get<string>("auth_token");
    if (!currentToken) {
      throw new Error("No token to refresh");
    }
    try {
      // Note: We pause watchdog during auth refresh to prevent conflicts
      this.stopWatchdog();

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
        // CHANGED: Refresh Successful - Reset TTL to 1 hour
        this.cache.ttl("auth_token", 3600);
        
        // Restart watchdog after successful refresh
        await this.startWatchdog();
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
    // CHANGED: Get from Cache
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
        typeof response === "string" &&
        response.startsWith("Authorization failed.") &&
        !loop &&
        !this.isProfileFetching
      ) {
        console.log(response, " - Fetching new token and retrying...");
        // Force refresh
        await this.getToken(true);
        return this.makeRequest(endpoint, params, isFetch, true);
      }
      if (response === "Authorization failed.") {
        throw new Error("Authorization Failed.");
      }

      return response;
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.clearCache();
        this.isProfileFetching = false;
      }
      throw error;
    }
  }

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
  }: MoviesApiParams) {
    const params = {
      type: "vod",
      action: "get_ordered_list",
      category,
      genre: "*",
      p: page,
      sortby: "added",
      movie_id: movieId,
      season_id: seasonId,
      episode_id: episodeId,
      search,
    };

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
    ...others
  }: MoviesApiParams) {
    return this.makeRequest<Data<Programs<Video>>>(
      this.getPhpUrl(),
      {
        type: "series",
        action: "get_ordered_list",
        category,
        genre: "*",
        p: page,
        sortby: "added",
        movie_id: movieId,
        season_id: seasonId,
        episode_id: episodeId,
        search,
        ...others,
      },
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

  addToken(token: string) {
    if (!initialConfig.tokens.includes(token)) {
      initialConfig.tokens.push(token);
      const configPath = path.join(process.cwd(), "config.json");
      fsPromises
        .writeFile(configPath, JSON.stringify(initialConfig, null, 2))
        .catch((err) => {
          console.error("Failed to save config:", err);
        });
    }
  }

  removeToken(token: string) {
    if (initialConfig.tokens.includes(token)) {
      initialConfig.tokens = initialConfig.tokens.filter((t) => t !== token);
      const configPath = path.join(process.cwd(), "config.json");
      fsPromises
        .writeFile(configPath, JSON.stringify(initialConfig, null, 2))
        .catch((err) => {
          if (err) {
            console.error("Failed to save config:", err);
          }
        });
    }
  }
}

export const stalkerApi = new StalkerAPI();