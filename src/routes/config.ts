import { ServerRoute } from "@hapi/hapi";
import * as fs from "fs/promises";
import * as path from "path";
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

const uploadDir = path.join(process.cwd(), "uploads");

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
          console.log(`Cleared cached database and content records for profile: ${activeProfile.name}`);
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
          console.error("Error reloading server config:", error);
          return h.response({ error: "Configuration updated but server reload failed", details: error }).code(500);
        }
      } catch (error) {
        console.error("Error updating config:", error);
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
          console.log(`Cleared cached database and video content records for profile: ${activeProfile.name}`);
        }
        return { success: true, message: "Cache cleared successfully." };
      } catch (error: any) {
        console.error("Error clearing cache:", error);
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
        console.error("Error fetching carousel config:", error);
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
        console.error("Error updating carousel config:", error);
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
        console.error("Error during file upload:", error);
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