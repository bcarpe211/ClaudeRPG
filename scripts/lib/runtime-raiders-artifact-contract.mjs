#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const contractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../config/runtime-raiders-artifact-contract.json',
);
const raw = readFileSync(contractPath, 'utf8');
if (Buffer.byteLength(raw) > 4_096) throw new Error('artifact contract is too large');
const contract = JSON.parse(raw);
if (
  Object.keys(contract).sort().join(',') !== 'installer_max_bytes,schema_version'
  || contract.schema_version !== 1
  || !Number.isSafeInteger(contract.installer_max_bytes)
  || contract.installer_max_bytes < 1
  || contract.installer_max_bytes > 64 * 1024 * 1024
) {
  throw new Error('artifact contract is invalid');
}

if (process.argv.length !== 3 || process.argv[2] !== 'installer_max_bytes') {
  process.exitCode = 64;
} else {
  process.stdout.write(`${contract.installer_max_bytes}\n`);
}
