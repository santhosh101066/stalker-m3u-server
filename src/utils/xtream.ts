import { initialConfig } from "@/config/server";
import axios from "axios";
import pLimit from "p-limit";

const requestLimit = pLimit(5);

export class XtreamAPI {
  constructor() {}

  /**
   * Helper to construct the base URL.
   * Xtream Codes usually runs on the root, e.g. http://host:port/player_api.php
   */
  private getBaseUrl() {
    const protocol = "http";
    return `${protocol}://${initialConfig.hostname}:${initialConfig.port}`;
  }

  /**
   * Generic request handler for Xtream Codes
   */
  async makeRequest<T = any>(
    action: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    return requestLimit(async () => {
      try {
        const { username, password } = initialConfig;

        if (!username || !password) {
        }

        const response = await axios.get(
          `${this.getBaseUrl()}/player_api.php`,
          {
            params: {
              username,
              password,
              action,
              ...params,
            },
            timeout: 30000,
          },
        );

        return response.data;
      } catch (error) {
        console.error(
          `[XtreamAPI] Error performing action '${action}':`,
          error,
        );
        throw error;
      }
    });
  }

  async authenticate() {
    return requestLimit(async () => {
      try {
        const { username, password } = initialConfig;
        const response = await axios.get(
          `${this.getBaseUrl()}/player_api.php`,
          {
            params: {
              username,
              password,
            },
          },
        );
        return response.data;
      } catch (error) {
        console.error("[XtreamAPI] Auth failed", error);
        throw error;
      }
    });
  }

  async getLiveCategories() {
    return this.makeRequest("get_live_categories");
  }

  async getLiveStreams(categoryId?: string | number) {
    const params: Record<string, any> = {};
    if (categoryId) params.category_id = categoryId;
    return this.makeRequest("get_live_streams", params);
  }

  async getVodCategories() {
    return this.makeRequest("get_vod_categories");
  }

  async getVodStreams(categoryId?: string | number) {
    const params: Record<string, any> = {};
    if (categoryId) params.category_id = categoryId;
    return this.makeRequest("get_vod_streams", params);
  }

  async getVodInfo(vodId: string | number) {
    return this.makeRequest("get_vod_info", { vod_id: vodId });
  }

  async getSeriesCategories() {
    return this.makeRequest("get_series_categories");
  }

  async getSeries(categoryId?: string | number) {
    const params: Record<string, any> = {};
    if (categoryId) params.category_id = categoryId;
    return this.makeRequest("get_series", params);
  }

  async getSeriesInfo(seriesId: string | number) {
    return this.makeRequest("get_series_info", { series_id: seriesId });
  }

  async getShortEpg(streamId: string | number, limit = 10) {
    return this.makeRequest("get_short_epg", { stream_id: streamId, limit });
  }

  async getAllEpg() {
    const { username, password } = initialConfig;
    return `${this.getBaseUrl()}/xmltv.php?username=${username}&password=${password}`;
  }
}

export const xtreamApi = new XtreamAPI();
