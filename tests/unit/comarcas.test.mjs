import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comarcaDe, clave } from '../../docs/comarcas.mjs';

test('comarca de municipios corrientes', () => {
  assert.equal(comarcaDe('Girona'), 'Gironès');
  assert.equal(comarcaDe('Figueres'), 'Alt Empordà');
  assert.equal(comarcaDe('Barcelona'), 'Barcelonès');
  assert.equal(comarcaDe('Lleida'), 'Segrià');
  assert.equal(comarcaDe('Tarragona'), 'Tarragonès');
});

test('da igual el artículo, los acentos y las mayúsculas', () => {
  assert.equal(comarcaDe("L'Hospitalet de Llobregat"), 'Barcelonès');
  assert.equal(comarcaDe("Hospitalet de Llobregat (L')"), 'Barcelonès');
  assert.equal(comarcaDe('SARRIA DE TER'), 'Gironès');
  assert.equal(comarcaDe('La Bisbal d’Empordà'), 'Baix Empordà');
  assert.equal(clave("Esquirol, l'"), clave("L'Esquirol"));
});

test('nombres que usa el Ministerio y no coinciden con el oficial', () => {
  assert.equal(comarcaDe('Santa Maria de Corcó'), 'Osona');
  assert.equal(comarcaDe("Castell-Platja d'Aro"), 'Baix Empordà');
  assert.equal(comarcaDe('Sant Carles de la Ràpita'), 'Montsià');
  assert.equal(comarcaDe('Roda de Barà'), 'Tarragonès');
});

test('municipio desconocido: sin comarca', () => {
  assert.equal(comarcaDe('Madrid'), '');
  assert.equal(comarcaDe(''), '');
});
