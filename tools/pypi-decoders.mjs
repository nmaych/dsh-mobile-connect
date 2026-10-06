/**
 * Install the optional QR *decoders* used by test/qr-decode-verify.mjs.
 *
 * These are not needed for the mandatory segno comparison (test/qr-verify.mjs);
 * they power the stronger end-to-end check that our symbols are readable by
 * real scanner libraries.
 *
 * Downloads pure/binary wheels from PyPI with Node's TLS stack (no pip needed),
 * verifies each is a readable zip, and extracts it into the target directory.
 *
 * usage: node tools/pypi-decoders.mjs [destDir]
 *        (default destDir: <repo>/.pylibs-decoders)
 *
 * Afterwards run:
 *   node test/qr-decode-verify.mjs
 * or point the harness at a custom location with QR_DECODER_LIBS.
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const destDir = process.argv[2] || path.join(HERE, '..', '.pylibs-decoders');

/**
 * Wheels to install. `match` selects the right platform/ABI build:
 *   - opencv-python-headless: needs the CPython ABI matching the interpreter
 *   - zxing-cpp: ships a stable-ABI (abi3) cp312 build that works on 3.12+
 */
const PACKAGES = [
  { name: 'numpy', match: (f) => f.includes('cp312') && f.includes('win_amd64') },
  { name: 'opencv-python-headless', match: (f) => f.includes('win_amd64') && f.includes('abi3') },
  { name: 'zxing-cpp', match: (f) => f.includes('cp312-abi3') && f.includes('win_amd64') },
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'node' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

fs.mkdirSync(destDir, { recursive: true });
const stageDir = path.join(destDir, '.stage');
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

for (const pkg of PACKAGES) {
  const meta = JSON.parse((await get(`https://pypi.org/pypi/${pkg.name}/json`)).toString());
  const version = meta.info.version;
  const wheel = meta.releases[version].find(
    (f) => f.filename.endsWith('.whl') && pkg.match(f.filename),
  );
  if (!wheel) {
    console.error(`no matching wheel for ${pkg.name} ${version}`);
    console.error('available:');
    for (const f of meta.releases[version]) console.error(`  ${f.filename}`);
    process.exit(1);
  }

  const buf = await get(wheel.url);
  const zipPath = path.join(stageDir, `${pkg.name}.zip`);
  fs.writeFileSync(zipPath, buf);
  console.log(`${pkg.name} ${version} -> ${wheel.filename} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

  // Expand-Archive is the only zip extractor guaranteed present on Windows.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  fs.rmSync(zipPath, { force: true });
}

fs.rmSync(stageDir, { recursive: true, force: true });
console.log(`\ninstalled decoders into ${destDir}`);
console.log('run: node test/qr-decode-verify.mjs');
