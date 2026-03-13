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

  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  const profileId = activeProfile?.id;

  const channels = await readChannels(profileId);
  const genres = await readGenres("channel", profileId);

  const filteredChannels = channels.filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    return genre && initialConfig.groups.includes(genre.title);
  });

  const CONCURRENCY_LIMIT = 10;
  const DELAY_BETWEEN_CHUNKS = 1000;
  const results: { id: string; epg: EPG_List[] }[] = [];

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  console.log(
    `Starting EPG fetch for ${filteredChannels.length} channels in batches of ${CONCURRENCY_LIMIT}...`,
  );

  for (let i = 0; i < filteredChannels.length; i += CONCURRENCY_LIMIT) {
    const chunk = filteredChannels.slice(i, i + CONCURRENCY_LIMIT);

    const chunkPromises = chunk.map((channel) =>
      serverManager
        .getProvider()
        .getEPG(channel.id)
        .then(
          (epg) => ({
            id: channel.id,
            epg: epg.js || [],
          }),
          (error) => {
            console.error(
              `Failed to fetch EPG for channel ${channel.id}:`,
              error.message || error,
            );
            return {
              id: channel.id,
              epg: [],
            };
          },
        ),
    );

    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);

    if (i + CONCURRENCY_LIMIT < filteredChannels.length) {
      await delay(DELAY_BETWEEN_CHUNKS);
    }
  }

  const epgData = results.reduce<Record<string, EPG_List[]>>((acc, curr) => {
    acc[curr.id] = curr.epg;
    return acc;
  }, {});

  const cache: EpgCache = {
    timestamp: new Date(),
    data: epgData,
  };

  try {
    await writeEpgCache(cache, profileId);
  } catch (error) {
    console.error("Failed to write EPG cache:", error);
  }

  console.log(`EPG cache updated with data for ${results.length} channels.`);
  return cache;
}
