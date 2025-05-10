import { ArrayData, GenerationKind, generationKindNames, GenerationKindType, Genre } from "@/types/types";
import { fetchData } from "./fetch";
import { GROUP_FILE } from "@/constants/common";
import { writeFileSync } from "fs";
import { error } from "console";

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
  // .then(r => {

  //     // if (generationKind === 'series') {
  //     //     // Look for movies for each category
  //     //     fetchSeries(r.js).then(genreSeries => {
  //     //         fs.writeFileSync(GROUP_FILE, genreSeries
  //     //             .map(t => t.toString())
  //     //             .filter(t => t !== 'All')
  //     //             .join('\r\n'));
  //     //     });
  //     // }
  //     // else {
  //         writeFileSync(GROUP_FILE, (r.js ?? [])
  //             .map(t => t.title)
  //             .filter(t => t !== 'All')
  //             .join('\r\n'));
  //     // }
  // }, err => {
  //     error(err)
  // })
  // .then(() => {
  //     console.info("Done");
  // });

  return (response.js ?? []).filter(
    (t) => t.title !== "All" && t.censored !== 1
  );
}
