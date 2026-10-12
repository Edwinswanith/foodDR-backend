import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { gunzipSync } from "zlib";

let entries: Array<{ name: string; normalized: string }> | undefined;

function loadEntries() {
  if (!entries) {
    // Works from src/, compiled dist/, and the Vercel project root.
    const bundledAsset = resolve(process.cwd(), "assets/food-name-suggestions.json.gz");
    const asset = existsSync(bundledAsset) ? bundledAsset : resolve(__dirname, "../../../assets/food-name-suggestions.json.gz");
    const names: string[] = JSON.parse(gunzipSync(readFileSync(asset)).toString("utf8"));
    entries = names.map(name => ({ name, normalized: name.toLowerCase() }));
  }
  return entries;
}

export function foodNameRank(name: string, term: string): number {
  const normalized = name.toLowerCase();
  const query = term.trim().toLowerCase();
  if (normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  if (normalized.includes(` ${query}`) || normalized.includes(`-${query}`)) return 2;
  return normalized.includes(query) ? 3 : 4;
}

export function searchFoodNames(term: string, limit: number): string[] {
  const query = term.trim().toLowerCase();
  if (!query || limit < 1) return [];
  const buckets: string[][] = [[], [], [], []];
  // The asset is sorted once at import. Keep bounded result buckets so broad
  // queries never allocate or sort hundreds of thousands of matches.
  for (const entry of loadEntries()) {
    if (!entry.normalized.includes(query)) continue;
    const rank = foodNameRank(entry.normalized, query);
    if (buckets[rank].length < limit) buckets[rank].push(entry.name);
  }
  return buckets.flat().slice(0, limit);
}

export function isFoodNameSuggestion(name: string): boolean {
  const query = name.trim().toLowerCase();
  return loadEntries().some(entry => entry.normalized === query);
}
