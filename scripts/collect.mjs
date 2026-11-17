// Recolector horario de precios de carburantes de la provincia de Girona.
// Fuente oficial: Ministerio para la Transición Ecológica (Geoportal de Gasolineras).
// Sin dependencias: requiere Node 18+ (fetch nativo).
//
// Genera:
//   docs/data/latest.json      -> estado actual de todas las gasolineras
//   docs/data/h/<IDEESS>.json  -> histórico por gasolinera (solo puntos de cambio)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_BASE, FUELS, FUEL_LABELS, transform, parseFechaMinisterio, isValidResponse } from '../docs/transform.mjs';

const PROVINCIA = process.env.PROVINCIA || '17'; // 17 = Girona
const API = API_BASE + PROVINCIA;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'data');
const HIST = join(DATA, 'h');

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'precios-carburantes-girona/1.0' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!isValidResponse(json)) {
        throw new Error('Respuesta sin estaciones');
      }
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`Intento ${i + 1} fallido: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const now = new Date();
  const raw = await fetchWithRetry(API);
  const stations = transform(raw);
  const ts = Math.floor(now.getTime() / 1000);

  await mkdir(HIST, { recursive: true });

  let changed = 0;
  for (const s of stations) {
    const path = join(HIST, `${s.id}.json`);
    // Formato: { "g95": [[ts, precio], ...], ... } — solo se añade un punto si el precio cambia
    const h = await readJson(path, {});
    let dirty = false;
    for (const [k, v] of Object.entries(s.p)) {
      const arr = (h[k] ||= []);
      const last = arr[arr.length - 1];
      if (!last || last[1] !== v) {
        arr.push([ts, v]);
        dirty = true;
      }
    }
    // Combustible que deja de venderse: se marca con null para cortar la línea
    for (const k of Object.keys(h)) {
      const arr = h[k];
      if (!(k in s.p) && arr.length && arr[arr.length - 1][1] !== null) {
        arr.push([ts, null]);
        dirty = true;
      }
    }
    if (dirty) {
      await writeFile(path, JSON.stringify(h));
      changed++;
    }
  }

  // Media provincial por combustible (solo venta al público), para comparar en el gráfico.
  // Formato: { "g95": [[ts, media], ...] } — se conservan 400 días.
  const avgPath = join(DATA, 'avg.json');
  const avg = await readJson(avgPath, {});
  const cutoff = ts - 400 * 86400;
  for (const k of Object.keys(FUELS)) {
    const vals = stations.filter((s) => !s.r && s.p[k] != null).map((s) => s.p[k]);
    if (vals.length < 3) continue;
    const mean = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    const arr = (avg[k] ||= []).filter((x) => x[0] >= cutoff);
    const last = arr[arr.length - 1];
    if (!last || last[1] !== mean) arr.push([ts, mean]);
    avg[k] = arr;
  }
  await writeFile(avgPath, JSON.stringify(avg));

  const latest = {
    fuente: 'Ministerio para la Transición Ecológica — Geoportal de Gasolineras',
    provincia: PROVINCIA,
    fechaMinisterio: parseFechaMinisterio(raw.Fecha),
    actualizado: now.toISOString(),
    fuels: FUEL_LABELS,
    estaciones: stations,
  };
  await writeFile(join(DATA, 'latest.json'), JSON.stringify(latest));

  console.log(`OK: ${stations.length} estaciones, ${changed} con cambios de precio (${now.toISOString()})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('ERROR:', e);
    process.exit(1);
  });
}
