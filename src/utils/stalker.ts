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

const BASE_URL = `http://${initialConfig.hostname}:${initialConfig.port}/${initialConfig.contextPath}`;

export class StalkerAPI {
  private token: string = "";
  private random: string = "";
  private tokenExpiry: Date | null = null;
  private uid: string = "";
  private isProfileFetching: boolean = false;

  private getAxiosConfig(
    params: Record<string, any>,
    token: string
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
      },
      timeout: 10000,
      validateStatus: (status) => status === 200,
    };
  }

  // Helper delay function to pause execution for ms milliseconds
  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async authenticate(): Promise<string> {
    if (this.token != "") {
      return this.token;
    }

    try {
      console.log("Attempting authentication with Stalker Portal...");
      console.log("Config:", {
        hostname: initialConfig.hostname,
        mac: initialConfig.mac,
        stbType: initialConfig.stbType,
      });

      const response = await axios.get(`${BASE_URL}/server/load.php`, {
        params: {
          type: "stb",
          action: "handshake",
          mac: initialConfig.mac,
          device_id: initialConfig.deviceId1,
          device_id2: initialConfig.deviceId2,
          serial_number: initialConfig.serialNumber,
          stb_type: initialConfig.stbType,
          JsHttpRequest: "1-xml",
        },
        headers: {
          "User-Agent":
            "Mozilla/5.0 (STB) WebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.101 Safari/537.36",
          "X-User-Agent": "Model: MAG270; Link: WiFi",
          Cookie: `mac=${initialConfig.mac}; stb_lang=en; timezone=America/New_York`,
        },
        timeout: 15000,
      });

      console.log("Authentication response status:", response.status);
      console.log(
        "Authentication response data:",
        JSON.stringify(response.data, null, 2)
      );

      if (response.data && response.data.js && response.data.js.token) {
        this.token = response.data.js.token;
        this.random = response.data.js.random;
        this.tokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

        console.log(
          "Authentication successful, token obtained:",
          this.token.substring(0, 10) + "..."
        );

        return this.token;
      }

      throw new Error(
        `Authentication failed - Invalid response structure: ${JSON.stringify(
          response.data
        )}`
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Stalker authentication error:", {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message,
        });

        if (error.response?.status === 429) {
          throw new Error(
            "Rate limited by Stalker Portal - please try again later"
          );
        } else if (error.response?.status === 403) {
          throw new Error(
            "Access forbidden - invalid MAC address or device credentials"
          );
        }
      }

      console.error("Stalker authentication error:", error);
      throw error;
    }
  }

  async getProfile<T = any>() {
    try {
      this.isProfileFetching = true;
      const token = await this.authenticate();
      const res = await axios.get(
        `${BASE_URL}/server/load.php`,
        this.getAxiosConfig(
          {
            type: "stb",
            action: "get_profile",
            hd: 1,
            auth_second_step: 1,
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
            token,
          },
          token
        )
      );
      this.uid = res.data.js.id;
    } catch (e) {
      console.error("Failed to get Profile", (e as AxiosError).status);
      if ((e as AxiosError).status === 429) {
        await this.delay(5000);
      }
    } finally {
      this.isProfileFetching = false;
    }
  }

  async makeRequest<T = any>(
    endpoint: string,
    params: Record<string, any> = {},
    isFetch = true,
    loop = false
  ): Promise<T> {
    const token = await this.authenticate();
    const url = `${BASE_URL}${endpoint}`;
    try {
      const response = await axios.get(
        url,
        this.getAxiosConfig(
          { ...params, uid: this.uid, JsHttpRequest: "1-xml" },
          token
        )
      );
      console.log("Stalker API response status:", response.status);

      if (
        response.data === "Authorization failed." &&
        !loop &&
        !this.isProfileFetching
      ) {
        // Validate session via get_profile
        if (!isFetch) {
          this.getProfile();
          await this.delay(5000);
        } else {
          await this.getProfile();
        }
        // Wait before retrying
        return this.makeRequest(endpoint, params, isFetch, true);
      }
      if (response.data === "Authorization failed.") {
        throw new Error("Authorization Failed.");
      }

      return response.data;
    } catch (error: any) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.token = "";
        this.tokenExpiry = null;
        this.isProfileFetching = false;
      }
      throw error;
    }
  }

  async getChannelGroups() {
    return this.makeRequest<Data<Genre[]>>("/server/load.php", {
      type: "itv",
      action: "get_genres",
    });
  }

  async getChannels() {
    return this.makeRequest<Data<Programs<Channel>>>("/server/load.php", {
      type: "itv",
      action: "get_all_channels",
    });
  }

  async getChannelLink(cmd: string) {
    return this.makeRequest<Data<Program>>(
      "/server/load.php",
      {
        type: "itv",
        action: "create_link",
        cmd,
        force_ch_link_check: true,
        disable_ad: true,
      },
      false
    );
  }

  async getMoviesGroups() {
    return this.makeRequest<Data<Genre[]>>("/server/load.php", {
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
    return this.makeRequest<Data<Programs<Video>>>(
      "/server/load.php",
      {
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
      },
      disableProfile
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
    return this.makeRequest<Data<Programs<Video>>>("/server/load.php", {
      type: "vod",
      action: "create_link",
      force_ch_link_check: "0",
      disable_ad: "0",
      download,
      forced_stop_range: "",
      series: series,
      cmd: `/media/file_${id}.mpg`,
    });
  }

  async getSeriesGroups() {
    return this.makeRequest<Data<Genre[]>>("/server/load.php", {
      type: "series",
      action: "get_categories",
    });
  }

  async getEPG(channelId: string) {
    return this.makeRequest<ArrayData<EPG_List>>("/server/load.php", {
      type: "epg",
      action: "get_all_program_for_ch",
      ch_id: channelId,
    });
  }
}

export const stalkerApi = new StalkerAPI();
