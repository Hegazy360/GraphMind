// Build step: write the JSON Schema artifact to <package root>/schema.json.
// Runs after tsc; imports the freshly built dist.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exportJsonSchemaString } from '../dist/json-schema.js';

const out = fileURLToPath(new URL('../schema.json', import.meta.url));
writeFileSync(out, exportJsonSchemaString());
console.log(`[schema] wrote ${out}`);
