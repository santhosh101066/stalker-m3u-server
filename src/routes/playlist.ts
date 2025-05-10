import { generateGroup } from '@/utils/generateGroups';
import { getM3u } from '@/utils/getM3uUrls';
import { ServerRoute } from '@hapi/hapi';

export const playlistRoutes: ServerRoute[] = [
    {
        method: 'GET',
        path: '/playlist.m3u',
        handler: async (request, h) => {
            const m3u = await getM3u()
            return  h.response(m3u)
            .type('application/vnd.apple.mpegurl') // or 'application/x-mpegURL' or 'text/plain'
            .header('Content-Disposition', 'inline; filename="iptv.m3u"');
        }
    }
];