import { Config } from "@/types/types";
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

export let initialConfig: Config = ConfigDefault;
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

initialConfig = getInitialConfig();
