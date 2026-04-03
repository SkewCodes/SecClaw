import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generateAttestationManifest } from '../src/gate/dependency-attestor.js';

const outputPath = process.argv[2] ?? './.secclaw/attestation.json';
const nodeModulesPath = join(process.cwd(), 'node_modules');

console.log('[secclaw:attest] Generating attestation manifest...');
console.log(`[secclaw:attest] Scanning: ${nodeModulesPath}`);

const manifest = generateAttestationManifest(nodeModulesPath);

const outputDir = dirname(outputPath);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`[secclaw:attest] ${manifest.total_packages} packages attested`);
console.log(`[secclaw:attest] Written to: ${outputPath}`);
