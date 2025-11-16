import { readJSON, writeJSON } from "./storage";
import { stalkerApi } from "./stalker";
import { Channel, EPG_List, Genre } from "@/types/types";
import { initialConfig } from "@/config/server";

const EPG_CACHE_FILE = "epg-cache.json";
const CACHE_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

interface EpgCache {
  timestamp: number;
  data: Record<string, EPG_List[]>;
}

/**
 * Reads the EPG cache from disk.
 * Returns null if the cache is stale or does not exist.
 */
export async function getEpgCache(): Promise<EpgCache | null> {
  try {
    const cache = readJSON<EpgCache>(EPG_CACHE_FILE)[0]; // readJSON returns T[]
    if (!cache) {
      return null;
    }

    const isStale = Date.now() - cache.timestamp > CACHE_DURATION_MS;
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
 * Fetches EPG for all filtered channels and writes to cache.
 */
export async function fetchAndCacheEpg(): Promise<EpgCache> {
  console.log("Fetching fresh EPG data...");
  const channels = readJSON<Channel>("channels.json");
  const genres = readJSON<Genre>("channel-groups.json");

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
    timestamp: Date.now(),
    data: epgData,
  };

  // Write to cache (readJSON expects an array)
  try {
    writeJSON(EPG_CACHE_FILE, [cache]);
  } catch (error) {
    console.error("Failed to write EPG cache:", error);
  }

  console.log(`EPG cache updated with data for ${results.length} channels.`);
  return cache;
}