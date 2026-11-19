// Contrato con el servicio histórico real del Ministerio (un día de toda Cataluña), que usa
// scripts/rellenar.mjs para rellenar el histórico hacia atrás. Petición real (~2 MB).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CCAA, FUELS, PROVINCIAS, isValidResponse, transform } from '../../docs/transform.mjs';
import { API_HIST_CCAA, fechaApi } from '../../scripts/rellenar.mjs';

const d = new Date(Date.now() - 7 * 86400_000);
let res, raw;

before(async () => {
  res = await fetch(`${API_HIST_CCAA}${fechaApi(d)}/${CCAA}`, { signal: AbortSignal.timeout(120000) });
  raw = await res.clone().json();
});

test('histórico: responde 200 con gasolineras de las 4 provincias de Cataluña', () => {
  assert.equal(res.status, 200);
  assert.ok(isValidResponse(raw));
  const n = raw.ListaEESSPrecio.length;
  assert.ok(n >= 1000 && n <= 2500, String(n));
  assert.deepEqual([...new Set(raw.ListaEESSPrecio.map((e) => e.IDProvincia))].sort(), Object.keys(PROVINCIAS).sort());
});

test('histórico: mismos campos que el servicio de hoy y precios creíbles', () => {
  const required = ['IDEESS', 'IDProvincia', 'Tipo Venta', 'Precio Gasolina 95 E5', 'Precio Gasoleo A'];
  for (const e of raw.ListaEESSPrecio) for (const f of required) assert.ok(f in e, `falta "${f}" en ${e.IDEESS}`);
  const st = transform(raw);
  for (const k of ['g95', 'gA']) assert.ok(st.filter((s) => s.p[k] != null).length > 500, `pocas gasolineras con ${k}`);
  for (const s of st) for (const [k, v] of Object.entries(s.p)) assert.ok(v > 0.3 && v < 4, `${s.id} ${k} = ${v}`);
  assert.ok(Object.keys(FUELS).length);
});
