// Integración: el recolector completo contra un servidor HTTP que imita al Ministerio,
// escribiendo en una carpeta temporal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../scripts/collect.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ministerio-girona.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(fixture));
const silent = { warn() {}, log() {} };
const T0 = new Date('2026-11-17T21:00:00Z');
const hours = (n) => new Date(T0.getTime() + n * 3600_000);

// Servidor de prueba: responde lo que haya en `next` (cola) o, si está vacía, `body`
let server, base, body = fixture, next = [], requests = 0;
before(async () => {
  server = createServer((req, res) => {
    requests++;
    const r = next.shift() || { status: 200, body };
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}/17`;
});
after(() => server.close());

async function tmp() {
  return mkdtemp(join(tmpdir(), 'gg-test-'));
}
const readJ = async (p) => JSON.parse(await readFile(p, 'utf8'));
const opts = (dataDir, now) => ({ apiUrl: base, dataDir, now, log: silent, retry: { delayMs: 1, tries: 3 } });

test('primera ejecución: crea latest.json, histórico por gasolinera y medias', async () => {
  body = fixture;
  const dir = await tmp();
  try {
    const r = await run(opts(dir, T0));
    assert.equal(r.stations, 7);

    const latest = await readJ(join(dir, 'latest.json'));
    assert.equal(latest.estaciones.length, 7);
    assert.equal(latest.provincia, '17');
    assert.equal(latest.actualizado, T0.toISOString());
    assert.equal(latest.fechaMinisterio, '2026-11-17T22:00:00');
    assert.equal(latest.fuels.gA, 'Diésel');

    // Solo las gasolineras con algún combustible conocido tienen histórico (HAM no)
    const files = (await readdir(join(dir, 'h'))).sort();
    assert.deepEqual(files, ['1001.json', '1002.json', '1003.json', '1004.json', '1005.json', '1007.json']);
    assert.deepEqual((await readJ(join(dir, 'h', '1001.json'))).g95, [[T0.getTime() / 1000, 1.279]]);

    // Media de Gasolina 95: públicas 1001,1002,1003,1005,1007 (la restringida 1004 no cuenta)
    const avg = await readJ(join(dir, 'avg.json'));
    const expected = Math.round(((1.279 + 1.589 + 1.269 + 1.629 + 1.549) / 5) * 1000) / 1000;
    assert.deepEqual(avg.g95, [[T0.getTime() / 1000, expected]]);
    assert.equal(avg.glp, undefined, 'GLP solo en 1 gasolinera: sin media');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('segunda ejecución sin cambios de precio: no toca el histórico (idempotente)', async () => {
  body = fixture;
  const dir = await tmp();
  try {
    await run(opts(dir, T0));
    const before = await readFile(join(dir, 'h', '1002.json'), 'utf8');
    const r = await run(opts(dir, hours(1)));
    assert.equal(r.changed, 0);
    assert.equal(await readFile(join(dir, 'h', '1002.json'), 'utf8'), before);
    assert.equal((await readJ(join(dir, 'latest.json'))).actualizado, hours(1).toISOString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cambio de precio y combustible retirado se reflejan en el histórico', async () => {
  const dir = await tmp();
  try {
    body = fixture;
    await run(opts(dir, T0));

    const changed = clone();
    const repsol = changed.ListaEESSPrecio.find((e) => e.IDEESS === '1002');
    repsol['Precio Gasolina 95 E5'] = '1,579';  // baja
    repsol['Precio Gasoleo Premium'] = '';      // deja de venderse
    body = changed;
    const r = await run(opts(dir, hours(1)));
    assert.equal(r.changed, 1);

    const h = await readJ(join(dir, 'h', '1002.json'));
    const t0 = T0.getTime() / 1000, t1 = t0 + 3600;
    assert.deepEqual(h.g95, [[t0, 1.589], [t1, 1.579]]);
    assert.deepEqual(h.gP, [[t0, 1.799], [t1, null]]);
    assert.deepEqual(h.gA, [[t0, 1.689]], 'el diésel no cambió');
  } finally {
    body = fixture;
    await rm(dir, { recursive: true, force: true });
  }
});

test('el Ministerio falla dos veces y luego responde: se recupera', async () => {
  const dir = await tmp();
  try {
    requests = 0;
    next = [{ status: 500, body: 'error' }, { status: 200, body: '<html>mantenimiento</html>' }];
    await run(opts(dir, T0));
    assert.equal(requests, 3);
    assert.equal((await readJ(join(dir, 'latest.json'))).estaciones.length, 7);
  } finally {
    next = [];
    await rm(dir, { recursive: true, force: true });
  }
});

test('el Ministerio no responde nunca: falla sin estropear los datos existentes', async () => {
  const dir = await tmp();
  try {
    body = fixture;
    await run(opts(dir, T0));
    const before = await readFile(join(dir, 'latest.json'), 'utf8');
    next = [{ status: 503, body: '' }, { status: 503, body: '' }, { status: 503, body: '' }];
    await assert.rejects(run(opts(dir, hours(1))), /HTTP 503/);
    assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), before);
  } finally {
    next = [];
    await rm(dir, { recursive: true, force: true });
  }
});

test('un id raro no se usa como nombre de fichero (path traversal)', async () => {
  const dir = await tmp();
  try {
    const evil = clone();
    evil.ListaEESSPrecio[0].IDEESS = '../../hack';
    body = evil;
    await run(opts(dir, T0));
    const files = await readdir(join(dir, 'h'));
    assert.ok(!files.some((f) => f.includes('hack')));
    await assert.rejects(readFile(join(dir, '..', 'hack.json')));
  } finally {
    body = fixture;
    await rm(dir, { recursive: true, force: true });
  }
});

test('un histórico corrupto se rehace en vez de romper la ejecución', async () => {
  const dir = await tmp();
  try {
    body = fixture;
    await mkdir(join(dir, 'h'), { recursive: true });
    await writeFile(join(dir, 'h', '1001.json'), '{roto');
    await run(opts(dir, T0));
    assert.deepEqual((await readJ(join(dir, 'h', '1001.json'))).g95, [[T0.getTime() / 1000, 1.279]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
