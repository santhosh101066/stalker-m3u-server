import { ServerRoute } from "@hapi/hapi";
import * as fs from 'fs/promises';
import * as path from 'path';
import { serverManager } from '../serverManager';
import { getInitialConfig, initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";
import { ConfigProfile } from "@/models/ConfigProfile";


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

        // 1. Find the Active Profile
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });

        if (activeProfile) {
          // 2. Merge and Save to DB
          const updatedConfig = { ...activeProfile.config, ...newConfig };

          // Ensure we don't accidentally overwrite tokens if they aren't passed (though tokens table handles this separately)
          if (!newConfig.tokens) {
            updatedConfig.tokens = activeProfile.config.tokens;
          }

          activeProfile.config = updatedConfig;
          await activeProfile.save();
          console.log(`Updated configuration for active profile: ${activeProfile.name}`);
        } else {
          return h.response({ error: 'No active profile found to update.' }).code(404);
        }

        // 3. Restart the server to apply changes
        try {
          // Reload config from DB into memory
          serverManager.restartServer();
          stalkerApi.clearCache();

          return { message: 'Configuration updated and server restarted successfully.' };
        } catch (error) {
          console.error('Error restarting server:', error);
          return h.response({
            error: 'Configuration updated but server restart failed',
            details: error
          }).code(500);
        }
      } catch (error) {
        console.error('Error updating config:', error);
        return h.response({ error: 'Failed to update configuration' }).code(500);
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

        // Use an environment variable, defaulting to 'admin'
        const expectedPassword = process.env.ADMIN_PASSWORD || 'admin';

        if (providedPassword === expectedPassword) {
          return { success: true };
        } else {
          return h.response({ error: 'Invalid password' }).code(401);
        }
      } catch (error) {
        console.error('Error during admin authentication:', error);
        return h.response({ error: 'Authentication failed' }).code(500);
      }
    },
  }
];