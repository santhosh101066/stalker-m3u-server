import { ServerRoute } from "@hapi/hapi";
import * as fs from "fs/promises";
import * as path from "path";
import { serverManager } from "../serverManager";
import { getInitialConfig, initialConfig, separateProviderConfig } from "@/config/server";
import { Config } from "@/types/types";
import { stalkerApi } from "@/utils/stalker";
import { ConfigProfile } from "@/models/ConfigProfile";
import crypto from "crypto";
import { socketService } from "@/services/SocketService";
import { createJWT } from "@/utils/jwt";
import { logger } from "@/utils/logger";

export const configRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/config",
    handler: async (request, h) => {
      return initialConfig;
    },
  },
  {
    method: "POST",
    path: "/api/config",
    handler: async (request, h) => {
      try {
        const newConfig = request.payload as any;

        if (newConfig.hostname) {
          newConfig.hostname = newConfig.hostname
            .replace(/^https?:\/\//, "")
            .replace(/[:\/]+$/, "");
        }
        if (newConfig.port !== undefined) {
          newConfig.port = Number(newConfig.port) || 80;
        }

        const activeProfile = await ConfigProfile.findOne({
          where: { isActive: true },
        });

        let finalConfig = activeProfile ? { ...activeProfile.config } : newConfig;

        if (activeProfile) {
          const mergedConfig = { ...activeProfile.config, ...newConfig };
          const safeConfig = separateProviderConfig(mergedConfig);

          if (!newConfig.tokens) {
            safeConfig.tokens = activeProfile.config.tokens;
          }

          activeProfile.config = safeConfig as Config;
          finalConfig = { ...activeProfile.config };
          await activeProfile.save();
          logger.info(
            `Updated configuration for active profile: ${activeProfile.name}`,
          );
        } else {
          return h
            .response({ error: "No active profile found to update." })
            .code(404);
        }

        try {
          await serverManager.reloadConfig();
          stalkerApi.clearCache();

          const hash = crypto.createHash("md5").update(JSON.stringify(finalConfig)).digest("hex");
          socketService.broadcastConfigChange(hash);

          return {
            message: "Configuration updated and reloaded successfully.",
            hash
          };
        } catch (error: any) {
          logger.error("Error reloading server config:", error);
          return h
            .response({
              error: "Configuration updated but server reload failed",
              details: error,
            })
            .code(500);
        }
      } catch (error: any) {
        logger.error("Error updating config:", error);
        return h
          .response({ error: "Failed to update configuration" })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/admin",
    handler: async (request, h) => {
      const token = createJWT({ role: "admin" });
      return { success: true, token };
    },
  },
];
