import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const publicDir = path.join(root, 'public');
const outDir = path.join(root, 'out');
const defaultBackendUrl = 'https://chatbotord-production.up.railway.app';

const runtimeConfig = {
  backendUrl: process.env.backendUrl || process.env.BACKEND_URL || defaultBackendUrl,
  appApiKey: process.env.APP_API_KEY || ''
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(srcDir, outDir, { recursive: true });
await cp(publicDir, outDir, { recursive: true });
await writeFile(path.join(outDir, 'runtime-config.js'), `window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`);

console.log('frontend_build_complete', { outDir, backendConfigured: Boolean(runtimeConfig.backendUrl) });
