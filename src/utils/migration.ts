import fs from "fs";
import path from "path";
import { writeChannels, writeGenres, writeEpgCache } from "./storage";
import { ConfigProfile } from "../models/ConfigProfile"; // Import ConfigProfile

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
        // Read channels
        const channelsPath = path.join(MEM_PATH, "channels.json");
        if (fs.existsSync(channelsPath)) {
            data.channels = JSON.parse(fs.readFileSync(channelsPath, "utf-8"));
            console.log(`Found ${data.channels!.length} channels`);
        }

        // Read channel groups
        const channelGroupsPath = path.join(MEM_PATH, "channel-groups.json");
        if (fs.existsSync(channelGroupsPath)) {
            data.channelGroups = JSON.parse(
                fs.readFileSync(channelGroupsPath, "utf-8")
            );
            console.log(`Found ${data.channelGroups!.length} channel groups`);
        }

        // Read movie groups
        const movieGroupsPath = path.join(MEM_PATH, "movie-groups.json");
        if (fs.existsSync(movieGroupsPath)) {
            data.movieGroups = JSON.parse(fs.readFileSync(movieGroupsPath, "utf-8"));
            console.log(`Found ${data.movieGroups!.length} movie groups`);
        }

        // Read series groups
        const seriesGroupsPath = path.join(MEM_PATH, "series-groups.json");
        if (fs.existsSync(seriesGroupsPath)) {
            data.seriesGroups = JSON.parse(
                fs.readFileSync(seriesGroupsPath, "utf-8")
            );
            console.log(`Found ${data.seriesGroups!.length} series groups`);
        }

        // Read EPG cache
        const epgCachePath = path.join(MEM_PATH, "epg-cache.json");
        if (fs.existsSync(epgCachePath)) {
            const epgArray = JSON.parse(fs.readFileSync(epgCachePath, "utf-8"));
            if (Array.isArray(epgArray) && epgArray.length > 0) {
                const epgData = epgArray[0];
                data.epgCache = {
                    timestamp: new Date(epgData.timestamp),
                    data: epgData.data,
                };
                console.log(`Found EPG cache with timestamp ${data.epgCache.timestamp}`);
            }
        }
    } catch (error) {
        console.error("Error reading JSON files:", error);
    }

    return data;
}

/**
 * Migrates JSON data to database
 */
export async function migrateJsonToDatabase(): Promise<void> {
    console.log("Starting migration from JSON files to database...");

    if (!fs.existsSync(MEM_PATH)) {
        console.log("No .mem folder found. Skipping migration.");
        return;
    }

    const data = readJsonFiles();
    let migrated = 0;

    try {
        // --- NEW: Get the Active Profile ID ---
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
        // If no active profile, try to find ANY profile (fallback)
        const targetProfile = activeProfile || await ConfigProfile.findOne();
        const profileId = targetProfile?.id;

        if (!profileId) {
            console.warn("⚠️ No profile found in database. Data will be saved with profileId = NULL.");
        } else {
            console.log(`Using Profile ID: ${profileId} (${targetProfile.name})`);
        }
        // --------------------------------------

        // Migrate channels
        if (data.channels && data.channels.length > 0) {
            console.log("Migrating channels...");
            await writeChannels(data.channels, profileId);
            migrated++;
            console.log("✓ Channels migrated successfully");
        }

        // Migrate channel groups
        if (data.channelGroups && data.channelGroups.length > 0) {
            console.log("Migrating channel groups...");
            await writeGenres(data.channelGroups, "channel", profileId);
            migrated++;
            console.log("✓ Channel groups migrated successfully");
        }

        // Migrate movie groups
        if (data.movieGroups && data.movieGroups.length > 0) {
            console.log("Migrating movie groups...");
            await writeGenres(data.movieGroups, "movie", profileId);
            migrated++;
            console.log("✓ Movie groups migrated successfully");
        }

        // Migrate series groups
        if (data.seriesGroups && data.seriesGroups.length > 0) {
            console.log("Migrating series groups...");
            await writeGenres(data.seriesGroups, "series", profileId);
            migrated++;
            console.log("✓ Series groups migrated successfully");
        }

        // Migrate EPG cache
        if (data.epgCache) {
            console.log("Migrating EPG cache...");
            await writeEpgCache(data.epgCache, profileId);
            migrated++;
            console.log("✓ EPG cache migrated successfully");
        }

        if (migrated === 0) {
            console.log("No data found to migrate.");
        } else {
            console.log(`\n✓ Migration completed! ${migrated} data types migrated.`);
            console.log(
                "\nYou can now safely delete the .mem folder if you wish."
            );
        }
    } catch (error) {
        console.error("Migration failed:", error);
        throw error;
    }
}

/**
 * CLI entry point for running migration manually
 */
if (require.main === module) {
    (async () => {
        try {
            // Import database initialization
            const { initDB } = await import("../db");
            await initDB();
            await migrateJsonToDatabase();
            process.exit(0);
        } catch (error) {
            console.error("Migration script failed:", error);
            process.exit(1);
        }
    })();
}