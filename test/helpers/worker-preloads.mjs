import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(process.env.AR_TEST_SHARD_CONFIG, 'utf8'));
const file = process.argv[1];
const name = Object.keys(config.paths).find(key => config.paths[key] === file);
if (!name) throw new Error(`Unknown test worker entrypoint: ${file}`);
const root = path.resolve(file, ...name.split(path.sep).map(() => '..'));
for (const preload of config.preloads) {
  await import(pathToFileURL(path.isAbsolute(preload) ? preload : path.join(root, preload)).href);
}
