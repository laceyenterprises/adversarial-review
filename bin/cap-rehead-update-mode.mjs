import { capReheadUpdateMode } from '../src/ama/cap-rehead-update.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';

const [repo, number, headSha, rootFlag, rootDir, ...extra] = process.argv.slice(2);
const prNumber = Number(number);
if (!/^[^/]+\/[^/]+$/.test(repo || '') || !Number.isInteger(prNumber) || prNumber <= 0
  || !/^[0-9a-f]{40}$/i.test(headSha || '') || rootFlag !== '--root-dir' || !rootDir || extra.length) {
  throw new Error('Usage: node bin/cap-rehead-update-mode.mjs OWNER/REPO PR HEAD_SHA --root-dir CANONICAL_RUNTIME_ROOT');
}
const get = createHistoryReader();
// Worker strategy selection needs fresh reads, not daemon-owned evidence writes.
get.persistPrimaryChange = false;
console.log(await capReheadUpdateMode({ repo, prNumber, headSha, rootDir, get }));
