import { ServerRoute } from "@hapi/hapi";
import * as fs from 'fs/promises';
import * as path from 'path';
import { serverManager } from '../serverManager';
import { getInitialConfig, initialConfig } from "@/config/server";
import { stalkerApi } from "@/utils/stalker";


export const configRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/config",
    handler: async (request, h) => {
      try {
        return initialConfig
      } catch (error) {
        console.error('Error reading config file:', error);
        return h.response({ error: 'Failed to read configuration' }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/config",
    handler: async (request, h) => {
      try {
        const configPath = path.join(process.cwd(), 'config.json');
        const newConfig = request.payload;
        
        // Validate that the payload is valid JSON
        if (typeof newConfig !== 'object') {
          return h.response({ error: 'Invalid configuration format' }).code(400);
        }

        // Read existing config
        const existingConfigData = await fs.readFile(configPath, 'utf-8');
        const existingConfig = JSON.parse(existingConfigData);

        // Merge configs
        const mergedConfig = { ...existingConfig, ...newConfig };

        // Write the merged configuration to file
        await fs.writeFile(configPath, JSON.stringify(mergedConfig, null, 2), 'utf-8');

        // Restart the server using server manager
        try {
             serverManager.restartServer();
             getInitialConfig()
             stalkerApi.clearCache()
            return { message: 'Configuration updated and server restarted successfully.' };
        } catch (error) {
            console.error('Error restarting server:', error);
            return h.response({ 
                error: 'Configuration updated but server restart failed',
                details: error 
            }).code(500);
        }
      } catch (error) {
        console.error('Error updating config file:', error);
        return h.response({ error: 'Failed to update configuration' }).code(500);
      }
    },
  }
];