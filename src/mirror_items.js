// Structure only. Keeping locators separate from excerpt bytes makes a manifest read cheap.
import { extname } from "node:path";

export function itemIndex(rows) {
  const records = new Map();
  for (const [at, row] of rows.entries()) {
    const id = row.recordId ?? row.path;
    let record = records.get(id);
    if (!record) {
      record = {
        id,
        path: row.path,
        title: row.title ?? row.path,
        kind: row.kind ?? (row.recordId ? "record" : extname(row.path).slice(1) || "file"),
        status: row.status ?? null,
        version: row.version ?? null,
        updatedAt: row.updatedAt ?? null,
        fileVersion: row.fileVersion,
        hash: row.byteHash ?? null,
        sizeBytes: row.sizeBytes ?? null,
        structure: row.structure ?? null,
        complete: row.complete !== false,
        passages: [],
      };
      records.set(id, record);
    }
    record.passages.push([at, row.locator]);
  }
  return [...records.values()];
}
