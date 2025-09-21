import pino from 'pino';
import { appConfig } from '@/config/server';

export const logger = pino({
  level: appConfig.app.logLevel || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});
