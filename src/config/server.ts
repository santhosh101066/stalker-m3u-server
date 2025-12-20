import { AppConfig, Config } from "@/types/types";
import { ConfigProfile } from "@/models/ConfigProfile";
import { Token } from "@/models/Token";

export const serverConfig = {
  host: "0.0.0.0",
  port: 3000,
  routes: {
    cors: { origin: ["*"] },
  },
};

// 1. Define Defaults
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
  providerType: 'stalker',
  username: 'user',
  password: 'password',
};

const AppConfigDefault: AppConfig = {
  api: {
    timeout: Number(process.env.API_TIMEOUT) || 5000,
    retries: Number(process.env.API_RETRIES) || 3
  },
  app: {
    name: "stalker-m3u-server",
    environment: process.env.NODE_ENV || "production",
    logLevel: process.env.LOG_LEVEL || "info"
  },
  proxy: {
    secretKey: process.env.PROXY_SECRET || "default-secret-key-please-change"
  }
};

// --- KEY CHANGE: Export as CONST so the reference never changes ---
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
      console.log("No profiles found. Creating default profile...");
      await ConfigProfile.create({
        name: "Default Profile",
        description: "Initialized from defaults",
        config: ConfigDefault,
        isActive: true,
        isEnabled: true,
      });
      console.log("✅ Migration complete: Created 'Default Profile'");
    }
  } catch (err) {
    console.error("Error during profile migration:", err);
  }
}

export async function loadActiveProfileFromDB() {
  try {
    const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
    if (activeProfile) {
      // --- KEY CHANGE: Update properties of the existing object ---
      Object.assign(initialConfig, activeProfile.config);

      console.log(`✅ Loaded active profile: "${activeProfile.name}"`);

      const tokens = await Token.findAll();
      initialConfig.tokens = tokens.map(t => t.token);
      console.log(`Loaded ${initialConfig.tokens.length} tokens from DB.`);
    } else {
      console.warn("⚠️ No active profile found. Using defaults.");
      Object.assign(initialConfig, ConfigDefault);
    }
  } catch (err) {
    console.error("Error loading active profile from DB:", err);
  }
}

export async function switchProfile(profileId: number) {
  try {
    const profile = await ConfigProfile.findByPk(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);
    if (!profile.isEnabled) throw new Error(`Profile "${profile.name}" is disabled.`);

    await ConfigProfile.update({ isActive: false }, { where: {} });

    profile.isActive = true;
    await profile.save();

    console.log(`✅ Switched to profile: "${profile.name}"`);
    await loadActiveProfileFromDB();
    return profile;
  } catch (err) {
    console.error("Error switching profile:", err);
    throw err;
  }
}

export async function saveProfileToDB(profileData: { name: string; description?: string; config: Config; isEnabled?: boolean }) {
  try {
    const profile = await ConfigProfile.create({
      name: profileData.name,
      description: profileData.description,
      config: profileData.config,
      isActive: false,
      isEnabled: profileData.isEnabled !== undefined ? profileData.isEnabled : true,
    });
    console.log(`✅ Created profile: "${profile.name}"`);
    return profile;
  } catch (err) {
    console.error("Error saving profile to DB:", err);
    throw err;
  }
}