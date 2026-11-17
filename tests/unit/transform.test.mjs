// Pruebas unitarias de la conversión de datos del Ministerio (docs/transform.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform, parseFechaMinisterio, isValidResponse, FUELS, FUEL_LABELS, API_BASE } from '../../docs/transform.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ministerio-girona.json', import.meta.url), 'utf8'));
const byId = (id) => transform(fixture).find((s) => s.id === id);

// Construye una estación mínima con los campos que lee transform()
const raw = (over = {}) => ({
  ListaEESSPrecio: [{
    IDEESS: '1', 'Rótulo': 'X', 'Dirección': '', Municipio: 'Girona', Localidad: 'GIRONA', 'C.P.': '17001',
    Latitud: '41,9', 'Longitud (WGS84)': '2,8', Horario: '', 'Tipo Venta': 'P', ...over,
  }],
});
const one = (over) => transform(raw(over))[0];

test('convierte todas las estaciones del fixture', () => {
  assert.equal(transform(fixture).length, fixture.ListaEESSPrecio.length);
});

test('precios: coma decimal a número', () => {
  assert.equal(byId('1001').p.g95, 1.279);
  assert.equal(byId('1001').p.gA, 1.599);
});

test('precios vacíos, cero o no numéricos se descartan', () => {
  const s = one({ 'Precio Gasolina 95 E5': '', 'Precio Gasoleo A': '0,000', 'Precio Gasolina 98 E5': 'abc' });
  assert.deepEqual(s.p, {});
});

test('solo se guardan los combustibles conocidos', () => {
  // HAM solo vende biogás, que la app no muestra
  assert.deepEqual(byId('1006').p, {});
  for (const s of transform(fixture)) for (const k of Object.keys(s.p)) assert.ok(k in FUELS, k);
});

test('coordenadas con coma decimal', () => {
  const s = byId('1006');
  assert.equal(s.lat, 41.907083);
  assert.equal(s.lon, 2.773694);
});

test('coordenadas ausentes quedan en null', () => {
  const s = one({ Latitud: '', 'Longitud (WGS84)': '' });
  assert.equal(s.lat, null);
  assert.equal(s.lon, null);
});

test('venta restringida (R) se marca; pública (P) no', () => {
  assert.equal(byId('1004').r, 1);
  assert.equal(byId('1001').r, 0);
});

test('nombres y direcciones en formato título, con acentos', () => {
  assert.equal(byId('1004').n, 'Cooperativa Agrícola');
  assert.equal(byId('1005').d, 'Avinguda Salvador Dalí, 10');
});

test('carreteras y numerales romanos en mayúsculas', () => {
  assert.equal(byId('1003').d, 'N-II Km 728');
  assert.equal(byId('1002').d, 'Carretera N-II Km. 710');
  assert.equal(byId('1006').d, 'Autopista AP7 Km. 70');
  assert.equal(one({ 'Dirección': 'CARRETERA GI-555 KM 3' }).d, 'Carretera GI-555 Km 3');
  assert.equal(one({ 'Dirección': 'CL ALFONSO XII, 161' }).d, 'Cl Alfonso XII, 161');
});

test('palabras normales que empiezan por letras romanas no se tocan', () => {
  assert.equal(one({ Localidad: 'VIC' }).l, 'Vic');
  assert.equal(one({ Localidad: 'VILAMALLA' }).l, 'Vilamalla');
});

test('rótulo vacío pasa a "Sin rótulo"', () => {
  assert.equal(one({ 'Rótulo': '' }).n, 'Sin rótulo');
});

test('el municipio se mantiene tal cual para filtrar', () => {
  assert.equal(byId('1003').m, 'Sarrià de Ter');
});

test('parseFechaMinisterio', () => {
  assert.equal(parseFechaMinisterio('17/11/2026 21:05:28'), '2026-11-17T21:05:28');
  assert.equal(parseFechaMinisterio('2026-11-17'), null);
  assert.equal(parseFechaMinisterio(undefined), null);
});

test('isValidResponse', () => {
  assert.equal(isValidResponse(fixture), true);
  assert.equal(isValidResponse({ ListaEESSPrecio: [] }), false);
  assert.equal(isValidResponse({}), false);
  assert.equal(isValidResponse(null), false);
});

test('cada combustible tiene etiqueta y la URL base apunta a FiltroProvincia', () => {
  assert.deepEqual(Object.keys(FUEL_LABELS), Object.keys(FUELS));
  assert.match(API_BASE, /^https:\/\/sedeaplicaciones\.minetur\.gob\.es\/.+\/FiltroProvincia\/$/);
});
