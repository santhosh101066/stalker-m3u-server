import { stalkerApi } from "./stalker";

export async function cmdPlayerV2(cmd: string) {
  const response = await stalkerApi.getChannelLink(cmd);
  return response.js?.cmd
}
