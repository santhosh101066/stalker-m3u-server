import { stalkerApi } from "./stalker";

import { logger } from "./logger";

const pendingCmds = new Map<string, Promise<string | null>>();

export async function cmdPlayerV2(cmd: string): Promise<string | null> {
  if (pendingCmds.has(cmd)) {
    logger.info(`[cmdPlayerV2] Deduping request for ${cmd}...`);
    return pendingCmds.get(cmd)!;
  }

  const promise = (async () => {
    let attempts = 0;
    const maxAttempts = 10;
    const delay = 1000;

    while (attempts < maxAttempts) {
      try {
        const response = await stalkerApi.getChannelLink(cmd);
        if (response && response.js && response.js.cmd) {
          return response.js.cmd;
        }
        logger.warn(
          `[cmdPlayerV2] Attempt ${attempts + 1} failed to resolve URL for ${cmd}. Retrying...`,
        );
      } catch (err) {
        logger.error(`[cmdPlayerV2] Error on attempt ${attempts + 1}: ${err}`);
      }
      attempts++;
      if (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    logger.error(
      `[cmdPlayerV2] Failed to resolve URL for ${cmd} after ${maxAttempts} attempts.`,
    );
    return null;
  })();

  pendingCmds.set(cmd, promise);

  try {
    return await promise;
  } finally {
    pendingCmds.delete(cmd);
  }
}
