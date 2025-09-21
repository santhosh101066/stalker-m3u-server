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
import { writeFile, readFileSync, existsSync, unlinkSync, promises as fsPromises } from "fs";
import path from "path";

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
  } = { timeout: 10000 }
): Promise<T> {
  return axios
    .request<T>({
      url,
      params,
      method: options.method || "GET",
      headers: options.headers,
      timeout: options.timeout || 10000,
      validateStatus: (status) => status === 200,
    })
    .then((res) => res.data);
}
  

export class StalkerAPI {
  private token: string = "";
  private random: string = "";
  private tokenExpiry: Date | null = null;
  private uid: string = "";
  private isProfileFetching: boolean = false;
  private signature: string = "";
  private not_valid_token: number = 0;

  private __token: { value: string | null } = { value: null };
  private __tokenPath: string = path.join(process.cwd(), "token.json");
  private watchdogInterval: NodeJS.Timeout | null = null;
  private watchdogStarted: boolean = false;

  constructor() {
    // this.__loadCache();
  }
  getBaseUrl() {
    return `http://${initialConfig.hostname}:${initialConfig.port}${initialConfig.contextPath != "" ? `/${initialConfig.contextPath}` : ""
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
    

    const runWatchdogCheck = async (init = false) => {
      try {
        if (!this.__token.value) {
          this.__token.value = await this.getToken(false);
        }

        const res = await axios.get(
          `${this.getBaseUrl()}${this.getPhpUrl()}`,
          this._getAxiosRequestConfig(
            {
              type: "watchdog",
              action: "get_events",
              init,
              cur_play_type: "1",
              event_active_id: "0",
              JsHttpRequest: "1-xml",
            },
            this.__token.value!,
            {
              validateStatus: (status) => status === 200,
              withCredentials: true,
              contentType: "application/json",
            }
          )
        );

        

        this.handleWatchdogEvents(res.data);
      } catch (err) {
        console.error("Watchdog error:", err);
      }
    };

    await runWatchdogCheck(true);

    this.watchdogInterval = setInterval(() => {
      runWatchdogCheck();
    }, interval * 1000);
  }

  stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
      
    }
  }
  private handleWatchdogEvents(data: any) {
    if (!data || !data.event) {
      return;
    }

    

    switch (data.event) {
      case "reboot":
        console.warn("Watchdog event: reboot required.");
        break;
      case "reload_portal":
        console.warn("Watchdog event: reload portal.");
        break;
      case "send_msg":
        
        break;
      case "update_channels":
        
        break;
      case "update_epg":
        console.log("Watchdog: EPG update requested...");
        break;
      default:
        console.log("Unhandled watchdog event:", data.event);
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

  // Helper delay function to pause execution for ms milliseconds
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
        const config = this._getAxiosRequestConfig({}, token, { referrer: this.getBaseUrl() });
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
      await this.__loadCache();

      // Check if token exists and is not expired
      if (this.__token.value && this.tokenExpiry && this.tokenExpiry.getTime() > Date.now() + 5 * 60 * 1000) { // 5 minutes buffer
        return this.__token.value;
      }

      if (this.__token.value && refreshToken) {
        await this.__refreshToken();
        return this.__token.value;
      }

      if (!this.__token.value) {
        this.clearCache();

        const response: any = await this.performHandshake();
        
        if (response?.js?.token) {
          this.__token.value = response.js.token;
          this.random = response.js.random;
          this.tokenExpiry = new Date(Date.now() + 3600000); // Token valid for 1 hour
          await this.__refreshToken();
          this.__saveCache();
          return this.__token.value;
        } else {
          throw new Error("Authentication failed - Invalid response structure");
        }
      }

      return this.__token.value;
    } catch (error) {
      console.error("getToken error:", error);
      throw error;
    }
  }

  clearCache() {
    this.__token.value = null;
    if (existsSync(this.__tokenPath)) {
      try {
        fsPromises.unlink(this.__tokenPath);
      } catch (err) {
        console.error("Failed to delete token cache file:", err);
      }
    }
  }

  private async __refreshToken(secondAuth = 0) {
    if (!this.__token.value) {
      throw new Error("No token to refresh");
    }
    try {
      this.stopWatchdog();
      const profile = await httpRequest(`${this.getBaseUrl()}${this.getPhpUrl()}`,
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
          token: this.__token.value,
          JsHttpRequest: "1-xml",
        },
        (() => {
          const config = this._getAxiosRequestConfig({}, this.__token.value!, { referrer: this.getBaseUrl() });
          return {
            method: config.method,
            headers: config.headers as Record<string, string>,
            timeout: config.timeout,
          };
        })()
      );
      console.log("Expires on : ", profile.js?.expire_billing_date);
      if (profile !== "Authorization failed.") {
        // this.startWatchdog(profile.js.watchdog_timeout);
      }
      if (profile.js?.status === 2 && secondAuth == 0) {
        await this.__refreshToken(1);
      }
      // await axios.get(
      //   `${BASE_URL}/server/load.php`,
      //   this.getAxiosConfig(
      //     {
      //       type: "watchdog",
      //       action: "get_events",
      //       init: "0",
      //       cur_play_type: "1",
      //       event_active_id: "0",
      //       JsHttpRequest: "1-xml",
      //     },
      //     this.__token.value
      //   )
      // );
    } catch (error) {
      console.error("__refreshToken error:", (error as AxiosError).message || error);
      throw error;
    }
  }

  private async __loadCache() {
    if (existsSync(this.__tokenPath)) {
      try {
        const data = await fsPromises.readFile(this.__tokenPath, "utf-8");
        const json = JSON.parse(data);
        if (json.token) {
          this.__token.value = json.token;
        }
      } catch (err) {
        console.error("Failed to load token cache:", err);
      }
    }
  }

  private async __saveCache() {
    try {
      await fsPromises.writeFile(
        this.__tokenPath,
        JSON.stringify({ token: this.__token.value }, null, 2)
      );
    } catch (err) {
      console.error("Failed to save token cache:", err);
    }
  }



  async makeRequest<T = any>(
    endpoint: string,
    params: Record<string, any> = {},
    isFetch = true,
    loop = false
  ): Promise<T> {
    if (!this.__token.value) {
      this.__token.value = await this.getToken(false);
    }
    const url = `${this.getBaseUrl()}${endpoint}`;
    try {
      const response = await httpRequest(
        url, { ...params, uid: this.uid, JsHttpRequest: "1-xml" },
        (() => {
          const config = this._getAxiosRequestConfig({}, this.__token.value ?? "", { referrer: this.getBaseUrl() });
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

        this.__token.value = await this.getToken(true);
        // if (!isFetch) {
        //   this.getProfile(this.__token.value);
        //   await this.delay(5000);
        // } else {
        //   await this.getProfile(this.__token.value);
        // }
        return this.makeRequest(endpoint, params, isFetch, true);
      }
      if (response === "Authorization failed.") {
        throw new Error("Authorization Failed.");
      }
      
      return response;
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.__token.value = null;
        this.tokenExpiry = null;
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
        // force_ch_link_check: "1",
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
        ...others
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
    }

    return this.makeRequest<Data<Programs<Video>>>("/server/load.php", params);
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
      fsPromises.writeFile(configPath, JSON.stringify(initialConfig, null, 2)).catch((err) => {
        console.error("Failed to save config:", err);
      });
    }
  }

  removeToken(token: string) {
    if (initialConfig.tokens.includes(token)) {
      initialConfig.tokens = initialConfig.tokens.filter((t) => t !== token);
      const configPath = path.join(process.cwd(), "config.json");
      fsPromises.writeFile(configPath, JSON.stringify(initialConfig, null, 2)).catch((err) => {
        if (err) {
          console.error("Failed to save config:", err);
        }
      });
    }
  }
}

export const stalkerApi = new StalkerAPI();
