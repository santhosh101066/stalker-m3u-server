import { Server as SocketIOServer, Socket } from "socket.io";
import { Server } from "http";
import { logger, setLogBroadcaster } from "@/utils/logger";

interface Device {
  id: string;
  socketId: string;
  name: string;
  type: "receiver" | "controller";
  ip: string;
}

class SocketService {
  private io: SocketIOServer | null = null;
  private devices: Map<string, Device> = new Map();

  public init(httpServer: Server) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    setLogBroadcaster((level, message, timestamp) => {
      this.broadcastLog(level, message, timestamp);
    });

    this.io.on("connection", (socket: Socket) => {
      logger.info(`[Socket] New connection: ${socket.id}`);

      socket.on(
        "register",
        (data: {
          id: string;
          name: string;
          type: "receiver" | "controller";
        }) => {
          for (const [sId, dev] of this.devices.entries()) {
            if (dev.id === data.id) {
              this.devices.delete(sId);
            }
          }

          const device: Device = {
            id: data.id,
            socketId: socket.id,
            name: data.name,
            type: data.type,
            ip: socket.handshake.address,
          };

          this.devices.set(socket.id, device);
          this.broadcastReceivers();
        },
      );

      socket.on("get_receivers", () => {
        socket.emit("receivers_list", this.getReceivers());
      });

      socket.on(
        "cast_command",
        (data: { targetDeviceId: string; command: string; payload: any }) => {
          const targetSocketId = this.findSocketIdByDeviceId(
            data.targetDeviceId,
          );
          if (targetSocketId) {
            logger.info(
              `[Socket] Forwarding command '${data.command}' to ${data.targetDeviceId}`,
            );
            this.io?.to(targetSocketId).emit("receive_cast_command", {
              command: data.command,
              payload: data.payload,
              from: this.devices.get(socket.id)?.name || "Unknown Controller",
            });
          } else {
            logger.warn(
              `[Socket] Target device ${data.targetDeviceId} not found`,
            );
          }
        },
      );

      socket.on("disconnect", () => {
        const device = this.devices.get(socket.id);
        if (device) {
          logger.info(`[Socket] Device disconnected: ${device.name}`);
          this.devices.delete(socket.id);
          if (device.type === "receiver") {
            this.broadcastReceivers();
          }
        }
      });

      socket.on("start_logging", () => {
        socket.join("logging");
      });

      socket.on("stop_logging", () => {
        socket.leave("logging");
      });
    });

    logger.info("[Socket] Service initialized");
  }

  private getReceivers(): Device[] {
    return Array.from(this.devices.values()).filter(
      (d) => d.type === "receiver",
    );
  }

  private findSocketIdByDeviceId(deviceId: string): string | undefined {
    for (const [socketId, device] of this.devices.entries()) {
      if (device.id === deviceId) return socketId;
    }
    return undefined;
  }

  private broadcastReceivers() {
    const receivers = this.getReceivers();
    this.io?.emit("receivers_updated", receivers);
  }

  public broadcastLog(level: string, message: string, timestamp: string) {
    this.io?.to("logging").emit("server_log", { level, message, timestamp });
  }

  public broadcastConfigChange(hash: string) {
    this.io?.emit("config_changed", { timestamp: Date.now(), hash });
  }
}

export const socketService = new SocketService();
