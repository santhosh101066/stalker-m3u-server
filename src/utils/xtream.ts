import { initialConfig } from "@/config/server";
import axios from "axios";
import pLimit from "p-limit";

// Limit concurrent requests to prevent server blocking
const requestLimit = pLimit(5);

export class XtreamAPI {
  constructor() {}

  /**
   * Helper to construct the base URL.
   * Xtream Codes usually runs on the root, e.g. http://host:port/player_api.php
   */
  private getBaseUrl() {
    const protocol = "http"; // or https if configured
    return `${protocol}://${initialConfig.hostname}:${initialConfig.port}`;
  }

  /**
   * Generic request handler for Xtream Codes
   */
  async makeRequest<T = any>(
    action: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    return requestLimit(async () => {
      try {
        // --- KEY CHANGE: Read credentials from active config on every request ---
        const { username, password } = initialConfig;

        if (!username || !password) {
            // Optional: Throw error if trying to use Xtream without credentials
            // throw new Error("Xtream credentials (username/password) are missing.");
        }

        const response = await axios.get(`${this.getBaseUrl()}/player_api.php`, {
          params: {
            username,
            password,
            action,
            ...params,
          },
          timeout: 30000, // 30s timeout
        });

        return response.data;
      } catch (error) {
        console.error(`[XtreamAPI] Error performing action '${action}':`, error);
        throw error;
      }
    });
  }

  // --- Authentication ---

  async authenticate() {
    return requestLimit(async () => {
        try {
            const { username, password } = initialConfig;
            const response = await axios.get(`${this.getBaseUrl()}/player_api.php`, {
                params: {
                    username,
                    password,
                }
            });
            return response.data;
        } catch (error) {
            console.error("[XtreamAPI] Auth failed", error);
            throw error;
        }
    });
  }

  // --- Live TV ---

  async getLiveCategories() {
    return this.makeRequest("get_live_categories");
  }

  async getLiveStreams(categoryId?: string | number) {
    const params: Record<string, any> = {};
    if (categoryId) params.category_id = categoryId;
    return this.makeRequest("get_live_streams", params);
  }

  // --- VOD (Movies) ---

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

  // --- Series ---

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

  // --- EPG ---
  
  async getShortEpg(streamId: string | number, limit = 10) {
    return this.makeRequest("get_short_epg", { stream_id: streamId, limit });
  }

  async getAllEpg() {
      const { username, password } = initialConfig;
      return `${this.getBaseUrl()}/xmltv.php?username=${username}&password=${password}`;
  }
}

export const xtreamApi = new XtreamAPI();