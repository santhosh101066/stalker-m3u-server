import { ArrayData, GenerationKind, generationKindNames, GenerationKindType, Genre } from "@/types/types";
import { fetchData } from "./fetch";

const generationKind= "iptv"

function getActionAndType(kind:GenerationKind){
    switch(kind){
    case generationKindNames[0]:
        return 'type=itv&action=get_genres'
    case generationKindNames[1]:
        return 'type=vod&action=get_categories'
    case generationKindNames[2]:
        return 'type=series&action=get_categories'
    }

}
export async function generateGroup(){
  const response = await fetchData<ArrayData<Genre>>(
    "/server/load.php?" + getActionAndType(generationKind)
  );
  
  return (response.js ?? []).filter(
    (t) => t.title !== "All" && t.censored !== 1
  );
}
