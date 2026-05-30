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
import { logger } from "@/utils/logger";

const requestLimit = pLimit(5);

async function httpRequest<T = any>(
  url: string,
  params: Record<string, any> = {},
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = { timeout: 120000 },
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
  private inFlight = new Map<string, Promise<any>>();

  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogStarted: boolean = false;
  private activeChannelId: string = "0";
  private lastRequestTime: number = 0;

  private getCacheKey(endpoint: string, params: Record<string, any>): string {
    const keyParts = [endpoint];
    Object.keys(params)
      .sort()
      .forEach((key) => {
        if (key !== "token" && key !== "timestamp" && key !== "api_signature") {
          keyParts.push(
            `${key}:${typeof params[key] === "object" ? JSON.stringify(params[key]) : params[key]}`,
          );
        }
      });
    return keyParts.join("|");
  }

  private isCacheable(params: Record<string, any>): boolean {
    const cacheableActions = [
      "get_genres",
      "get_all_channels",
      "get_categories",
      "get_ordered_list",
      "get_epg",
      "get_all_program_for_ch",
      "get_short_epg",
    ];
    return cacheableActions.includes(params.action);
  }

  private getCacheTTL(action: string): number {
    switch (action) {
      case "get_genres":
      case "get_categories":
      case "get_all_channels":
        return 21600; // 6 hours
      case "get_ordered_list":
      case "get_epg":
      case "get_all_program_for_ch":
      case "get_short_epg":
        return 600; // 10 minutes
      default:
        return 600;
    }
  }

  constructor() {
    this.loadTokenFromDB();
  }

  async loadTokenFromDB() {
    try {
      const tokenRecord = await Token.findOne({ where: { isValid: true } });
      if (tokenRecord?.token) {
        logger.info(
          `[StalkerAPI] Restored valid token from DB: ${tokenRecord.token}`,
        );
        this.cache.set("auth_token", tokenRecord.token, 3600);
      }
    } catch (err) {
      logger.warn("[StalkerAPI] Could not restore token from DB");
    }
  }

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
    logger.info(`[Watchdog] Starting service with ${interval}s interval...`);

    await this.runWatchdogCheck(true);

    this.watchdogInterval = setInterval(() => {
      this.runWatchdogCheck();
    }, interval * 1000);
  }

  setActiveChannel(channelId: string) {
    this.activeChannelId = channelId;
    logger.info(`[Watchdog] Active channel ID updated to: ${channelId}`);
  }

  runWatchdogCheck = async (init = false) => {
    try {
      let currentToken = this.cache.get<string>("auth_token");

      if (!currentToken) {
        logger.info("[Watchdog] Token missing, fetching new token...");
        currentToken = (await this.getToken(false)) || "";
      }

      if (!currentToken) return;

      const currentTime = new Date().toISOString().split("T")[1].split(".")[0];

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
          },
        ),
      );

      if (res.status === 200) {
      } else {
        logger.warn(`[Watchdog] Unexpected status code: ${res.status}`);
      }

      this.handleWatchdogEvents(res.data);
    } catch (err) {
      logger.error(`[Watchdog] Error during check: ${(err as Error).message}`);
    }
  };

  stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
      this.watchdogStarted = false;
      logger.info("[Watchdog] Service stopped.");
    }
  }

  private handleWatchdogEvents(data: any) {
    if (!data || !data.event) {
      return;
    }
    switch (data.event) {
      case "reboot":
        logger.warn("[Watchdog] Event: REBOOT required.");
        break;
      case "reload_portal":
        logger.warn("[Watchdog] Event: RELOAD PORTAL.");
        break;
      case "send_msg":
        logger.info("[Watchdog] Event: Message received.");
        break;
      case "update_channels":
        logger.info("[Watchdog] Event: Channel update available.");
        break;
      case "update_epg":
        logger.info("[Watchdog] Event: EPG update requested.");
        break;
      default:
        logger.info(`[Watchdog] Unhandled event: ${data.event}`);
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
    },
  ): AxiosRequestConfig {
    return {
      params: {
        ...params,
        mac: initialConfig.mac,
        token,
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG250 stbapp rv:2.7.3-r7-250 Safari/533.3",
        "X-User-Agent": `model=${initialConfig.stbType || "MAG250"};link=wifi;mac=${initialConfig.mac};pkg=2.24.0-r19-250`,
        Cookie: `mac=${initialConfig.mac}; stb_lang=en; timezone=Europe/London`,
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
      })(),
    );
  }

  async getToken(refreshToken: boolean) {
    try {
      const cachedToken = this.cache.get<string>("auth_token");
      const ttl = this.cache.getTtl("auth_token");

      if (
        !refreshToken &&
        cachedToken &&
        ttl &&
        ttl - Date.now() > 5 * 60 * 1000
      ) {
        return cachedToken;
      }

      if (this.profileRefreshPromise) {
        logger.info("Waiting for in-progress token refresh...");
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
              logger.warn("Token refresh failed, forcing full re-handshake.");
            }
          }

          logger.info("Performing full handshake...");
          this.cache.del("auth_token");

          const response: any = await this.performHandshake();
          logger.info(`Handshake response: ${JSON.stringify(response)}`);

          if (response?.js?.token) {
            const newToken = response.js.token;
            this.random = response.js.random;

            this.cache.set("auth_token", newToken, 3600);
            this.updateTokenInDB(newToken);

            await this.__refreshToken();

            this.isProfileFetching = false;
            return newToken;
          } else {
            throw new Error(
              "Authentication failed - Invalid handshake response",
            );
          }
        } catch (err) {
          logger.error(`getToken inner promise error: ${err}`);
          this.cache.del("auth_token");
          this.isProfileFetching = false;
          throw err;
        } finally {
          this.profileRefreshPromise = null;
        }
      })();

      return this.profileRefreshPromise;
    } catch (error) {
      logger.error(`getToken outer error: ${error}`);
      this.profileRefreshPromise = null;
      throw error;
    }
  }

  async fetchNewToken() {
    try {
      logger.info("Forcing fetch of NEW token via handshake...");

      this.cache.del("auth_token");

      const token = await this.getToken(true);
      return { token };
    } catch (error) {
      logger.error(`fetchNewToken failed: ${error}`);
      return { token: null, error };
    }
  }

  private async updateTokenInDB(token: string) {
    try {
      await Token.destroy({ where: {} });
      await Token.create({ token, isValid: true });
    } catch (e) {
      logger.error(`DB Token update failed ${e}`);
    }
  }

  clearCache() {
    const token = this.cache.get("auth_token");
    this.cache.flushAll();
    this.inFlight.clear();
    if (token) {
      this.cache.set("auth_token", token, 3600);
    }
    this.random = "";
  }

  async getExpiry(): Promise<string | null> {
    try {
      const currentToken = this.cache.get<string>("auth_token");
      if (!currentToken) {
        await this.getToken(false);
      }

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
          device_id: initialConfig.deviceId1,
          device_id2: initialConfig.deviceId2,
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
        })(),
      );

      if (profile && profile.js && profile.js.expire_billing_date) {
        return profile.js.expire_billing_date;
      }
      return null;
    } catch (e) {
      logger.error(`Failed to get expiry: ${e}`);
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
        })(),
      );

      if (typeof profile !== "object" || !profile.js) {
        throw new Error(
          "Profile refresh failed, invalid response. Likely auth failure.",
        );
      }

      if (profile.js.id || profile.js.uid) {
        this.uid = String(profile.js.id || profile.js.uid);
        logger.info(`[StalkerAPI] Set UID to: ${this.uid}`);
      }

      if (profile.js.blocked === 1 || profile.js.blocked === "1") {
        logger.error(`[StalkerAPI] Account is BLOCKED: ${profile.js.blocked}`);
        throw new Error("Subscription blocked by portal");
      }

      logger.info(`Expires on : ${profile.js.expire_billing_date}`);

      if (profile.js.status === 2 && secondAuth == 0) {
        await this.__refreshToken(1);
      } else {
        this.cache.ttl("auth_token", 3600);
      }
    } catch (error) {
      logger.error(
        `__refreshToken error: ${(error as AxiosError).message || error}`,
      );
      throw error;
    }
  }

  async makeRequest<T = any>(
    endpoint: string,
    params: Record<string, any> = {},
    isFetch = true,
  ): Promise<T> {
    this.lastRequestTime = Date.now();

    const cacheable = this.isCacheable(params);
    const cacheKey = this.getCacheKey(endpoint, params);

    if (cacheable) {
      const cached = this.cache.get<T>(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        return pending;
      }
    }

    const execute = async (): Promise<T> => {
      let attempts = 0;
      const maxAttempts = 2;

      while (attempts < maxAttempts) {
        attempts++;

        if (this.profileRefreshPromise) {
          logger.info(
            `[makeRequest] Waiting for ongoing auth before requesting ${endpoint} (attempt ${attempts})...`,
          );
          await this.profileRefreshPromise;
        }

        let token = this.cache.get<string>("auth_token");
        if (!token) {
          token = (await this.getToken(false)) || "";
        }

        const url = `${this.getBaseUrl()}${endpoint}`;

        try {
          const response = await requestLimit(async () => {
            return httpRequest(
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
              })(),
            );
          });

          if (
            (typeof response === "string" &&
              response.startsWith("Authorization failed.")) ||
            response === "Authorization failed."
          ) {
            logger.warn(
              `[StalkerAPI] Auth failed (portal message) for ${endpoint}. Attempt ${attempts}/${maxAttempts}`,
            );
            if (attempts < maxAttempts) {
              if (!this.profileRefreshPromise) {
                this.cache.del("auth_token");
                this.getToken(true).catch((err) =>
                  logger.error(`Token refresh failed: ${err}`),
                );
              }
              continue;
            }
            throw new Error("Authorization Failed.");
          }

          if (cacheable) {
            const ttl = this.getCacheTTL(params.action);
            this.cache.set(cacheKey, response, ttl);
          }
          return response;
        } catch (error: any) {
          const is401 = axios.isAxiosError(error) && error.response?.status === 401;
          if (is401) {
            logger.warn(
              `[StalkerAPI] HTTP 401 detected for ${endpoint}. Attempt ${attempts}/${maxAttempts}`,
            );
            if (attempts < maxAttempts) {
              if (!this.profileRefreshPromise) {
                this.cache.del("auth_token");
                await this.getToken(true);
              }
              continue;
            }
          }
          throw error;
        }
      }
      throw new Error("Request failed after maximum authorization attempts.");
    };

    if (cacheable) {
      const promise = execute().finally(() => {
        this.inFlight.delete(cacheKey);
      });
      this.inFlight.set(cacheKey, promise);
      return promise;
    }

    return execute();
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

  async getChannelLink(cmd: string, startTime?: number, endTime?: number) {
    const params: any = {
      type: "itv",
      action: "create_link",
      cmd,
      disable_ad: "0",
    };
    if (startTime && endTime) {
      params.start_time = startTime;
      params.end_time = endTime;
    }
    return this.makeRequest<Data<Program>>(
      this.getPhpUrl(),
      params,
      true,
    );
  }

  async getMoviesGroups() {
    return this.makeRequest<Data<Genre[]>>(this.getPhpUrl(), {
      type: "vod",
      action: "get_categories",
    });
  }

  async getMovies({
    category = "*",
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
    );
  }

  async getSeries({
    category = "*",
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
      type: "vod",
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
    );
  }

  async getMovieLink({
    series,
    id,
    download = 0,
    cmd,
  }: {
    series: string;
    id: number;
    download: number;
    cmd?: string;
  }) {
    const resolvedCmd = cmd || `/media/file_${id}.mpg`;
    const params = {
      type: "vod",
      action: "create_link",
      force_ch_link_check: "0",
      disable_ad: "0",
      download: 0,
      forced_storage: "",
      series: Number(series),
      cmd: resolvedCmd,
    };

    return this.makeRequest<Data<Programs<Video>>>(this.getPhpUrl(), params);
  }

  async getSeriesLink({
    series,
    id,
    download = 0,
    cmd,
  }: {
    series: string;
    id: number;
    download: number;
    cmd?: string;
  }) {
    const resolvedCmd = cmd || (initialConfig.contextPath === "" ? String(id) : `/media/file_${id}.mpg`);
    return this.makeRequest<Data<Programs<Video>>>(this.getPhpUrl(), {
      type: "vod",
      action: "create_link",
      force_ch_link_check: "0",
      disable_ad: "0",
      download,
      forced_stop_range: "",
      series: series,
      cmd: resolvedCmd,
    });
  }

  async getSeriesGroups() {
    return this.makeRequest<Data<Genre[]>>(this.getPhpUrl(), {
      type: "vod",
      action: "get_categories",
    });
  }

  async getEPG(channelId: string, date?: string) {
    if (date) {
      return this.makeRequest<any>(this.getPhpUrl(), {
        type: "itv",
        action: "get_epg",
        ch_id: channelId,
        date: date,
      });
    }
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
      logger.error(`Failed to save token to DB: ${err}`);
    }
  }

  async removeToken(token: string) {
    try {
      await Token.destroy({ where: { token } });
      initialConfig.tokens = initialConfig.tokens.filter((t) => t !== token);
    } catch (err) {
      logger.error(`Failed to remove token from DB: ${err}`);
    }
  }

  getActiveRequestCount() {
    return requestLimit.activeCount + requestLimit.pendingCount;
  }

  getLastRequestTime() {
    return this.lastRequestTime;
  }

  isIdle(thresholdMs: number = 30000) {
    return (
      this.getActiveRequestCount() === 0 &&
      Date.now() - this.lastRequestTime > thresholdMs
    );
  }
}

export const stalkerApi = new StalkerAPI();
