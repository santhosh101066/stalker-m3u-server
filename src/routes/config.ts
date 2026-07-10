import { ServerRoute } from "@hapi/hapi";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/utils/logger";
import { serverManager } from "../serverManager";
import { initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";
import { ConfigProfile } from "@/models/ConfigProfile";
import crypto from "crypto";
import { socketService } from "@/services/SocketService";
import { createJWT, authCheck } from "@/utils/jwt";
import { SystemConfig } from "../models/SystemConfig";
import { Channel } from "@/models/Channel";
import { Genre } from "@/models/Genre";
import { EpgCache } from "@/models/EpgCache";
import { ContentCache } from "@/models/ContentCache";

// Store uploads in the same persistent volume as the database so they survive redeployments
const dataDir = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(process.cwd(), "data");
const uploadDir = path.join(dataDir, "uploads");

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
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
        let finalConfig = activeProfile ? { ...activeProfile.config } : newConfig;

        if (activeProfile) {
          const updatedConfig = { ...activeProfile.config, ...newConfig };
          if (!newConfig.tokens) updatedConfig.tokens = activeProfile.config.tokens;

          activeProfile.config = updatedConfig;
          finalConfig = updatedConfig;
          await activeProfile.save();

          const profileId = activeProfile.id;
          await Channel.destroy({ where: { profileId } });
          await Genre.destroy({ where: { profileId } });
          await EpgCache.destroy({ where: { profileId } });
          await ContentCache.destroy({ where: { profileId } }); // Flush ContentCache as configuration profile changes
          logger.info(`Cleared cached database and content records for profile: ${activeProfile.name}`);
        } else {
          return h.response({ error: "No active profile found to update." }).code(404);
        }

        try {
          await serverManager.reloadConfig();
          stalkerApi.clearCache();
          const hash = crypto.createHash("md5").update(JSON.stringify(finalConfig)).digest("hex");
          socketService.broadcastConfigChange(hash);

          return { message: "Configuration updated and reloaded successfully.", hash };
        } catch (error) {
          logger.error({ err: error }, "Error reloading server config");
          return h.response({ error: "Configuration updated but server reload failed", details: error }).code(500);
        }
      } catch (error) {
        logger.error({ err: error }, "Error updating config");
        return h.response({ error: "Failed to update configuration" }).code(500);
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
        const expectedPassword = process.env.ADMIN_PASSWORD;
          if (!expectedPassword) {
            return h.response({ error: "Server misconfiguration: ADMIN_PASSWORD not set" }).code(503);
          }

        if (providedPassword === expectedPassword) {
          const token = createJWT({ role: "admin" });
          return { success: true, token };
        } else {
          return h.response({ error: "Invalid password" }).code(401);
        }
      } catch (error) {
        logger.error({ err: error }, "Error during admin authentication");
        return h.response({ error: "Authentication failed" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/clear-cache",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        serverManager.getProvider().clearCache();
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
        if (activeProfile) {
          const profileId = activeProfile.id;
          await Channel.destroy({ where: { profileId } });
          await Genre.destroy({ where: { profileId } });
          await EpgCache.destroy({ where: { profileId } });
          await ContentCache.destroy({ where: { profileId } }); // Manual purge removes persistent entries instantly!
          logger.info(`Cleared cached database and video content records for profile: ${activeProfile.name}`);
        }
        return { success: true, message: "Cache cleared successfully." };
      } catch (error: any) {
        logger.error({ err: error }, "Error clearing cache");
        return h.response({ success: false, error: error.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/carousel",
    handler: async (request, h) => {
      try {
        const record = await SystemConfig.findOne({ where: { key: "carousel_slides" } });
        return record ? record.value : [];
      } catch (error) {
        logger.error({ err: error }, "Error fetching carousel config");
        return h.response({ error: "Failed to fetch carousel configuration" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/carousel",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const payload = request.payload;
        await SystemConfig.upsert({ key: "carousel_slides", value: payload });
        return { success: true, message: "Carousel configuration updated successfully." };
      } catch (error) {
        logger.error({ err: error }, "Error updating carousel config");
        return h.response({ error: "Failed to update carousel configuration" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/upload",
    options: {
      payload: {
        output: "data",
        parse: true,
        multipart: true,
        maxBytes: 10 * 1024 * 1024,
      },
    },
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const payload = request.payload as any;
        const file = payload?.file;
        if (!file) return h.response({ error: "No file provided" }).code(400);

        const filename = file.hapi?.filename || `upload-${Date.now()}`;
        const cleanFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const uniqueFilename = `${Date.now()}-${cleanFilename}`;
        
        await fs.mkdir(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, uniqueFilename);
        await fs.writeFile(filePath, file);

        return { success: true, url: `/uploads/${uniqueFilename}` };
      } catch (error) {
        logger.error({ err: error }, "Error during file upload");
        return h.response({ error: "Failed to upload file" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/uploads/{param*}",
    handler: {
      directory: {
        path: uploadDir,
        redirectToSlash: true,
        index: false,
      },
    },
  },
];