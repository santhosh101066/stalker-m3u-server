import { Server } from "@hapi/hapi";
import { IProvider } from "@/interfaces/Provider";
import { stalkerApi } from "@/utils/stalker";
import { XtreamClient } from "@/utils/xtream-client";
import { initialConfig, loadActiveProfileFromDB } from "@/config/server";
import { logger } from "@/utils/logger";

class ServerManager {
  private static instance: ServerManager;
  private server: Server | null = null;
  private provider: IProvider | null = null;

  private constructor() {}

  static getInstance(): ServerManager {
    if (!ServerManager.instance) {
      ServerManager.instance = new ServerManager();
      ServerManager.instance.initProvider();
    }
    return ServerManager.instance;
  }

  initProvider() {
    if (initialConfig.providerType === "xtream") {
      stalkerApi.stopWatchdog();
      stalkerApi.clearCache();
      this.provider = new XtreamClient();
      logger.info("Initialized Xtream Codes Provider");
    } else {
      this.provider = stalkerApi;
      logger.info("Initialized Stalker Provider");
    }
  }

  getProvider(): IProvider {
    if (!this.provider) {
      this.initProvider();
    }
    return this.provider!;
  }

  setServer(server: Server) {
    this.server = server;
  }

  async reloadConfig() {
    try {
      await loadActiveProfileFromDB();
      this.initProvider();
      logger.info("Configuration reloaded without restarting server");
    } catch (error) {
      logger.error(`Failed to reload config: ${error}`);
      throw error;
    }
  }

  async restartServer() {
    if (!this.server) {
      throw new Error("Server instance not set");
    }

    try {
      await this.server.stop();

      await loadActiveProfileFromDB();

      this.initProvider();
      await this.server.start();
      logger.info("Server successfully restarted");
    } catch (error) {
      logger.error(`Failed to restart server: ${error}`);
      throw error;
    }
  }
}

export const serverManager = ServerManager.getInstance();
