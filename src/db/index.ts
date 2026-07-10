import fs from "fs";
import { Sequelize } from "sequelize-typescript";
import path from "path";
import { Token } from "../models/Token";
import { SystemConfig } from "../models/SystemConfig";
import { ConfigProfile } from "../models/ConfigProfile";
import { Channel } from "../models/Channel";
import { Genre } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { XtreamCache } from "../models/XtreamCache";
import { GenreOverride } from "../models/GenreOverride";
import { ContentOverride } from "../models/ContentOverride";
import { StrmMovie } from "../models/StrmMovie";
import { StrmSeries } from "../models/StrmSeries";
import { User } from "../models/User";
import { DeviceCode } from "../models/DeviceCode";
import { UserProgress } from "../models/UserProgress";
import { ContentCache } from "../models/ContentCache";
import { logger } from "../utils/logger";

function resolveDatabasePath(): string {
  const envPath = process.env.SQLITE_DB_PATH;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, "database.db");
    }
    return resolved;
  }
  // Prefer existing db file for backwards compatibility
  for (const candidate of [
    path.join(process.cwd(), "database.db"),
    path.join(process.cwd(), "database.sqlite"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), "database.db");
}

export const databasePath = resolveDatabasePath();

const databaseDir = path.dirname(databasePath);
if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: databasePath,
  models: [
    Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache,
    XtreamCache, GenreOverride, ContentOverride, StrmMovie, StrmSeries,
    User, DeviceCode, UserProgress, ContentCache,
  ],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    logger.info("Database connection established successfully.");
    logger.info(`Using SQLite database at: ${databasePath}`);

    // Migrate content_cache: drop old table if it has the wrong PK (auto-increment id instead of cacheKey)
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('content_cache');") as any;
      if (columns && columns.length > 0) {
        const pkColumn = columns.find((c: any) => c.pk === 1);
        if (pkColumn && pkColumn.name !== "cacheKey") {
          logger.warn("Migration: content_cache has wrong PK — dropping and recreating. All cached API responses will be lost.");
          await sequelize.query("DROP TABLE `content_cache`;");
        }
      }
    } catch {
      // Table may not exist yet, sync() will create it
    }

    // Migrate user_progress: drop old table if it lacks profileId column
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('user_progress');") as any;
      if (columns && columns.length > 0) {
        const hasProfileId = columns.some((c: any) => c.name === "profileId");
        if (!hasProfileId) {
          logger.warn("Migration: user_progress lacks profileId column — dropping and recreating. All watch history will be lost.");
          await sequelize.query("DROP TABLE `user_progress`;");
        }
      }
    } catch {
      // Table may not exist yet
    }

    // Migrate user_progress: remove stray single-column unique constraint on profileId
    // (caused by an earlier sync that added profileId as a unique PK column instead of composite)
    try {
      const [indexes] = await sequelize.query("PRAGMA index_list('user_progress');") as any;
      let needsRecreate = false;
      for (const idx of (indexes || [])) {
        if (idx.unique === 1 && idx.origin !== "pk") {
          const [cols] = await sequelize.query(`PRAGMA index_info('${idx.name}');`) as any;
          if (cols && cols.length < 3 && cols.some((c: any) => c.name === "profileId")) {
            needsRecreate = true;
            break;
          }
        }
      }
      if (needsRecreate) {
        logger.warn("Migration: user_progress has stray unique index on profileId — recreating table to fix, all data preserved.");
        await sequelize.query("CREATE TABLE `user_progress_new` (`userId` INTEGER NOT NULL, `profileId` INTEGER NOT NULL, `mediaId` VARCHAR(255) NOT NULL, `progress` FLOAT, `completed` TINYINT(1), `meta` TEXT, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`userId`, `profileId`, `mediaId`));");
        await sequelize.query("INSERT OR IGNORE INTO `user_progress_new` SELECT * FROM `user_progress`;");
        await sequelize.query("DROP TABLE `user_progress`;");
        await sequelize.query("ALTER TABLE `user_progress_new` RENAME TO `user_progress`;");
        logger.info("Migration: user_progress recreated with correct composite primary key.");
      }
    } catch (e) {
      logger.warn(`Migration: user_progress index check failed: ${e}`);
    }

    await sequelize.sync({ alter: true });
    logger.info("Database models synced.");

    // Auto-migrate schema: Add passwordHash and salt columns if they do not exist
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `passwordHash` TEXT;");
      logger.info("Migration: Added passwordHash column to users table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `salt` TEXT;");
      logger.info("Migration: Added salt column to users table.");
    } catch {
      // Column already exists — expected
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `avatarUrl` TEXT;");
      logger.info("Migration: Added avatarUrl column to users table.");
    } catch {
      // Column already exists — expected
    }
  } catch (error) {
    logger.error(`Unable to connect to the database: ${error}`);
  }
}
