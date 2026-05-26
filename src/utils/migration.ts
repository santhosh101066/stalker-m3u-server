import fs from "fs";
import path from "path";
import { writeChannels, writeGenres, writeEpgCache } from "./storage";
import { ConfigProfile } from "../models/ConfigProfile";
import { logger } from "@/utils/logger";

const MEM_PATH = path.resolve(__dirname, "../../.mem");

interface JsonData {
  channels?: any[];
  channelGroups?: any[];
  movieGroups?: any[];
  seriesGroups?: any[];
  epgCache?: { timestamp: Date; data: any };
}

/**
 * Reads JSON files from .mem folder
 */
function readJsonFiles(): JsonData {
  const data: JsonData = {};

  try {
    const channelsPath = path.join(MEM_PATH, "channels.json");
    if (fs.existsSync(channelsPath)) {
      data.channels = JSON.parse(fs.readFileSync(channelsPath, "utf-8"));
      logger.info(`Found ${data.channels!.length} channels`);
    }

    const channelGroupsPath = path.join(MEM_PATH, "channel-groups.json");
    if (fs.existsSync(channelGroupsPath)) {
      data.channelGroups = JSON.parse(
        fs.readFileSync(channelGroupsPath, "utf-8"),
      );
      logger.info(`Found ${data.channelGroups!.length} channel groups`);
    }

    const movieGroupsPath = path.join(MEM_PATH, "movie-groups.json");
    if (fs.existsSync(movieGroupsPath)) {
      data.movieGroups = JSON.parse(fs.readFileSync(movieGroupsPath, "utf-8"));
      logger.info(`Found ${data.movieGroups!.length} movie groups`);
    }

    const seriesGroupsPath = path.join(MEM_PATH, "series-groups.json");
    if (fs.existsSync(seriesGroupsPath)) {
      data.seriesGroups = JSON.parse(
        fs.readFileSync(seriesGroupsPath, "utf-8"),
      );
      logger.info(`Found ${data.seriesGroups!.length} series groups`);
    }

    const epgCachePath = path.join(MEM_PATH, "epg-cache.json");
    if (fs.existsSync(epgCachePath)) {
      const epgArray = JSON.parse(fs.readFileSync(epgCachePath, "utf-8"));
      if (Array.isArray(epgArray) && epgArray.length > 0) {
        const epgData = epgArray[0];
        data.epgCache = {
          timestamp: new Date(epgData.timestamp),
          data: epgData.data,
        };
        logger.info(
          `Found EPG cache with timestamp ${data.epgCache.timestamp}`,
        );
      }
    }
  } catch (error: any) {
    logger.error("Error reading JSON files:", error);
  }

  return data;
}

/**
 * Migrates JSON data to database
 */
export async function migrateJsonToDatabase(): Promise<void> {
  logger.info("Starting migration from JSON files to database...");

  if (!fs.existsSync(MEM_PATH)) {
    logger.info("No .mem folder found. Skipping migration.");
    return;
  }

  const data = readJsonFiles();
  let migrated = 0;

  try {
    const activeProfile = await ConfigProfile.findOne({
      where: { isActive: true },
    });

    const targetProfile = activeProfile || (await ConfigProfile.findOne());
    const profileId = targetProfile?.id;

    if (!profileId) {
      logger.warn(
        "⚠️ No profile found in database. Data will be saved with profileId = NULL.",
      );
    } else {
      logger.info(`Using Profile ID: ${profileId} (${targetProfile.name})`);
    }

    if (data.channels && data.channels.length > 0) {
      logger.info("Migrating channels...");
      await writeChannels(data.channels, profileId);
      migrated++;
      logger.info("✓ Channels migrated successfully");
    }

    if (data.channelGroups && data.channelGroups.length > 0) {
      logger.info("Migrating channel groups...");
      await writeGenres(data.channelGroups, "channel", profileId);
      migrated++;
      logger.info("✓ Channel groups migrated successfully");
    }

    if (data.movieGroups && data.movieGroups.length > 0) {
      logger.info("Migrating movie groups...");
      await writeGenres(data.movieGroups, "movie", profileId);
      migrated++;
      logger.info("✓ Movie groups migrated successfully");
    }

    if (data.seriesGroups && data.seriesGroups.length > 0) {
      logger.info("Migrating series groups...");
      await writeGenres(data.seriesGroups, "series", profileId);
      migrated++;
      logger.info("✓ Series groups migrated successfully");
    }

    if (data.epgCache) {
      logger.info("Migrating EPG cache...");
      await writeEpgCache(data.epgCache, profileId);
      migrated++;
      logger.info("✓ EPG cache migrated successfully");
    }

    if (migrated === 0) {
      logger.info("No data found to migrate.");
    } else {
      logger.info(`\n✓ Migration completed! ${migrated} data types migrated.`);
      logger.info("\nYou can now safely delete the .mem folder if you wish.");
    }
  } catch (error: any) {
    logger.error("Migration failed:", error);
    throw error;
  }
}

/**
 * CLI entry point for running migration manually
 */
if (require.main === module) {
  (async () => {
    try {
      const { initDB } = await import("../db");
      await initDB();
      await migrateJsonToDatabase();
      process.exit(0);
    } catch (error: any) {
      logger.error("Migration script failed:", error);
      process.exit(1);
    }
  })();
}
