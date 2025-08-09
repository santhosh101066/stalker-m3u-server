import { Data, Program } from "@/types/types";
import { fetchData } from "./fetch";
import { stalkerApi } from "./stalker";

export async function cmdPlayer(cmd: string) {
  const response = await fetchData<Data<Program>>(
    "/server/load.php?" +
      "type=itv&action=create_link&cmd=" +
      encodeURIComponent(cmd)
  );
  console.log(response);

  return response.js?.cmd;
}

export async function cmdPlayerV2(cmd: string) {
  const response = await stalkerApi.getChannelLink(cmd);
  return response.js?.cmd
}
