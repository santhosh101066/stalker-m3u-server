import { Server } from "@hapi/hapi";

class ServerManager {
    private static instance: ServerManager;
    private server: Server | null = null;

    private constructor() {}

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
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
            await this.server.start();
            console.log('Server successfully restarted');
        } catch (error) {
            console.error('Failed to restart server:', error);
            throw error;
        }
    }
}

export const serverManager = ServerManager.getInstance();
