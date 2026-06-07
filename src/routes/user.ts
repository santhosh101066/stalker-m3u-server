import { ServerRoute } from "@hapi/hapi";
import { User } from "../models/User";
import { UserProgress } from "../models/UserProgress";
import { ConfigProfile } from "../models/ConfigProfile";
import { authCheck } from "../utils/jwt";

const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id || 1;
};

export const userRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/user/profile",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const user = await User.findByPk(userPayload.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User inactive or not found" }).code(401);
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: user.avatarUrl,
          preferences: user.preferences || {}
        };
      } catch (error) {
        console.error("Error fetching user profile:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/user/preferences",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const user = await User.findByPk(userPayload.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User inactive or not found" }).code(401);
        }

        const payload = request.payload as any;

        // Merge incoming preferences with current preferences
        const currentPrefs = user.preferences || {};
        user.preferences = {
          ...currentPrefs,
          ...payload
        };

        // Sequelize requires us to set changed flag for JSON columns
        user.changed("preferences", true);
        await user.save();

        return { success: true, preferences: user.preferences };
      } catch (error) {
        console.error("Error updating user preferences:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/user/progress",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const profileId = await getActiveProfileId();
        const progressRecords = await UserProgress.findAll({
          where: { userId: userPayload.userId, profileId }
        });
        return progressRecords;
      } catch (error) {
        console.error("Error fetching user progress:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/user/progress",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const payload = request.payload as any;
        const { mediaId, progress, completed, meta } = payload;

        if (!mediaId) {
          return h.response({ error: "Missing mediaId" }).code(400);
        }

        const profileId = await getActiveProfileId();
        await UserProgress.upsert({
          userId: userPayload.userId,
          profileId,
          mediaId: String(mediaId),
          progress: Number(progress || 0),
          completed: !!completed,
          meta: meta ?? {}
        });

        return { success: true };
      } catch (error) {
        console.error("Error updating progress:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/user/clear-history",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const profileId = await getActiveProfileId();
        // Delete all progress for this profile
        await UserProgress.destroy({
          where: { userId: userPayload.userId, profileId }
        });

        // Clear recents
        const user = await User.findByPk(userPayload.userId);
        if (user) {
          user.preferences = {
            ...(user.preferences || {}),
            recentChannels: []
          };
          user.changed("preferences", true);
          await user.save();
        }

        return { success: true };
      } catch (error) {
        console.error("Error clearing history:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/user/progress/{mediaId}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const { mediaId } = request.params;
        const profileId = await getActiveProfileId();
        await UserProgress.destroy({
          where: {
            userId: userPayload.userId,
            profileId,
            mediaId: String(mediaId),
          },
        });
        return { success: true };
      } catch (error) {
        console.error("Error deleting progress:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
];
