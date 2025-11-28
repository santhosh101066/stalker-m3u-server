import { readChannels, readGenres, readEpgCache, writeEpgCache } from "./storage";
import { stalkerApi } from "./stalker";
import { Channel, EPG_List, Genre } from "@/types/types";
import { initialConfig } from "@/config/server";
import { ConfigProfile } from "@/models/ConfigProfile"; // Import ConfigProfile

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

interface EpgCache {
  timestamp: Date;
  data: Record<string, EPG_List[]>;
}

/**
 * Reads the EPG cache from database for the active profile.
 * Returns null if the cache is stale or does not exist.
 */
export async function getEpgCache(): Promise<EpgCache | null> {
  try {
    // --- NEW: Get Active Profile ID ---
    const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
    const profileId = activeProfile?.id;
    // ----------------------------------

    const cache = await readEpgCache(profileId); // Pass profileId
    if (!cache) {
      return null;
    }

    const isStale = Date.now() - new Date(cache.timestamp).getTime() > CACHE_DURATION_MS;
    if (isStale) {
      return null;
    }
    return cache;
  } catch (error) {
    console.warn("Could not read EPG cache:", error);
    return null;
  }
}

/**
 * Fetches EPG for all filtered channels and writes to cache for the active profile.
 */
export async function fetchAndCacheEpg(): Promise<EpgCache> {
  console.log("Fetching fresh EPG data...");
  
  // --- NEW: Get Active Profile ID ---
  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;
  // ----------------------------------

  // Pass profileId to reads
  const channels = await readChannels(profileId); 
  const genres = await readGenres("channel", profileId);

  // Filter channels based on the user's config
  const filteredChannels = channels.filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    return genre && initialConfig.groups.includes(genre.title);
  });

  // Fetch EPG for all filtered channels in parallel
  const promises = filteredChannels.map((channel) =>
    stalkerApi.getEPG(channel.id).then(
      (epg) => ({
        id: channel.id,
        epg: epg.js || [], // Ensure epg.js is an array
      }),
      (error) => {
        console.error(`Failed to fetch EPG for channel ${channel.id}:`, error);
        return {
          id: channel.id,
          epg: [], // Return empty array on failure for this channel
        };
      }
    )
  );

  const results = await Promise.all(promises);

  // Consolidate into a map of { channelId: epgArray }
  const epgData = results.reduce<Record<string, EPG_List[]>>((acc, curr) => {
    acc[curr.id] = curr.epg;
    return acc;
  }, {});

  const cache: EpgCache = {
    timestamp: new Date(),
    data: epgData,
  };

  // Write to cache with profileId
  try {
    await writeEpgCache(cache, profileId);
  } catch (error) {
    console.error("Failed to write EPG cache:", error);
  }

  console.log(`EPG cache updated with data for ${results.length} channels.`);
  return cache;
}