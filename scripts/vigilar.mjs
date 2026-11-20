// Vigilancia: comprueba desde fuera que todo sigue funcionando y termina con error si algo falla.
// Lo ejecuta el workflow "Vigilancia" (.github/workflows/vigilancia.yml). Cuando una ejecución falla,
// GitHub manda un correo al dueño del repositorio, así que el aviso llega por correo y la web no cambia.
//
// Comprueba:
//   1. La web publicada en GitHub Pages responde (página, código y datos).
//   2. Los datos publicados son recientes: si la tarea de precios deja de ejecutarse (Worker de
//      Cloudflare parado, token de GitHub caducado, GitHub Pages sin desplegar...), se nota aquí.
//   3. La última ejecución de "Actualizar precios" terminó bien.
//   4. La API del Ministerio responde con datos válidos y permite llamadas desde el navegador (CORS).
//
// Sin dependencias: requiere Node 20+. Todo es inyectable para poder probarlo.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';

import { API_CCAA, CCAA, PROVINCIAS, isValidResponse } from '../docs/transform.mjs';

export const SITE = 'https://cyrailjr11.github.io/Precios-Gasolineras/';
export const REPO = 'CyrailJR11/Precios-Gasolineras';
export const MAX_AGE_MIN = 120; // la tarea va cada 30 min: 2 h son 4 ejecuciones perdidas seguidas
export const MIN_STATIONS = 1000; // Cataluña tiene unas 1.600

const TZ = 'Europe/Madrid';
const horaGirona = (d) => d.toLocaleString('es-ES', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });

async function get(fetchImpl, url, { tries = 3, delayMs = 3000, timeoutMs = 30_000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'gasolina-girona-vigilancia', 'Cache-Control': 'no-cache', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 && i < tries - 1) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

export async function checkWeb({ fetchImpl, site, retry }) {
  const fallos = [];
  for (const [path, expect] of [['', /<title>Combustibles Cataluña<\/title>/], ['app.js', /fetchLive/], ['transform.mjs', /export function transform/]]) {
    const res = await get(fetchImpl, site + path, retry);
    if (res.status !== 200) fallos.push(`${path || 'página principal'}: HTTP ${res.status}`);
    else if (!expect.test(await res.text())) fallos.push(`${path || 'página principal'}: contenido inesperado`);
  }
  return fallos.length ? { ok: false, detail: fallos.join('; ') } : { ok: true, detail: 'página, app.js y transform.mjs responden' };
}

export async function checkDatos({ fetchImpl, site, now, maxAgeMin, retry }) {
  const res = await get(fetchImpl, `${site}data/latest.json?t=${now.getTime()}`, retry);
  if (res.status !== 200) return { ok: false, detail: `data/latest.json: HTTP ${res.status}` };
  let d;
  try { d = await res.json(); } catch { return { ok: false, detail: 'data/latest.json no es JSON válido' }; }
  const n = Array.isArray(d?.estaciones) ? d.estaciones.length : 0;
  if (n < MIN_STATIONS) return { ok: false, detail: `data/latest.json solo tiene ${n} gasolineras` };
  const faltan = Object.keys(PROVINCIAS).filter((p) => !d.estaciones.some((s) => s.pr === p));
  if (faltan.length) return { ok: false, detail: `data/latest.json no trae gasolineras de ${faltan.map((p) => PROVINCIAS[p]).join(', ')}` };
  const at = new Date(d.actualizado);
  if (Number.isNaN(at.getTime())) return { ok: false, detail: `fecha "actualizado" no válida: ${d.actualizado}` };
  const ageMin = Math.round((now - at) / 60000);
  if (ageMin > maxAgeMin) {
    return {
      ok: false,
      detail: `los precios publicados son de hace ${ageMin} min (${horaGirona(at)}, hora de Girona); el máximo es ${maxAgeMin} min. ` +
        'Revisa el Worker de Cloudflare y su token GITHUB_TOKEN, la tarea "Actualizar precios" y GitHub Pages.',
    };
  }
  return { ok: true, detail: `${n} gasolineras, actualizado hace ${ageMin} min (${horaGirona(at)})` };
}

export async function checkTarea({ fetchImpl, repo, token, now, maxAgeMin, retry }) {
  if (!token) return { ok: true, detail: 'sin token de GitHub: comprobación omitida' };
  const res = await get(fetchImpl, `https://api.github.com/repos/${repo}/actions/workflows/precios.yml/runs?per_page=5`, {
    ...retry,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status !== 200) return { ok: false, detail: `API de GitHub: HTTP ${res.status}` };
  const runs = ((await res.json()).workflow_runs || []).filter((r) => r.status === 'completed');
  const last = runs[0];
  if (!last) return { ok: false, detail: 'no hay ninguna ejecución terminada de "Actualizar precios"' };
  const at = new Date(last.created_at);
  const ageMin = Math.round((now - at) / 60000);
  if (last.conclusion !== 'success') {
    return { ok: false, detail: `la última ejecución (${horaGirona(at)}) terminó en "${last.conclusion}": ${last.html_url}` };
  }
  if (ageMin > maxAgeMin) {
    return { ok: false, detail: `la última ejecución fue hace ${ageMin} min (${horaGirona(at)}): el Worker de Cloudflare no la está lanzando` };
  }
  return { ok: true, detail: `última ejecución correcta hace ${ageMin} min (lanzada por ${last.event})` };
}

export async function checkMinisterio({ fetchImpl, apiUrl, site, retry }) {
  const origin = new URL(site).origin;
  const res = await get(fetchImpl, apiUrl, { timeoutMs: 60_000, ...retry, headers: { Accept: 'application/json', Origin: origin } });
  if (res.status !== 200) return { ok: false, detail: `API del Ministerio: HTTP ${res.status}` };
  const allow = res.headers.get('access-control-allow-origin');
  let json;
  try { json = await res.json(); } catch { return { ok: false, detail: 'la API del Ministerio no devuelve JSON válido' }; }
  if (!isValidResponse(json)) return { ok: false, detail: 'la API del Ministerio responde sin gasolineras' };
  if (allow !== '*' && allow !== origin) {
    return { ok: false, detail: `la API del Ministerio ya no permite llamadas desde la web (CORS: ${allow}); el modo en directo no funcionará` };
  }
  return { ok: true, detail: `${json.ListaEESSPrecio.length} gasolineras, CORS correcto` };
}

export const CHECKS = [
  ['Web publicada', checkWeb],
  ['Datos recientes', checkDatos],
  ['Tarea "Actualizar precios"', checkTarea],
  ['API del Ministerio', checkMinisterio],
];

/** Ejecuta todas las comprobaciones. Nunca lanza: un error inesperado cuenta como fallo. */
export async function run({
  fetchImpl = fetch,
  site = process.env.SITE_URL || SITE,
  repo = process.env.GITHUB_REPOSITORY || REPO,
  token = process.env.GITHUB_TOKEN,
  apiUrl = API_CCAA + CCAA,
  now = new Date(),
  maxAgeMin = +(process.env.MAX_AGE_MIN || MAX_AGE_MIN),
  retry = {},
  checks = CHECKS,
} = {}) {
  const ctx = { fetchImpl, site, repo, token, apiUrl, now, maxAgeMin, retry };
  const results = [];
  for (const [name, fn] of checks) {
    try {
      results.push({ name, ...(await fn(ctx)) });
    } catch (e) {
      results.push({ name, ok: false, detail: `error: ${e.message}` });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export function informe({ ok, results }, now = new Date()) {
  const lines = [
    `## ${ok ? '✅ Todo funciona' : '❌ Algo ha dejado de funcionar'}`,
    '',
    `Comprobado el ${horaGirona(now)} (hora de Girona).`,
    '',
    '| Comprobación | Estado | Detalle |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.ok ? '✅' : '❌'} | ${r.detail.replace(/\|/g, '\\|')} |`),
  ];
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const now = new Date();
  const r = await run({ now });
  const md = informe(r, now);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  for (const x of r.results.filter((x) => !x.ok)) console.log(`::error title=${x.name}::${x.detail}`);
  process.exit(r.ok ? 0 : 1);
}
