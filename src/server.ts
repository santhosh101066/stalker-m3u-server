import { Server } from '@hapi/hapi';
import { initialConfig, serverConfig } from '@/config/server';
import { generateGroupRoutes } from '@/routes/generate';
import { playlistRoutes } from './routes/playlist';
import { liveRoutes } from './routes/live';

const server = new Server(serverConfig); 

const init = async () => {
       // Register routes
    server.route(generateGroupRoutes);
    server.route(playlistRoutes);
    server.route(liveRoutes);

    await server.start();
    console.log(`Server running at: ${server.info.uri}`);
};

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});

init();