import { Channel } from "../models/Channel";
import { Genre, GenreType } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { Op } from "sequelize";

// Backward compatible functions that maintain the same signature
export async function writeJSON(filename: string, data: any) {
  try {
    if (filename === "channel-groups.json") {
      await writeGenres(data, "channel");
    } else if (filename === "channels.json") {
      await writeChannels(data);
    } else if (filename === "movie-groups.json") {
      await writeGenres(data, "movie");
    } else if (filename === "series-groups.json") {
      await writeGenres(data, "series");
    } else if (filename === "epg-cache.json") {
      // EPG cache is stored as array with single object
      if (Array.isArray(data) && data.length > 0) {
        await writeEpgCache(data[0]);
      }
    }
  } catch (error) {
    console.error(`Error writing to database (${filename}):`, error);
    throw error;
  }
}

export function readJSON<T>(filename: string): T[] {
  // This function is now async but we need to maintain backward compatibility
  // We'll handle this by making the routes async
  throw new Error(
    "readJSON is deprecated. Use readChannels, readGenres, or readEpgCache instead."
  );
}

// New database-specific functions
export async function writeChannels(
  channels: any[],
  profileId?: number
): Promise<void> {
  try {
    // Delete existing channels for this profile only if profileId is provided
    if (profileId !== undefined) {
      await Channel.destroy({ where: { profileId } });
    }

    // Insert new channels (profileId will be null when undefined)
    const channelsToInsert = channels.map((channel) => ({
      ...channel,
      profileId: profileId !== undefined ? profileId : null,
    }));

    await Channel.bulkCreate(channelsToInsert, {
      updateOnDuplicate: ["name", "cmd", "logo", "tv_genre_id", "censored", "number", "profileId"],
    });
  } catch (error) {
    console.error("Error writing channels to database:", error);
    throw error;
  }
}

export async function readChannels(profileId?: number): Promise<any[]> {
  try {
    const channels = await Channel.findAll({
      where: profileId !== undefined ? { profileId } : {},
      raw: true,
    });
    return channels;
  } catch (error) {
    console.error("Error reading channels from database:", error);
    return [];
  }
}

export async function writeGenres(
  genres: any[],
  type: GenreType,
  profileId?: number
): Promise<void> {
  try {
    // Delete existing genres of this type for this profile
    if (profileId !== undefined) {
      await Genre.destroy({
        where: { type, profileId },
      });
    } else {
      await Genre.destroy({ where: { type } });
    }

    // Insert new genres
    const genresToInsert = genres.map((genre) => ({
      ...genre,
      id: `${type}_${genre.id}`, // Prefix ID with type to avoid collision
      type,
      profileId: profileId !== undefined ? profileId : null,
    }));

    await Genre.bulkCreate(genresToInsert, {
      updateOnDuplicate: ["title", "number", "alias", "censored", "type", "profileId"],
    });
  } catch (error) {
    console.error(`Error writing ${type} genres to database:`, error);
    throw error;
  }
}

export async function readGenres(
  type: GenreType,
  profileId?: number
): Promise<any[]> {
  try {
    const genres = await Genre.findAll({
      where: {
        type,
        ...(profileId !== undefined ? { profileId } : {}),
      },
      raw: true,
    });
    // Strip the prefix when reading back so the app sees original IDs
    return genres.map(g => ({
      ...g,
      id: g.id.replace(`${type}_`, '')
    }));
  } catch (error) {
    console.error(`Error reading ${type} genres from database:`, error);
    return [];
  }
}

export async function writeEpgCache(
  cacheData: { timestamp: Date; data: any },
  profileId?: number
): Promise<void> {
  try {
    // Delete existing EPG cache for this profile only if profileId is provided
    if (profileId !== undefined) {
      await EpgCache.destroy({ where: { profileId } });
    }

    // Insert new EPG cache
    await EpgCache.create({
      timestamp: cacheData.timestamp,
      data: JSON.stringify(cacheData.data),
      profileId: profileId !== undefined ? profileId : null,
    });
  } catch (error) {
    console.error("Error writing EPG cache to database:", error);
    throw error;
  }
}

export async function readEpgCache(profileId?: number): Promise<any | null> {
  try {
    const cache = await EpgCache.findOne({
      where: profileId !== undefined ? { profileId } : {},
      order: [["timestamp", "DESC"]],
    });

    if (!cache) return null;

    return {
      timestamp: cache.timestamp,
      data: JSON.parse(cache.data),
    };
  } catch (error) {
    console.error("Error reading EPG cache from database:", error);
    return null;
  }
}