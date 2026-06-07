import { Sequelize } from "sequelize-typescript";
import path from "path";
import { Token } from "../models/Token";
import { SystemConfig } from "../models/SystemConfig";
import { ConfigProfile } from "../models/ConfigProfile";
import { Channel } from "../models/Channel";
import { Genre } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { User } from "../models/User";
import { DeviceCode } from "../models/DeviceCode";
import { UserProgress } from "../models/UserProgress";
import { ContentCache } from "../models/ContentCache"; 

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(process.cwd(), "database.sqlite"),
  // 2. Added ContentCache into the Sequelize models array
  models: [Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache, User, DeviceCode, UserProgress, ContentCache],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");

    // Migrate content_cache: drop old table if it has the wrong PK (auto-increment id instead of cacheKey)
    try {
      const [columns] = await sequelize.query("PRAGMA table_info('content_cache');") as any;
      if (columns && columns.length > 0) {
        const pkColumn = columns.find((c: any) => c.pk === 1);
        if (pkColumn && pkColumn.name !== "cacheKey") {
          console.log("Migration: Recreating content_cache table with cacheKey as primary key...");
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
          console.log("Migration: Recreating user_progress table to include profileId...");
          await sequelize.query("DROP TABLE `user_progress`;");
        }
      }
    } catch {
      // Table may not exist yet
    }

    await sequelize.sync();
    console.log("Database models synced.");

    // Auto-migrate schema: Add passwordHash and salt columns if they do not exist
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `passwordHash` TEXT;");
      console.log("Migration: Added passwordHash column to users table.");
    } catch {
      // Ignore if the column already exists
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `salt` TEXT;");
      console.log("Migration: Added salt column to users table.");
    } catch {
      // Ignore if the column already exists
    }
    try {
      await sequelize.query("ALTER TABLE `users` ADD COLUMN `avatarUrl` TEXT;");
      console.log("Migration: Added avatarUrl column to users table.");
    } catch {
      // Ignore if the column already exists
    }

  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
}