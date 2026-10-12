const { readFileSync } = require('fs');
const { resolve } = require('path');
const { createHash } = require('crypto');
const { gunzipSync } = require('zlib');
const { searchFoodNames, isFoodNameSuggestion } = require('../src/api/services/foodNameSuggestions');

test('bundled document contains all 500000 unique names and matches its manifest', () => {
  const asset = readFileSync(resolve(__dirname, '../assets/food-name-suggestions.json.gz'));
  const manifest = require('../assets/food-name-suggestions.manifest.json');
  const names = JSON.parse(gunzipSync(asset));
  expect(names).toHaveLength(500000);
  expect(new Set(names.map(name => name.toLowerCase())).size).toBe(500000);
  expect(createHash('sha256').update(asset).digest('hex')).toBe(manifest.asset_sha256);
  expect(manifest.nutrition_status).toBe('unavailable');
});

test('tea ranks ahead of steamed dishes, handles casing, and limits suggestions', () => {
  const names = searchFoodNames(' TEA ', 10);
  expect(names).toHaveLength(10);
  expect(names[0]).toBe('Tea');
  expect(names.every(name => /\btea\b/i.test(name))).toBe(true);
  expect(searchFoodNames('tea', 1)).toEqual(['Tea']);
});

test('names at the end of the original document are searchable without fake nutrition', () => {
  expect(searchFoodNames('Pan-Fried Apricot Payasam', 10)[0]).toBe('Pan-Fried Apricot Payasam');
  expect(isFoodNameSuggestion('pan-fried apricot payasam')).toBe(true);
  expect(isFoodNameSuggestion('no-such-food-xyz')).toBe(false);
  expect(searchFoodNames('no-such-food-xyz', 10)).toEqual([]);
  expect(searchFoodNames('', 10)).toEqual([]);
});
