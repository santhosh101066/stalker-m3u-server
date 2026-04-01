import { ServerRoute } from "@hapi/hapi";
import * as fs from "fs/promises";
import * as path from "path";
import { serverManager } from "../serverManager";
import { getInitialConfig, initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";
import { ConfigProfile } from "@/models/ConfigProfile";
import crypto from "crypto";
import { socketService } from "@/services/SocketService";
import { createJWT, authCheck } from "@/utils/jwt";

export const configRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/config",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      return initialConfig;
    },
  },
  {
    method: "POST",
    path: "/api/config",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const newConfig = request.payload as any;

        const activeProfile = await ConfigProfile.findOne({
          where: { isActive: true },
        });

        let finalConfig = activeProfile ? { ...activeProfile.config } : newConfig;

        if (activeProfile) {
          const updatedConfig = { ...activeProfile.config, ...newConfig };

          if (!newConfig.tokens) {
            updatedConfig.tokens = activeProfile.config.tokens;
          }

          activeProfile.config = updatedConfig;
          finalConfig = updatedConfig;
          await activeProfile.save();
          console.log(
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
        } catch (error) {
          console.error("Error reloading server config:", error);
          return h
            .response({
              error: "Configuration updated but server reload failed",
              details: error,
            })
            .code(500);
        }
      } catch (error) {
        console.error("Error updating config:", error);
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
      try {
        const payload = request.payload as any;
        const providedPassword = payload?.password;

        const expectedPassword = process.env.ADMIN_PASSWORD || "admin";

        if (providedPassword === expectedPassword) {
          const token = createJWT({ role: "admin" });
          return { success: true, token };
        } else {
          return h.response({ error: "Invalid password" }).code(401);
        }
      } catch (error) {
        console.error("Error during admin authentication:", error);
        return h.response({ error: "Authentication failed" }).code(500);
      }
    },
  },
];
