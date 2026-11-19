// Integración: rellenar el histórico sobre una carpeta de datos ya creada por el recolector
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../scripts/collect.mjs';
import { aplicar, descargar } from '../../scripts/rellenar.mjs';

const cat = JSON.parse(readFileSync(new URL('../fixtures/ministerio-cataluna.json', import.meta.url), 'utf8'));
const silent = { warn() {}, log() {} };
const readJ = async (p) => JSON.parse(await readFile(p, 'utf8'));
const NOW = new Date('2026-11-19T18:00:00Z');

test('rellena 3 días antes del primer dato de cada gasolinera, conserva lo recogido y es idempotente', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gg-hist-'));
  try {
    // Estado actual: una recogida normal de hoy
    await run({ dataDir: dir, now: NOW, log: silent, fetchImpl: async () => ({ ok: true, json: async () => cat }) });
    const hoyTs = NOW.getTime() / 1000;

    // El histórico del Ministerio da 1 céntimo más caro cada día hacia atrás
    let dia = 0;
    const fetchImpl = async () => {
      const bump = 0.01 * (3 - dia++);
      const body = JSON.parse(JSON.stringify(cat));
      for (const e of body.ListaEESSPrecio) {
        if (e['Precio Gasolina 95 E5']) e['Precio Gasolina 95 E5'] = (parseFloat(e['Precio Gasolina 95 E5'].replace(',', '.')) + bump).toFixed(3).replace('.', ',');
      }
      return { ok: true, json: async () => body };
    };
    const { days } = await descargar({ dias: 3, hoy: NOW, fetchImpl, pausaMs: 0, log: silent });
    const r = await aplicar({ days, dataDir: dir, log: silent });
    assert.equal(r.changed, 10, 'todas las gasolineras con precios (HAM no tiene)');

    const h = await readJ(join(dir, 'h', '2003.json')); // Lleida
    const g = h.g95.map(([ts, v]) => [new Date(ts * 1000).toISOString().slice(0, 10), v]);
    assert.deepEqual(g, [['2026-11-16', 1.529], ['2026-11-17', 1.519], ['2026-11-18', 1.509], ['2026-11-19', 1.499]]);
    assert.equal(h.g95.at(-1)[0], hoyTs, 'el dato recogido hoy sigue igual');

    const avg = await readJ(join(dir, 'avg.json'));
    assert.equal(avg['17'].g95.length, 4);
    assert.equal(avg['17'].g95.at(-1)[0], hoyTs);

    // Otra vez con los mismos días: no cambia nada
    const again = await aplicar({ days, dataDir: dir, log: silent });
    assert.equal(again.changed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
