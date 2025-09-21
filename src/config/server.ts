import { AppConfig, Config } from "@/types/types";
import fs from "fs";

export const serverConfig = {
  host: "0.0.0.0",
  port: 3000,
  routes: {
    cors: { origin: ["*"] },
  },
};

const ConfigDefault: Config = {
  hostname: "my.dns.com",
  port: 8080,
  contextPath: "stalker_portal",
  mac: "00:1A:79:12:34:56",
  stbType: "MAG270",
  groups: ["Tamil"],
  proxy: false,
  tokens: []
};

const AppConfigDefault: AppConfig = {
  api: {
    timeout: 5000,
    retries: 3
  },
  app: {
    name: "stalker-m3u-server",
    environment: "production",
    logLevel: "info"
  },
  proxy: {
    secretKey: "default-secret-key-please-change"
  }
};

export let initialConfig: Config = ConfigDefault;
export let appConfig: AppConfig = AppConfigDefault;

export function getInitialConfig() {
  try {
    if (fs.existsSync("./config.json")) {
      initialConfig = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
    }
  } catch (err) {
    console.warn("⚠️ Failed to load config.json. Using empty config.");
    initialConfig = ConfigDefault;
  }
  return initialConfig;
}

export function getAppConfig() {
  try {
    if (fs.existsSync("./appConfig.json")) {
      appConfig = JSON.parse(fs.readFileSync("./appConfig.json", "utf-8"));
    }
  } catch (err) {
    console.warn("⚠️ Failed to load appConfig.json. Using default config.");
    appConfig = AppConfigDefault;
  }
  return appConfig;
}

initialConfig = getInitialConfig();
appConfig = getAppConfig();
