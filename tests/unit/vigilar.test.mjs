// Pruebas de la vigilancia (scripts/vigilar.mjs) con respuestas simuladas: no hace peticiones reales
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run, informe, checkDatos, checkTarea, checkMinisterio, checkWeb, SITE } from '../../scripts/vigilar.mjs';

const RAW = JSON.parse(await readFile(new URL('../fixtures/ministerio-girona.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-18T18:00:00Z');
const API = 'https://api.example/17';
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();
const PRS = ['08', '17', '25', '43'];
const muchas = (n, prs = PRS) => Array.from({ length: n }, (_, i) => ({ id: String(i), pr: prs[i % prs.length] }));

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

// Simula todo lo que está bien; `over` sustituye respuestas por URL
function fakeFetch(over = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    for (const [k, v] of Object.entries(over)) if (url.includes(k)) { if (v instanceof Error) throw v; return typeof v === 'function' ? v(url, opts) : v; }
    if (url === SITE) return res(200, '<title>Gasolina Cataluña</title>');
    if (url.endsWith('app.js')) return res(200, 'async function fetchLive() {}');
    if (url.endsWith('transform.mjs')) return res(200, 'export function transform() {}');
    if (url.includes('data/latest.json')) return res(200, { actualizado: minAgo(20), estaciones: muchas(1600) });
    if (url.includes('api.github.com')) return res(200, { workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: minAgo(25), event: 'workflow_dispatch', html_url: 'u' }] });
    if (url === API) return res(200, RAW, { 'access-control-allow-origin': '*' });
    return res(404, 'no');
  };
  fn.calls = calls;
  return fn;
}

const opts = (fetchImpl, extra = {}) => ({ fetchImpl, site: SITE, token: 'tok', apiUrl: API, now: NOW, maxAgeMin: 120, retry: { delayMs: 0 }, ...extra });

test('todo correcto: las cuatro comprobaciones pasan', async () => {
  const r = await run(opts(fakeFetch()));
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results.length, 4);
});

test('avisa si los precios publicados tienen más de 2 horas (Worker o token parados)', async () => {
  const f = fakeFetch({ 'data/latest.json': res(200, { actualizado: minAgo(185), estaciones: muchas(1600) }) });
  const r = await checkDatos(opts(f));
  assert.equal(r.ok, false);
  assert.match(r.detail, /hace 185 min/);
  assert.match(r.detail, /hora de Girona/);
  assert.match(r.detail, /18\/11\/26, 15:55/); // 15:55 UTC+1, no 14:55 UTC
});

test('acepta datos de justo 2 horas', async () => {
  const f = fakeFetch({ 'data/latest.json': res(200, { actualizado: minAgo(120), estaciones: muchas(1600) }) });
  assert.equal((await checkDatos(opts(f))).ok, true);
});

test('avisa si los datos publicados están vacíos, rotos o con fecha mala', async () => {
  for (const body of [{ actualizado: minAgo(5), estaciones: [] }, 'esto no es json', { actualizado: 'ayer', estaciones: muchas(1600) }]) {
    const r = await checkDatos(opts(fakeFetch({ 'data/latest.json': res(200, body) })));
    assert.equal(r.ok, false, JSON.stringify(body));
  }
});

test('pide los datos saltándose la caché', async () => {
  const f = fakeFetch();
  await checkDatos(opts(f));
  const c = f.calls.find((c) => c.url.includes('latest.json'));
  assert.match(c.url, /\?t=\d+$/);
  assert.equal(c.opts.headers['Cache-Control'], 'no-cache');
});

test('avisa si la web publicada no responde o no es la web', async () => {
  assert.equal((await checkWeb(opts(fakeFetch({ 'app.js': res(404, 'no') })))).ok, false);
  const r = await checkWeb(opts(fakeFetch({ [SITE]: (url) => (url === SITE ? res(200, '<title>Otra cosa</title>') : res(200, 'export function transform fetchLive')) })));
  assert.equal(r.ok, false);
});

test('reintenta los errores 5xx y de red antes de avisar', async () => {
  let n = 0;
  const f = fakeFetch({ 'app.js': () => (++n < 3 ? res(503, '') : res(200, 'fetchLive')) });
  assert.equal((await checkWeb(opts(f))).ok, true);
  assert.equal(n, 3);
});

test('avisa si la última ejecución de "Actualizar precios" falló', async () => {
  const f = fakeFetch({ 'api.github.com': res(200, { workflow_runs: [{ status: 'completed', conclusion: 'failure', created_at: minAgo(10), html_url: 'https://x/run/1' }] }) });
  const r = await checkTarea(opts(f));
  assert.equal(r.ok, false);
  assert.match(r.detail, /failure/);
  assert.match(r.detail, /https:\/\/x\/run\/1/);
});

test('avisa si "Actualizar precios" lleva más de 2 horas sin ejecutarse', async () => {
  const f = fakeFetch({ 'api.github.com': res(200, { workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: minAgo(200) }] }) });
  const r = await checkTarea(opts(f));
  assert.equal(r.ok, false);
  assert.match(r.detail, /Worker de Cloudflare/);
});

test('ignora la ejecución en curso y mira la última terminada; usa el token', async () => {
  const f = fakeFetch({ 'api.github.com': res(200, { workflow_runs: [
    { status: 'in_progress', conclusion: null, created_at: minAgo(1) },
    { status: 'completed', conclusion: 'success', created_at: minAgo(30), event: 'schedule' },
  ] }) });
  assert.equal((await checkTarea(opts(f))).ok, true);
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer tok');
});

test('sin token no falla la comprobación de la tarea (ejecución en local)', async () => {
  assert.equal((await checkTarea(opts(fakeFetch(), { token: undefined }))).ok, true);
});

test('avisa si el Ministerio no responde, responde vacío o quita el CORS', async () => {
  assert.equal((await checkMinisterio(opts(fakeFetch({ [API]: res(500, '') })))).ok, false);
  assert.equal((await checkMinisterio(opts(fakeFetch({ [API]: res(200, { ListaEESSPrecio: [] }, { 'access-control-allow-origin': '*' }) })))).ok, false);
  const r = await checkMinisterio(opts(fakeFetch({ [API]: res(200, RAW, {}) })));
  assert.equal(r.ok, false);
  assert.match(r.detail, /CORS/);
});

test('un error de red persistente cuenta como fallo y no detiene las demás comprobaciones', async () => {
  const r = await run(opts(fakeFetch({ [API]: new Error('ECONNRESET') })));
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 4);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false]);
  assert.match(r.results[3].detail, /ECONNRESET/);
});

test('el informe dice qué ha fallado, en hora de Girona y sin romper la tabla', () => {
  const md = informe({ ok: false, results: [{ name: 'A', ok: true, detail: 'bien' }, { name: 'B', ok: false, detail: 'mal | raro' }] }, NOW);
  assert.match(md, /Algo ha dejado de funcionar/);
  assert.match(md, /18\/11\/26, 19:00/);
  assert.match(md, /\| B \| ❌ \| mal \\\| raro \|/);
});

test('avisa si faltan gasolineras de alguna provincia de Cataluña', async () => {
  const f = fakeFetch({ 'data/latest.json': res(200, { actualizado: minAgo(10), estaciones: muchas(1600, ['08', '17', '43']) }) });
  const r = await checkDatos(opts(f));
  assert.equal(r.ok, false);
  assert.match(r.detail, /Lleida/);
});

test('avisa si latest.json trae pocas gasolineras (p. ej. solo Girona)', async () => {
  const f = fakeFetch({ 'data/latest.json': res(200, { actualizado: minAgo(10), estaciones: muchas(272) }) });
  const r = await checkDatos(opts(f));
  assert.equal(r.ok, false);
  assert.match(r.detail, /272/);
});
