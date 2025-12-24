
import { Server as SocketIOServer, Socket } from "socket.io";
import { Server } from "http";

interface Device {
    id: string;
    socketId: string;
    name: string;
    type: 'receiver' | 'controller';
    ip: string;
}

class SocketService {
    private io: SocketIOServer | null = null;
    private devices: Map<string, Device> = new Map();

    public init(httpServer: Server) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: "*", // Allow all origins for local network access
                methods: ["GET", "POST"],
            },
        });

        this.io.on("connection", (socket: Socket) => {
            console.log(`[Socket] New connection: ${socket.id}`);

            socket.on("register", (data: { id: string; name: string; type: 'receiver' | 'controller' }) => {
                const device: Device = {
                    id: data.id,
                    socketId: socket.id,
                    name: data.name,
                    type: data.type,
                    ip: socket.handshake.address,
                };
                this.devices.set(socket.id, device);
                console.log(`[Socket] Device registered: ${device.name} (${device.type})`);

                // Broadcast updated list to all controllers
                this.broadcastReceivers();
            });

            socket.on("get_receivers", () => {
                socket.emit("receivers_list", this.getReceivers());
            });

            socket.on("cast_command", (data: { targetDeviceId: string; command: string; payload: any }) => {
                const targetSocketId = this.findSocketIdByDeviceId(data.targetDeviceId);
                if (targetSocketId) {
                    console.log(`[Socket] Forwarding command '${data.command}' to ${data.targetDeviceId}`);
                    this.io?.to(targetSocketId).emit("receive_cast_command", {
                        command: data.command,
                        payload: data.payload,
                        from: this.devices.get(socket.id)?.name || "Unknown Controller",
                    });
                } else {
                    console.warn(`[Socket] Target device ${data.targetDeviceId} not found`);
                }
            });

            socket.on("disconnect", () => {
                const device = this.devices.get(socket.id);
                if (device) {
                    console.log(`[Socket] Device disconnected: ${device.name}`);
                    this.devices.delete(socket.id);
                    if (device.type === 'receiver') {
                        this.broadcastReceivers();
                    }
                }
            });

            // Log Subscription
            socket.on("start_logging", () => {
                socket.join("logging");
            });

            socket.on("stop_logging", () => {
                socket.leave("logging");
            });
        });

        console.log("[Socket] Service initialized");
    }

    private getReceivers(): Device[] {
        return Array.from(this.devices.values()).filter(d => d.type === 'receiver');
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
}

export const socketService = new SocketService();
