// Integración: el servidor estático local (scripts/serve.mjs) sirve la web con los tipos correctos
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  const script = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));
  child = spawn(process.execPath, [script, String(PORT)], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, ko) => {
    child.stdout.on('data', (d) => d.toString().includes('localhost') && ok());
    child.on('exit', (c) => ko(new Error('el servidor terminó con código ' + c)));
    setTimeout(() => ko(new Error('el servidor no arrancó')), 10000);
  });
});
after(() => child?.kill());

const get = (path) => fetch(BASE + path);

test('sirve index.html en /', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /<title>Combustibles Cataluña<\/title>/);
});

for (const [path, type] of [
  ['/app.js', /javascript/],
  ['/transform.mjs', /javascript/],
  ['/style.css', /text\/css/],
  ['/manifest.webmanifest', /manifest\+json/],
  ['/icon.svg', /image\/svg\+xml/],
  ['/icon-192.png', /image\/png/],
  ['/data/latest.json', /application\/json/],
]) {
  test(`sirve ${path} como ${type}`, async () => {
    const r = await get(path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), type);
  });
}

test('404 para lo que no existe', async () => {
  assert.equal((await get('/no-existe.txt')).status, 404);
});

test('no deja salir de docs/ (path traversal)', async () => {
  const r = await get('/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(r.status), 'estado ' + r.status);
});

test('una URL mal codificada responde 400 y el servidor sigue funcionando', async () => {
  assert.equal((await get('/%E0%A4%A')).status, 400);
  assert.equal((await get('/')).status, 200);
});

test('no deja salir a una carpeta hermana que empiece por "docs"', async () => {
  const { request } = await import('node:http');
  // "%2f" codificado: la URL no resuelve el ".." y llega tal cual a join()
  const status = await new Promise((ok, ko) =>
    request({ host: '127.0.0.1', port: PORT, path: '/..%2fdocs-x%2fsecreto.txt' }, (r) => { r.resume(); ok(r.statusCode); }).on('error', ko).end());
  assert.equal(status, 403);
});
