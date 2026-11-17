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

const PROVINCIA = process.env.PROVINCIA || '17'; // 17 = Girona
const API = `https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/${PROVINCIA}`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'data');
const HIST = join(DATA, 'h');

// Clave corta -> [nombre del campo en la API, etiqueta para la web]
export const FUELS = {
  g95:  ['Precio Gasolina 95 E5', 'Gasolina 95'],
  g95p: ['Precio Gasolina 95 E5 Premium', 'Gasolina 95 Premium'],
  g98:  ['Precio Gasolina 98 E5', 'Gasolina 98'],
  e10:  ['Precio Gasolina 95 E10', 'Gasolina 95 E10'],
  gA:   ['Precio Gasoleo A', 'Diésel'],
  gP:   ['Precio Gasoleo Premium', 'Diésel Premium'],
  gB:   ['Precio Gasoleo B', 'Gasóleo B (agrícola)'],
  hvo:  ['Precio Diésel Renovable', 'Diésel renovable (HVO)'],
  glp:  ['Precio Gases licuados del petróleo', 'GLP / Autogás'],
  gnc:  ['Precio Gas Natural Comprimido', 'GNC'],
  adb:  ['Precio Adblue', 'AdBlue'],
};

const num = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const titleCase = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/(^|[\s\-/'(.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
    // Carreteras y numerales en mayúsculas: "N-Ii" -> "N-II", "Ap7" -> "AP7", "Gi-555" -> "GI-555"
    .replace(/[\p{L}\d]+(?:-[\p{L}\d]+)*/gu, (w) =>
      /\d/.test(w) || /^(n|c|a|b|ap|gi|bv)-/i.test(w)
        ? w.toUpperCase()
        : w.replace(/\b[ivx]{2,}\b/gi, (r) => r.toUpperCase()))
    .trim();

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
      if (!Array.isArray(json.ListaEESSPrecio) || json.ListaEESSPrecio.length === 0) {
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

// "17/11/2026 21:05:28" (hora peninsular) -> ISO con zona Europe/Madrid
function parseFechaMinisterio(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(f || '');
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`;
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function transform(raw) {
  return raw.ListaEESSPrecio.map((e) => {
    const p = {};
    for (const [k, [field]] of Object.entries(FUELS)) {
      const v = num(e[field]);
      if (v != null && v > 0) p[k] = v;
    }
    return {
      id: e['IDEESS'],
      n: titleCase(e['Rótulo']) || 'Sin rótulo',
      d: titleCase(e['Dirección']),
      m: e['Municipio'],
      l: titleCase(e['Localidad']),
      cp: e['C.P.'],
      lat: num(e['Latitud']),
      lon: num(e['Longitud (WGS84)']),
      h: e['Horario'],
      // Tipo Venta: P = público, R = restringido (socios / flotas)
      r: e['Tipo Venta'] === 'R' ? 1 : 0,
      p,
    };
  });
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
    fuels: Object.fromEntries(Object.entries(FUELS).map(([k, [, label]]) => [k, label])),
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
