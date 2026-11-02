import { capReheadUpdateMode } from '../src/ama/cap-rehead-update.mjs';
import { createHistoryReader } from '../src/ama/history-reader.mjs';

const [repo, number, headSha] = process.argv.slice(2);
const prNumber = Number(number);
if (!/^[^/]+\/[^/]+$/.test(repo || '') || !Number.isInteger(prNumber) || prNumber <= 0
  || !/^[0-9a-f]{40}$/i.test(headSha || '')) {
  throw new Error('Usage: node bin/cap-rehead-update-mode.mjs OWNER/REPO PR HEAD_SHA');
}
const get = createHistoryReader();
// Worker strategy selection needs fresh reads, not daemon-owned evidence writes.
get.persistPrimaryChange = false;
console.log(await capReheadUpdateMode({ repo, prNumber, headSha, get }));
