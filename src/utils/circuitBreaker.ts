import { logger } from "@/utils/logger";

const FAILURE_THRESHOLD = parseInt(process.env.CB_FAILURE_THRESHOLD || "5", 10);
const FAILURE_WINDOW_MS = parseInt(process.env.CB_FAILURE_WINDOW_MS || "60000", 10);
const COOLDOWN_MS = parseInt(process.env.CB_COOLDOWN_MS || "30000", 10);

export class CircuitBreaker {
  private failures = 0;
  private lastFailureAt = 0;
  private opened = false;
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  isOpen(): boolean {
    if (!this.opened) return false;
    if (Date.now() - this.lastFailureAt > COOLDOWN_MS) {
      // Cooldown elapsed — half-open: allow one probe request
      this.opened = false;
      this.failures = 0;
      logger.info(`[CircuitBreaker:${this.name}] Half-open after cooldown — allowing probe request`);
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.failures > 0 || this.opened) {
      logger.info(`[CircuitBreaker:${this.name}] Closed after successful request`);
    }
    this.failures = 0;
    this.opened = false;
  }

  recordFailure(): void {
    const now = Date.now();
    if (now - this.lastFailureAt > FAILURE_WINDOW_MS) {
      // Outside the window — reset counter
      this.failures = 0;
    }
    this.failures++;
    this.lastFailureAt = now;
    if (!this.opened && this.failures >= FAILURE_THRESHOLD) {
      this.opened = true;
      logger.warn(
        `[CircuitBreaker:${this.name}] Opened after ${this.failures} failures — fast-failing for ${COOLDOWN_MS / 1000}s`,
      );
    }
  }
}
