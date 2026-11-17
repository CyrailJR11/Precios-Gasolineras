// Pruebas unitarias de la lógica del recolector (histórico y medias)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateHistory, updateAverages, fetchWithRetry, AVG_KEEP_DAYS } from '../../scripts/collect.mjs';

const T0 = 1_800_000_000;
const silent = { warn() {}, log() {} };

test('histórico: el primer precio se guarda', () => {
  const h = {};
  assert.equal(updateHistory(h, { g95: 1.5 }, T0), true);
  assert.deepEqual(h, { g95: [[T0, 1.5]] });
});

test('histórico: mismo precio no añade punto (idempotente)', () => {
  const h = { g95: [[T0, 1.5]] };
  assert.equal(updateHistory(h, { g95: 1.5 }, T0 + 3600), false);
  assert.deepEqual(h, { g95: [[T0, 1.5]] });
});

test('histórico: precio distinto añade punto', () => {
  const h = { g95: [[T0, 1.5]] };
  assert.equal(updateHistory(h, { g95: 1.49 }, T0 + 3600), true);
  assert.deepEqual(h.g95, [[T0, 1.5], [T0 + 3600, 1.49]]);
});

test('histórico: combustible que desaparece se corta con null una sola vez', () => {
  const h = { g95: [[T0, 1.5]], gA: [[T0, 1.6]] };
  assert.equal(updateHistory(h, { g95: 1.5 }, T0 + 3600), true);
  assert.deepEqual(h.gA, [[T0, 1.6], [T0 + 3600, null]]);
  assert.equal(updateHistory(h, { g95: 1.5 }, T0 + 7200), false);
  assert.equal(h.gA.length, 2);
});

test('histórico: combustible que vuelve tras null se reanuda', () => {
  const h = { gA: [[T0, 1.6], [T0 + 3600, null]] };
  assert.equal(updateHistory(h, { gA: 1.6 }, T0 + 7200), true);
  assert.deepEqual(h.gA.at(-1), [T0 + 7200, 1.6]);
});

const st = (p, r = 0) => ({ p, r });

test('media: solo venta al público y redondeada a milésimas', () => {
  const avg = updateAverages({}, [st({ g95: 1.5 }), st({ g95: 1.6 }), st({ g95: 1.7 }), st({ g95: 0.5 }, 1)], T0);
  assert.deepEqual(avg.g95, [[T0, 1.6]]);
});

test('media: hacen falta al menos 3 gasolineras', () => {
  const avg = updateAverages({}, [st({ glp: 1 }), st({ glp: 1.1 })], T0);
  assert.equal(avg.glp, undefined);
});

test('media: no repite el punto si no cambia', () => {
  const s = [st({ g95: 1.5 }), st({ g95: 1.5 }), st({ g95: 1.5 })];
  const avg = updateAverages({}, s, T0);
  updateAverages(avg, s, T0 + 3600);
  assert.equal(avg.g95.length, 1);
});

test(`media: se borran los puntos de más de ${AVG_KEEP_DAYS} días`, () => {
  const old = T0 - (AVG_KEEP_DAYS + 1) * 86400;
  const avg = { g95: [[old, 1.4]], glp: [[old, 0.9]] };
  updateAverages(avg, [st({ g95: 1.5 }), st({ g95: 1.5 }), st({ g95: 1.5 })], T0);
  assert.deepEqual(avg.g95, [[T0, 1.5]]);
  // también en combustibles que ya no tienen suficientes gasolineras
  assert.deepEqual(avg.glp, []);
});

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('fetchWithRetry: reintenta tras errores y devuelve la respuesta válida', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) throw new Error('red caída');
    if (calls === 2) return resp(500, {});
    return resp(200, { ListaEESSPrecio: [{ IDEESS: '1' }] });
  };
  const json = await fetchWithRetry('x', { fetchImpl, delayMs: 1, log: silent });
  assert.equal(calls, 3);
  assert.equal(json.ListaEESSPrecio.length, 1);
});

test('fetchWithRetry: una respuesta vacía cuenta como fallo', async () => {
  const fetchImpl = async () => resp(200, { ListaEESSPrecio: [] });
  await assert.rejects(fetchWithRetry('x', { fetchImpl, tries: 2, delayMs: 1, log: silent }), /sin estaciones/);
});

test('fetchWithRetry: se rinde tras los intentos indicados', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return resp(503, {}); };
  await assert.rejects(fetchWithRetry('x', { fetchImpl, tries: 3, delayMs: 1, log: silent }), /HTTP 503/);
  assert.equal(calls, 3);
});
