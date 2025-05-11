import { Config } from "@/types/types";
import { readFileSync } from "fs";

export const serverConfig = {
  host: "0.0.0.0",
  port: 3000,
  routes: {
    cors: true,
  },
};

export const config: Config = JSON.parse(
  readFileSync("./config.json", { encoding: "utf-8", flag: "r" })
);
