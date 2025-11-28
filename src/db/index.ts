import { Sequelize } from "sequelize-typescript";
import path from "path";
import { Token } from "../models/Token";
import { SystemConfig } from "../models/SystemConfig";
import { ConfigProfile } from "../models/ConfigProfile";
import { Channel } from "../models/Channel";
import { Genre } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(process.cwd(), "database.sqlite"),
  models: [Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache],
  logging: false, // Set to console.log to see SQL queries
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    console.log("Database connection has been established successfully.");
    await sequelize.sync(); // Sync models to DB
    console.log("Database models synced.");
  } catch (error) {
    console.error("Unable to connect to the database:", error);
  }
}
