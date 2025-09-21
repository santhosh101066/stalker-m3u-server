import fs from "fs";
import path from "path";

const storagePath = path.resolve(__dirname, "../../.mem");
if (!fs.existsSync(storagePath)) {
  fs.mkdirSync(storagePath);
}

export function writeJSON(filename: string, data: any) {
  fs.writeFileSync(
    path.join(storagePath, filename),
    JSON.stringify(data, null, 2)
  );
}

export function readJSON<T>(filename: string): T[] {
  const filePath = path.join(storagePath, filename);
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T[];
}