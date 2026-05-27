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
  models: [Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache, XtreamCache, GenreOverride, ContentOverride],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");
    console.log(`Using SQLite database at: ${databasePath}`);
    await sequelize.sync({ alter: true });
    console.log("Database models synced.");
  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
}
