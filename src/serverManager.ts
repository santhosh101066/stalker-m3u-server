import { Server } from "@hapi/hapi";
import { IProvider } from "@/interfaces/Provider";
import { StalkerAPI } from "@/utils/stalker";
import { XtreamClient } from "@/utils/xtream-client";
import { initialConfig, loadActiveProfileFromDB } from "@/config/server";

class ServerManager {
    private static instance: ServerManager;
    private server: Server | null = null;
    private provider: IProvider | null = null;

    private constructor() { }

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
            ServerManager.instance.initProvider();
        }
        return ServerManager.instance;
    }

    initProvider() {
        if (initialConfig.providerType === 'xtream') {
            this.provider = new XtreamClient();
            console.log("Initialized Xtream Codes Provider");
        } else {
            this.provider = new StalkerAPI();
            console.log("Initialized Stalker Provider");
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

    async restartServer() {
        if (!this.server) {
            throw new Error('Server instance not set');
        }

        try {
            await this.server.stop();
            // Reload config from DB
            await loadActiveProfileFromDB();
            // Re-init provider on restart to pick up config changes
            this.initProvider();
            await this.server.start();
            console.log('Server successfully restarted');
        } catch (error) {
            console.error('Failed to restart server:', error);
            throw error;
        }
    }
}

export const serverManager = ServerManager.getInstance();
