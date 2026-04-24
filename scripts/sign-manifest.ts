import { readFileSync, writeFileSync } from 'node:fs';
import { computeManifestHMAC } from '../src/policy/manifest-integrity.js';

const manifestPath = process.argv[2] ?? './policy-manifest.yaml';
const sigPath = manifestPath.replace(/\.yaml$/, '') + '.sig';

const key = process.env.SECCLAW_MANIFEST_SIGNING_KEY;
if (!key) {
  console.error('Error: SECCLAW_MANIFEST_SIGNING_KEY environment variable is required');
  process.exit(1);
}

const content = readFileSync(manifestPath, 'utf-8');
const hmac = computeManifestHMAC(content, key);

writeFileSync(sigPath, hmac, 'utf-8');
console.log(`Wrote HMAC signature to ${sigPath}`);
