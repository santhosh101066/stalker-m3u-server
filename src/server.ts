import { Server } from '@hapi/hapi';
import { initialConfig, serverConfig } from '@/config/server';
import { generateGroupRoutes } from '@/routes/generate';
import { playlistRoutes } from './routes/playlist';
import { liveRoutes } from './routes/live';
import { configRoutes } from './routes/config';
import Hapi from '@hapi/hapi';
import Inert from '@hapi/inert'
import { serverManager } from './serverManager';



const init = async () => {
       // Register routes
     const server = Hapi.server({
       ...serverConfig
    });
    
    serverManager.setServer(server);
    await server.register(Inert)
    server.route(generateGroupRoutes);
    server.route(playlistRoutes);
    server.route(liveRoutes);
    server.route(configRoutes)
    server.route({
        method: 'GET',
        path: '/{param*}',
        handler: {
            directory: {
      path: 'public',
      index: ['index.html'],
      redirectToSlash: true
    }
        }
    });

    await server.start();
    console.log(`Server running at: ${server.info.uri}`);
};

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});

init();