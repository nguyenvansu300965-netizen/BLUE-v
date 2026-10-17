import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../store.js';
const file = process.argv[2];
if (!file || !process.env.DATA_DIR) throw new Error('用法: DATA_DIR=/data node scripts/import-activation-codes.mjs <批次JSON文件>');
const batch = JSON.parse(await readFile(path.resolve(file), 'utf8')); const store = new Store(path.resolve(process.env.DATA_DIR));
try { console.log(JSON.stringify(store.importActivationBatch(batch))); } finally { store.close(); }
