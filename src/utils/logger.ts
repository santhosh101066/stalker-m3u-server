import pino from 'pino';
import { appConfig } from '@/config/server';

import { socketService } from '@/services/SocketService';

const pinoLogger = pino({
  level: appConfig.app.logLevel || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

const logToSocket = (level: string, args: any[]) => {
  try {
    let message = '';
    if (args.length > 0) {
      if (typeof args[0] === 'string') {
        // logger.info("message", ...)
        message = args.join(' ');
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        // logger.info({ obj }, "message")
        if (args.length > 1 && typeof args[1] === 'string') {
          message = args[1] + ' ' + JSON.stringify(args[0]);
        } else {
          message = JSON.stringify(args[0]);
        }
      } else {
        message = String(args[0]);
      }
    }
    socketService.broadcastLog(level, message, new Date().toISOString());
  } catch (err) {
    // Ignore socket errors during logging to prevent loop
  }
};

export const logger = new Proxy(pinoLogger, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && ['info', 'warn', 'error', 'debug', 'fatal'].includes(prop)) {
      const original = target[prop as keyof typeof target];
      if (typeof original === 'function') {
        return (...args: any[]) => {
          logToSocket(prop, args);
          return (original as Function).apply(target, args);
        };
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});
