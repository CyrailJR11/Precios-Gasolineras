// Cloudflare Worker (plan gratuito) que lanza cada 30 minutos la tarea "Actualizar precios" de GitHub.
//
// GitHub retrasa o descarta a veces sus tareas programadas cuando tiene mucha carga; este Worker
// las lanza desde fuera con la API oficial (workflow_dispatch), que es lo mismo que pulsar
// "Run workflow". No tiene dirección pública: solo se ejecuta con su programación (cron).
//
// Necesita un secreto GITHUB_TOKEN: un token "fine-grained" de GitHub limitado al repositorio
// Precios-Gasolineras con el permiso "Actions: Read and write". Se guarda cifrado en Cloudflare.

const OWNER = 'CyrailJR11';
const REPO = 'Precios-Gasolineras';
const WORKFLOW = 'precios.yml';
const BRANCH = 'main';

export async function dispatch(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) {
    console.error('Falta el secreto GITHUB_TOKEN: no se puede lanzar la tarea');
    return { ok: false, status: 0, error: 'sin token' };
  }
  const res = await fetchImpl(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gasolina-girona-cron',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: BRANCH }),
  });
  // GitHub responde 204 sin contenido cuando la tarea se ha lanzado
  if (res.status === 204) {
    console.log('Tarea "Actualizar precios" lanzada');
    return { ok: true, status: 204 };
  }
  const error = (await res.text()).slice(0, 300);
  console.error(`GitHub respondió ${res.status}: ${error}`);
  return { ok: false, status: res.status, error };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatch(env).then((r) => {
      // Lanzar el error hace que el panel de Cloudflare marque la ejecución como fallida
      if (!r.ok) throw new Error(`No se pudo lanzar la tarea (HTTP ${r.status}): ${r.error}`);
    }));
  },
};
