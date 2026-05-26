import { Sequelize } from "sequelize-typescript";
import path from "path";
import { Token } from "../models/Token";
import { SystemConfig } from "../models/SystemConfig";
import { ConfigProfile } from "../models/ConfigProfile";
import { Channel } from "../models/Channel";
import { Genre } from "../models/Genre";
import { EpgCache } from "../models/EpgCache";
import { logger } from "@/utils/logger";

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: path.join(process.cwd(), "database.sqlite"),
  models: [Token, SystemConfig, ConfigProfile, Channel, Genre, EpgCache],
  logging: false,
});

export async function initDB() {
  try {
    await sequelize.authenticate();
    logger.info("Database connection has been established successfully.");
    await sequelize.sync();
    logger.info("Database models synced.");
  } catch (error: any) {
    logger.error("Unable to connect to the database:", error);
  }
}
