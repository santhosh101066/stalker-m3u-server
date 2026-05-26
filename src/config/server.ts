import { AppConfig, Config } from "@/types/types";
import { ConfigProfile } from "@/models/ConfigProfile";
import { Token } from "@/models/Token";
import { logger } from "@/utils/logger";

function separateProviderConfig(config: Record<string, any>): Record<string, any> {
  const providerType = config.providerType || "stalker";
  const result: Record<string, any> = {};
  const sharedKeys = ["hostname", "port", "groups", "proxy", "providerType", "tvgIdPreFill", "tokenCacheDuration", "delayBetweenUrlGeneration", "computeUrlLink", "maxNumberOfChannelsToTest", "vodMaxPagePerGenre", "vodIncludeRating", "vodOrdering", "testM3uFile", "streamTester", "userAgent", "stbType"];
  const stalkerKeys = ["contextPath", "mac", "deviceId1", "deviceId2", "serialNumber", "tokens", "playCensored"];
  const xtreamKeys = ["username", "password"];

  for (const key of sharedKeys) {
    if (key in config) result[key] = config[key];
  }

  if (providerType === "xtream") {
    for (const key of xtreamKeys) {
      if (key in config) result[key] = config[key];
    }
  } else {
    for (const key of stalkerKeys) {
      if (key in config) result[key] = config[key];
    }
  }

  return result;
}

export const serverConfig = {
  host: "0.0.0.0",
  port: 3000,
  routes: {
    cors: { origin: ["*"] },
    state: {
      parse: false,
      failAction: "ignore" as const,
    },
  },
};

const ConfigDefault: Config = {
  hostname: process.env.STALKER_HOST || "portal.example.com",
  port: Number(process.env.STALKER_PORT) || 80,
  contextPath: process.env.STALKER_PATH || "stalker_portal",
  mac: process.env.STALKER_MAC || "00:1A:79:00:00:00",
  stbType: process.env.STALKER_STB || "MAG254",
  groups: [],
  proxy: false,
  tokens: [],
  playCensored: false,
  providerType: "stalker",
  username: "user",
  password: "password",
};

const proxySecret = process.env.PROXY_SECRET;
if (process.env.NODE_ENV === "production" && !proxySecret) {
  throw new Error(
    "FATAL: PROXY_SECRET environment variable is required in production mode.",
  );
} else if (!proxySecret) {
  logger.warn("WARNING: PROXY_SECRET not set, using insecure default.");
}

const AppConfigDefault: AppConfig = {
  api: {
    timeout: Number(process.env.API_TIMEOUT) || 5000,
    retries: Number(process.env.API_RETRIES) || 3,
  },
  app: {
    name: "stalker-m3u-server",
    environment: process.env.NODE_ENV || "production",
    logLevel: process.env.LOG_LEVEL || "info",
  },
  proxy: {
    secretKey: proxySecret || "default-secret-key-please-change",
  },
};

export const initialConfig: Config = { ...ConfigDefault };
export const appConfig: AppConfig = { ...AppConfigDefault };

export function getInitialConfig() {
  return initialConfig;
}

export function getAppConfig() {
  return appConfig;
}

export async function migrateToProfiles() {
  try {
    const existingProfiles = await ConfigProfile.count();
    if (existingProfiles === 0) {
      logger.info("No profiles found. Creating default profile...");
      const separated = separateProviderConfig(ConfigDefault as any);
      await ConfigProfile.create({
        name: "Default Profile",
        description: "Initialized from defaults",
        config: separated as Config,
        isActive: true,
        isEnabled: true,
      });
      logger.info("✅ Migration complete: Created 'Default Profile'");
    }
  } catch (err: any) {
    logger.error("Error during profile migration:", err);
  }
}

async function migrateFlatConfigs() {
  try {
    const profiles = await ConfigProfile.findAll();
    let migrated = 0;
    for (const profile of profiles) {
      const cfg = profile.config as Record<string, any>;
      const hasStalkerFields = "mac" in cfg || "deviceId1" in cfg;
      const hasXtreamFields = "username" in cfg || "password" in cfg;
      if (hasStalkerFields && hasXtreamFields) {
        const separated = separateProviderConfig(cfg as any);
        profile.config = separated as Config;
        await profile.save();
        migrated++;
      }
    }
    if (migrated > 0) {
      logger.info(`Migrated ${migrated} profile(s) to separated provider configs.`);
    }
  } catch (err: any) {
    logger.error("Error migrating flat configs:", err);
  }
}

export async function loadActiveProfileFromDB() {
  try {
    await migrateFlatConfigs();

    const activeProfile = await ConfigProfile.findOne({
      where: { isActive: true },
    });
    if (activeProfile) {
      Object.assign(initialConfig, ConfigDefault);
      Object.assign(initialConfig, activeProfile.config);

      initialConfig.hostname = initialConfig.hostname
        .replace(/^https?:\/\//, "")
        .replace(/[:\/]+$/, "");
      initialConfig.port = Number(initialConfig.port) || 80;

      logger.info(`✅ Loaded active profile: "${activeProfile.name}"`);

      const tokens = await Token.findAll();
      initialConfig.tokens = tokens.map((t) => t.token);
      logger.info(`Loaded ${initialConfig.tokens.length} tokens from DB.`);
    } else {
      logger.warn("⚠️ No active profile found. Using defaults.");
      Object.assign(initialConfig, ConfigDefault);
    }
  } catch (err: any) {
    logger.error("Error loading active profile from DB:", err);
  }
}

export async function switchProfile(profileId: number) {
  try {
    const profile = await ConfigProfile.findByPk(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    if (!profile.isEnabled)
      throw new Error(`Profile "${profile.name}" is disabled.`);

    await ConfigProfile.update({ isActive: false }, { where: {} });

    profile.isActive = true;
    await profile.save();

    logger.info(`✅ Switched to profile: "${profile.name}"`);
    await loadActiveProfileFromDB();
    return profile;
  } catch (err: any) {
    logger.error("Error switching profile:", err);
    throw err;
  }
}

export async function saveProfileToDB(profileData: {
  name: string;
  description?: string;
  config: Config;
  isEnabled?: boolean;
}) {
  try {
    const separated = separateProviderConfig(profileData.config as any);
    const profile = await ConfigProfile.create({
      name: profileData.name,
      description: profileData.description,
      config: separated as Config,
      isActive: false,
      isEnabled:
        profileData.isEnabled !== undefined ? profileData.isEnabled : true,
    });
    logger.info(`✅ Created profile: "${profile.name}"`);
    return profile;
  } catch (err: any) {
    logger.error("Error saving profile to DB:", err);
    throw err;
  }
}

export { separateProviderConfig };
