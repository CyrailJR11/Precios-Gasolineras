// Contrato con la API real del Ministerio para toda Cataluña (FiltroCCAA/09), que es lo que descarga
// la tarea programada y lo que pide la web en directo con «Toda Cataluña». Petición real (~2 MB).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { API_CCAA, CCAA, PROVINCIAS, transform, isValidResponse, parseFechaMinisterio } from '../../docs/transform.mjs';

let res, raw;

before(async () => {
  res = await fetch(API_CCAA + CCAA, { headers: { Origin: 'https://cyrailjr11.github.io' }, signal: AbortSignal.timeout(90000) });
  raw = await res.clone().json();
});

test('Cataluña: responde 200 con JSON y permite llamadas desde el navegador (CORS)', () => {
  assert.equal(res.status, 200);
  const allow = res.headers.get('access-control-allow-origin');
  assert.ok(allow === '*' || allow === 'https://cyrailjr11.github.io', `Access-Control-Allow-Origin: ${allow}`);
  assert.ok(isValidResponse(raw));
  assert.ok(parseFechaMinisterio(raw.Fecha), `Fecha inesperada: ${raw.Fecha}`);
});

test('Cataluña: número razonable de gasolineras (1.000-2.500) y solo de sus 4 provincias', () => {
  const n = raw.ListaEESSPrecio.length;
  assert.ok(n >= 1000 && n <= 2500, String(n));
  const provs = new Set(raw.ListaEESSPrecio.map((e) => e.IDProvincia));
  assert.deepEqual([...provs].sort(), Object.keys(PROVINCIAS).sort());
  for (const e of raw.ListaEESSPrecio) assert.equal(e.IDCCAA, CCAA);
});

test('Cataluña: coordenadas dentro de Cataluña tras la conversión', () => {
  const st = transform(raw);
  const conCoords = st.filter((s) => s.lat != null && s.lon != null);
  assert.ok(conCoords.length > st.length * 0.95);
  for (const s of conCoords) {
    assert.ok(s.lat > 40.4 && s.lat < 42.9 && s.lon > 0.1 && s.lon < 3.4, `${s.id}: ${s.lat},${s.lon}`);
  }
});
