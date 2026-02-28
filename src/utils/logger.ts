import pino from 'pino';
import { appConfig } from '@/config/server';

// Circular dependency breaker: SocketService will register itself here
let broadcastLogFn: ((level: string, message: string, timestamp: string) => void) | null = null;

export const setLogBroadcaster = (fn: (level: string, message: string, timestamp: string) => void) => {
  broadcastLogFn = fn;
};

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
    if (!broadcastLogFn) return;

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
    broadcastLogFn(level, message, new Date().toISOString());
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
          // 1. Log to console/file first (pino)
          const result = (original as Function).apply(target, args);
          // 2. Then broadcast to socket (if registered)
          // We do NOT log to socket here if the log came FROM SocketService to avoid loop? 
          // Actually, the loop was: logger -> socketService -> console.log -> logger ...
          // Now: logger -> socketService.broadcast -> emit.
          // If SocketService uses logger, it goes: SocketService -> logger -> pino (console) -> logToSocket -> broadcastFn -> emit.
          // This is fine as long as `broadcastFn` (Socket.emit) does NOT call logger.
          logToSocket(prop, args);
          return result;
        };
      }
    }
    return Reflect.get(target, prop, receiver);
  },
});
