import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/utils/logger";
import { ConfigProfile } from "@/models/ConfigProfile";
import { CreateProfileRequest, UpdateProfileRequest } from "@/types/types";
import {
  switchProfile,
  saveProfileToDB,
  loadActiveProfileFromDB,
} from "@/config/server";
import { serverManager } from "@/serverManager";
import { stalkerApi } from "@/utils/stalker";
import { Channel } from "@/models/Channel";
import { Genre } from "@/models/Genre";
import { EpgCache } from "@/models/EpgCache";
import crypto from "crypto";
import { socketService } from "@/services/SocketService";
import { authCheck } from "@/utils/jwt";

export const profileRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/profiles",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profiles = await ConfigProfile.findAll({
          order: [["createdAt", "DESC"]],
        });
        return profiles;
      } catch (error) {
        logger.error({ err: error }, "Error fetching profiles");
        return h.response({ error: "Failed to fetch profiles" }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/profiles/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);
        const profile = await ConfigProfile.findByPk(profileId);

        if (!profile) {
          return h.response({ error: "Profile not found" }).code(404);
        }

        return profile;
      } catch (error) {
        logger.error({ err: error }, "Error fetching profile");
        return h.response({ error: "Failed to fetch profile" }).code(500);
      }
    },
  },

  {
    method: "POST",
    path: "/api/profiles",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const payload = request.payload as CreateProfileRequest;
        const safeName = payload.name?.trim();

        if (!safeName || !payload.config) {
          return h
            .response({ error: "Name and config are required" })
            .code(400);
        }

        const existingProfile = await ConfigProfile.findOne({
          where: { name: safeName },
        });

        if (existingProfile) {
          return h
            .response({ error: "Profile with this name already exists" })
            .code(409);
        }

        const profile = await saveProfileToDB({
          name: safeName,
          description: payload.description,
          config: payload.config,
          isEnabled: payload.isEnabled,
        });

        return h.response(profile).code(201);
      } catch (error) {
        logger.error({ err: error }, "Error creating profile");
        return h.response({ error: "Failed to create profile" }).code(500);
      }
    },
  },

  {
    method: "PUT",
    path: "/api/profiles/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);
        const payload = request.payload as UpdateProfileRequest;

        const profile = await ConfigProfile.findByPk(profileId);

        if (!profile) {
          return h.response({ error: "Profile not found" }).code(404);
        }

        if (payload.name && payload.name.trim() !== profile.name) {
          const safeName = payload.name.trim();
          const existingProfile = await ConfigProfile.findOne({
            where: { name: safeName },
          });

          if (existingProfile) {
            return h
              .response({ error: "Profile with this name already exists" })
              .code(409);
          }
          profile.name = safeName;
        }

        if (payload.description !== undefined)
          profile.description = payload.description;
        if (payload.config !== undefined) profile.config = payload.config;
        if (payload.isEnabled !== undefined)
          profile.isEnabled = payload.isEnabled;

        await profile.save();

        if (profile.isActive && payload.config) {
          logger.info("Active profile updated. Reloading config without restart...");

          await loadActiveProfileFromDB();

          await serverManager.reloadConfig();
          stalkerApi.clearCache();

          // Clear database channels, genres and epgCache for this active profile
          await Channel.destroy({ where: { profileId } });
          await Genre.destroy({ where: { profileId } });
          await EpgCache.destroy({ where: { profileId } });
          logger.info(`Cleared cached database records for profile: ${profile.name}`);

          const hash = crypto.createHash("md5").update(JSON.stringify(payload.config)).digest("hex");
          socketService.broadcastConfigChange(hash);
        }

        return profile;
      } catch (error) {
        logger.error({ err: error }, "Error updating profile");
        return h.response({ error: "Failed to update profile" }).code(500);
      }
    },
  },

  {
    method: "DELETE",
    path: "/api/profiles/{id}",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);
        const profile = await ConfigProfile.findByPk(profileId);

        if (!profile) {
          return h.response({ error: "Profile not found" }).code(404);
        }

        if (profile.isActive) {
          return h
            .response({
              error:
                "Cannot delete active profile. Switch to another profile first.",
            })
            .code(400);
        }

        logger.info(`Deleting associated data for profile ${profileId}...`);
        await Channel.destroy({ where: { profileId } });
        await Genre.destroy({ where: { profileId } });
        await EpgCache.destroy({ where: { profileId } });

        await profile.destroy();

        logger.info(`Profile ${profileId} and its associated data deleted successfully.`);
        return { message: "Profile and associated data deleted successfully" };
      } catch (error) {
        logger.error({ err: error }, "Error deleting profile");
        return h.response({ error: "Failed to delete profile" }).code(500);
      }
    },
  },

  {
    method: "POST",
    path: "/api/profiles/{id}/activate",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);

        const profile = await switchProfile(profileId);

        logger.info("Switching profile. Reloading config without restart...");
        await serverManager.reloadConfig();
        stalkerApi.clearCache();

        const hash = crypto.createHash("md5").update(JSON.stringify(profile.config)).digest("hex");
        socketService.broadcastConfigChange(hash);

        return {
          message: `Switched to profile "${profile.name}". Configuration reloaded.`,
          profile,
          hash
        };
      } catch (error: any) {
        logger.error({ err: error }, "Error activating profile");
        return h
          .response({ error: error.message || "Failed to activate profile" })
          .code(400);
      }
    },
  },

  {
    method: "POST",
    path: "/api/profiles/{id}/enable",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);
        const profile = await ConfigProfile.findByPk(profileId);

        if (!profile) {
          return h.response({ error: "Profile not found" }).code(404);
        }

        profile.isEnabled = true;
        await profile.save();

        return { message: `Profile "${profile.name}" enabled`, profile };
      } catch (error) {
        logger.error({ err: error }, "Error enabling profile");
        return h.response({ error: "Failed to enable profile" }).code(500);
      }
    },
  },

  {
    method: "POST",
    path: "/api/profiles/{id}/disable",
    handler: async (request, h) => {
      if (!authCheck(request)) return h.response({ error: "Unauthorized" }).code(401);
      try {
        const profileId = parseInt(request.params.id);
        const profile = await ConfigProfile.findByPk(profileId);

        if (!profile) {
          return h.response({ error: "Profile not found" }).code(404);
        }

        if (profile.isActive) {
          return h
            .response({
              error:
                "Cannot disable active profile. Switch to another profile first.",
            })
            .code(400);
        }

        profile.isEnabled = false;
        await profile.save();

        return { message: `Profile "${profile.name}" disabled`, profile };
      } catch (error) {
        logger.error({ err: error }, "Error disabling profile");
        return h.response({ error: "Failed to disable profile" }).code(500);
      }
    },
  },
];
