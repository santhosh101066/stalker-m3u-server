import { fetchAndCacheEpg, getEpgCache } from "@/utils/epg";
import { serverManager } from "@/serverManager";
import { logger } from "@/utils/logger";

const EPG_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IDLE_THRESHOLD_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

class BackgroundJobService {
  private interval: NodeJS.Timeout | null = null;
  private isUpdatingEpg: boolean = false;

  start() {
    if (this.interval) return;

    logger.info("[BackgroundJobService] Starting background job service...");

    this.interval = setInterval(() => {
      this.runJobs();
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async runJobs() {
    const memory = process.memoryUsage().heapUsed / 1024 / 1024;
    logger.info(`[BackgroundJobService] Checking jobs... Current RAM: ${Math.round(memory)}MB`);
    try {
      console.time("EPG_FETCH_TIME");
      await this.checkAndUpdateEpg();
      console.timeEnd("EPG_FETCH_TIME");
    } catch (err) {
      logger.error(`[BackgroundJobService] Error running jobs: ${err}`);
    }
  }

  private async checkAndUpdateEpg() {
    if (this.isUpdatingEpg) {
      logger.warn("[BackgroundJobService] Previous EPG fetch still in progress. Skipping...");
      return;
    }

    const cache = await getEpgCache();
    const now = Date.now();

    const needsUpdate =
      !cache ||
      now - new Date(cache.timestamp).getTime() > EPG_UPDATE_INTERVAL_MS;

    if (needsUpdate) {
      if (serverManager.getProvider().isIdle(IDLE_THRESHOLD_MS)) {
        logger.info(
          "[BackgroundJobService] Server is idle and EPG needs update. Starting EPG fetch...",
        );
        this.isUpdatingEpg = true;
        try {
          await fetchAndCacheEpg();
          logger.info(
            "[BackgroundJobService] EPG update completed successfully.",
          );
        } catch (err) {
          logger.error(`[BackgroundJobService] Failed to update EPG: ${err}`);
        } finally {
          this.isUpdatingEpg = false;
        }
      } else {
        logger.debug(
          "[BackgroundJobService] EPG needs update but server is busy. Skipping for now.",
        );
      }
    }
  }
}

export const backgroundJobService = new BackgroundJobService();
