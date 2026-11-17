// Pruebas del Worker de Cloudflare que lanza la tarea de GitHub
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { dispatch } from '../../cloudflare/worker.js';

const quiet = () => { const o = console.log, e = console.error; console.log = console.error = () => {}; return () => { console.log = o; console.error = e; }; };

test('llama a la API de GitHub con el token, la rama main y el workflow correcto', async () => {
  let call;
  const fetchImpl = async (url, opts) => { call = { url, opts }; return { status: 204, text: async () => '' }; };
  const restore = quiet();
  const r = await dispatch({ GITHUB_TOKEN: 'tok' }, fetchImpl);
  restore();
  assert.deepEqual(r, { ok: true, status: 204 });
  assert.equal(call.url, 'https://api.github.com/repos/CyrailJR11/Precios-Gasolineras/actions/workflows/precios.yml/dispatches');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(call.opts.body), { ref: 'main' });
});

test('sin token no llama a GitHub', async () => {
  let called = false;
  const restore = quiet();
  const r = await dispatch({}, async () => { called = true; });
  restore();
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('un token caducado (401) se informa como fallo', async () => {
  const restore = quiet();
  const r = await dispatch({ GITHUB_TOKEN: 'x' }, async () => ({ status: 401, text: async () => 'Bad credentials' }));
  restore();
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.error, /Bad credentials/);
});

test('la ejecución programada falla visiblemente si GitHub rechaza la petición', async () => {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const restore = quiet();
  await worker.scheduled({}, {}, ctx);
  await assert.rejects(pending[0], /No se pudo lanzar la tarea/);
  restore();
});
