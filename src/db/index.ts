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

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(process.cwd(), "database.sqlite"),
  models: [Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache, User, DeviceCode, UserProgress],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");
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
