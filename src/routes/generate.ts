import { generateGroup } from '@/utils/generateGroups';
import { ServerRoute } from '@hapi/hapi';

export const generateGroupRoutes: ServerRoute[] = [
    {
        method: 'GET',
        path: '/group',
        handler: async (request, h) => {
            const catagory = await generateGroup()
            return { message: catagory };
        }
    }
];