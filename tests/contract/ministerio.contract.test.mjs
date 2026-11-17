// Contrato con la API real del Ministerio: si cambian el formato, estas pruebas avisan antes de que
// la web o el histórico se estropeen. Hacen una petición real (~300 KB).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE, FUELS, transform, isValidResponse, parseFechaMinisterio } from '../../docs/transform.mjs';

const URL_GIRONA = API_BASE + '17';
let res, raw;

before(async () => {
  res = await fetch(URL_GIRONA, { headers: { Origin: 'https://cyrailjr11.github.io' }, signal: AbortSignal.timeout(60000) });
  raw = await res.clone().json();
});

test('responde 200 con JSON', () => {
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});

test('permite llamadas desde el navegador (CORS), necesario para el modo en directo', () => {
  const allow = res.headers.get('access-control-allow-origin');
  assert.ok(allow === '*' || allow === 'https://cyrailjr11.github.io', `Access-Control-Allow-Origin: ${allow}`);
});

test('estructura: Fecha con formato dd/mm/aaaa hh:mm:ss y lista de estaciones', () => {
  assert.ok(isValidResponse(raw));
  assert.ok(parseFechaMinisterio(raw.Fecha), `Fecha inesperada: ${raw.Fecha}`);
});

test('número razonable de gasolineras en Girona (100-600)', () => {
  assert.ok(raw.ListaEESSPrecio.length >= 100 && raw.ListaEESSPrecio.length <= 600, String(raw.ListaEESSPrecio.length));
});

test('cada estación tiene los campos que usa la app', () => {
  const required = ['IDEESS', 'Rótulo', 'Dirección', 'Municipio', 'Localidad', 'C.P.', 'Latitud', 'Longitud (WGS84)', 'Horario', 'Tipo Venta', 'IDProvincia'];
  const fuelFields = Object.values(FUELS).map(([f]) => f);
  for (const e of raw.ListaEESSPrecio) {
    for (const f of [...required, ...fuelFields]) assert.ok(f in e, `falta "${f}" en ${e.IDEESS}`);
    assert.equal(e.IDProvincia, '17');
    assert.match(e.IDEESS, /^\d+$/);
    assert.match(e['Tipo Venta'], /^[PR]$/);
  }
});

test('los precios usan coma decimal y están en un rango creíble (0,3 - 4 €)', () => {
  const fuelFields = Object.values(FUELS).map(([f]) => f);
  let count = 0;
  for (const e of raw.ListaEESSPrecio) {
    for (const f of fuelFields) {
      if (!e[f]) continue;
      assert.match(e[f], /^\d+,\d{1,3}$/, `${e.IDEESS} ${f} = ${e[f]}`);
      const v = parseFloat(e[f].replace(',', '.'));
      assert.ok(v > 0.3 && v < 4, `${e.IDEESS} ${f} = ${v}`);
      count++;
    }
  }
  assert.ok(count > 300, 'demasiados pocos precios: ' + count);
});

test('la conversión deja coordenadas dentro de la provincia de Girona', () => {
  const st = transform(raw).filter((s) => s.lat != null);
  assert.ok(st.length > 0.9 * raw.ListaEESSPrecio.length);
  for (const s of st) {
    assert.ok(s.lat > 41.6 && s.lat < 42.55 && s.lon > 1.7 && s.lon < 3.4, `${s.id} ${s.lat},${s.lon}`);
  }
});

test('los combustibles principales siguen existiendo', () => {
  const st = transform(raw);
  for (const k of ['g95', 'gA', 'g98']) {
    assert.ok(st.filter((s) => s.p[k] != null).length > 50, `pocas gasolineras con ${k}`);
  }
});
