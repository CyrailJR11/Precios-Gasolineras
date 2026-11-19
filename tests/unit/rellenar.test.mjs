// Unitarias del relleno del histórico con el servicio histórico del Ministerio
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fechaApi, tsDia, compress, mergeStation, mergeAverages, MAX_DIAS, descargar } from '../../scripts/rellenar.mjs';

const D = 86400;
const T0 = 1795000000;

test('fecha en formato dd-mm-aaaa y dato del día a las 12:00 de España', () => {
  const d = new Date(Date.UTC(2026, 0, 5));
  assert.equal(fechaApi(d), '05-01-2026');
  assert.equal(new Date(tsDia(d) * 1000).toISOString(), '2026-01-05T11:00:00.000Z');
});

test('compress quita los puntos que repiten el valor anterior', () => {
  assert.deepEqual(compress([[1, 1.5], [2, 1.5], [3, 1.6], [4, null], [5, null], [6, 1.6]]), [[1, 1.5], [3, 1.6], [4, null], [6, 1.6]]);
});

test('gasolinera sin histórico: se crea con los cambios diarios', () => {
  const days = [{ ts: T0, p: { g95: 1.5 } }, { ts: T0 + D, p: { g95: 1.5 } }, { ts: T0 + 2 * D, p: { g95: 1.52, gA: 1.6 } }];
  assert.deepEqual(mergeStation(null, days), { g95: [[T0, 1.5], [T0 + 2 * D, 1.52]], gA: [[T0 + 2 * D, 1.6]] });
});

test('solo añade días anteriores al primer dato y no toca lo ya recogido', () => {
  const T = T0 + 3 * D;
  const existing = { g95: [[T, 1.55], [T + 3600, 1.54]] };
  const days = [{ ts: T0, p: { g95: 1.5 } }, { ts: T0 + D, p: { g95: 1.55 } }, { ts: T0 + 4 * D, p: { g95: 9 } }];
  // El día 4 es posterior al primer dato: se ignora. 1.55 se repite en la unión: queda un solo punto.
  assert.deepEqual(mergeStation(existing, days), { g95: [[T0, 1.5], [T0 + D, 1.55], [T + 3600, 1.54]] });
});

test('combustible que se vendía antes y no al empezar la recogida: se marca como retirado', () => {
  const T = T0 + 2 * D;
  const existing = { g95: [[T, 1.5]] };
  const out = mergeStation(existing, [{ ts: T0, p: { g95: 1.5, gB: 1.2 } }]);
  assert.deepEqual(out.gB, [[T0, 1.2], [T, null]]);
  assert.deepEqual(out.g95, [[T0, 1.5]]);
});

test('ejecutarlo dos veces no cambia nada (idempotente)', () => {
  const days = [{ ts: T0, p: { g95: 1.5 } }, { ts: T0 + D, p: { g95: 1.51 } }];
  const once = mergeStation({ g95: [[T0 + 5 * D, 1.6]] }, days);
  assert.equal(mergeStation(once, days), null);
});

test('medias por provincia: se rellenan hacia atrás sin mezclar provincias', () => {
  const st = (pr, v, r = 0) => ({ pr, r, p: { g95: v } });
  const days = [
    { ts: T0, stations: [st('08', 1.4), st('08', 1.5), st('08', 1.6), st('17', 2), st('17', 2), st('17', 2), st('17', 0.1, 1)] },
    { ts: T0 + D, stations: [st('08', 1.5), st('08', 1.5), st('08', 1.5)] },
  ];
  const old = { g95: [[T0 + 5 * D, 1.9]] }; // formato antiguo: solo Girona
  const avg = mergeAverages(old, days);
  assert.deepEqual(avg['08'].g95, [[T0, 1.5]], '1,5 los dos días: un solo punto');
  assert.deepEqual(avg['17'].g95, [[T0, 2], [T0 + 5 * D, 1.9]], 'la restringida no cuenta y se conserva lo que había');
  assert.equal(avg.g95, undefined);
});

test('descargar: pide un día por petición, del más antiguo al más reciente, y salta los que fallan', async () => {
  const urls = [];
  const raw = { Fecha: '01/01/2026 00:00:00', ListaEESSPrecio: [
    { IDEESS: '5', 'Rótulo': 'X', IDProvincia: '25', 'Tipo Venta': 'P', 'Precio Gasolina 95 E5': '1,500' },
    { IDEESS: '6', 'Rótulo': 'Y', IDProvincia: '28', 'Tipo Venta': 'P', 'Precio Gasolina 95 E5': '1,400' },
  ] };
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/18-11-2026/')) return { ok: false, status: 500 };
    return { ok: true, json: async () => raw };
  };
  const log = { log() {}, warn() {} };
  const { days, fallidos } = await descargar({ dias: 3, hoy: new Date('2026-11-19T10:00:00Z'), fetchImpl, retry: { tries: 1 }, pausaMs: 0, log });
  assert.deepEqual(urls.map((u) => u.split('/').slice(-2).join('/')), ['16-11-2026/09', '17-11-2026/09', '18-11-2026/09']);
  assert.match(urls[0], /\/EstacionesTerrestresHist\/FiltroCCAA\/16-11-2026\/09$/);
  assert.deepEqual(fallidos, ['18-11-2026']);
  assert.deepEqual(days.map((d) => d.fecha), ['16-11-2026', '17-11-2026']);
  assert.deepEqual(days[0].stations, [{ id: '5', pr: '25', r: 0, p: { g95: 1.5 } }], 'fuera de Cataluña no se guarda');
});

test('descargar no pide más de MAX_DIAS días', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 500 }; };
  await descargar({ dias: 100000, fetchImpl, retry: { tries: 1 }, pausaMs: 0, log: { log() {}, warn() {} } });
  assert.equal(n, MAX_DIAS);
});
