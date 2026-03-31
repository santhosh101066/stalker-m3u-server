import {
  readChannels,
  readGenres,
  readEpgCache,
  writeEpgCache,
} from "./storage";
import { serverManager } from "@/serverManager";
import { Channel, EPG_List, Genre } from "@/types/types";
import { initialConfig } from "@/config/server";
import { ConfigProfile } from "@/models/ConfigProfile";

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000;

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
    const activeProfile = await ConfigProfile.findOne({
      where: { isActive: true },
    });
    const profileId = activeProfile?.id;

    const cache = await readEpgCache(profileId);
    if (!cache) {
      return null;
    }

    const isStale =
      Date.now() - new Date(cache.timestamp).getTime() > CACHE_DURATION_MS;
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

  const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
  const profileId = activeProfile?.id;

  const [channels, genres] = await Promise.all([
    readChannels(profileId),
    readGenres("channel", profileId)
  ]);

  // FIX 1: Use a Map for O(1) lookup instead of .find() inside .filter()
  const genreMap = new Map(genres.map(g => [g.id, g.title]));
  const groupSet = new Set(initialConfig.groups);

  const filteredChannels = channels.filter((channel) => {
    const genreTitle = genreMap.get(channel.tv_genre_id);
    return genreTitle && groupSet.has(genreTitle);
  });

  const CONCURRENCY_LIMIT = 5; // Reduced slightly to give CPU breathing room
  const epgData: Record<string, EPG_List[]> = {}; // Directly push to final object

  console.log(`Starting EPG fetch for ${filteredChannels.length} channels...`);

  for (let i = 0; i < filteredChannels.length; i += CONCURRENCY_LIMIT) {
    const chunk = filteredChannels.slice(i, i + CONCURRENCY_LIMIT);

    const chunkResults = await Promise.all(
      chunk.map(async (channel) => {
        try {
          const epg = await serverManager.getProvider().getEPG(channel.id);
          return { id: channel.id, epg: epg.js || [] };
        } catch (error) {
          console.error(`Error for ${channel.id}:`, error);
          return { id: channel.id, epg: [] };
        }
      })
    );

    // FIX 2: Merge results into epgData immediately
    for (const res of chunkResults) {
      epgData[res.id] = res.epg;
    }

    // FIX 3: THE MAGIC STICK - Yield control back to Event Loop
    await new Promise(resolve => setImmediate(resolve));
    
    if (i + CONCURRENCY_LIMIT < filteredChannels.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const cache: EpgCache = { timestamp: new Date(), data: epgData };
  await writeEpgCache(cache, profileId);

  console.log("EPG cache updated.");
  return cache;
}