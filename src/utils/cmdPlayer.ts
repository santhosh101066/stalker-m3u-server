import { Data, Program } from "@/types/types";
import { fetchData } from "./fetch";

export async function cmdPlayer(cmd: string) {
  const response = await fetchData<Data<Program>>(
    "/server/load.php?" +
      "type=itv&action=create_link&cmd=" +
      encodeURIComponent(cmd)
  );
  return response.js.cmd;
}