# Gasolina Girona

Web para el móvil con los precios de los carburantes de todas las gasolineras de la provincia de Girona.
Los precios se actualizan cada 30 minutos y se guarda el histórico.

- **Fuente:** API oficial del Geoportal de Gasolineras (Ministerio para la Transición Ecológica), provincia 17.
- **Funciones:** lista ordenada por precio, filtro por combustible y municipio, búsqueda, "Cerca de mí" (radio y orden por distancia), ficha con todos los precios, cómo llegar y gráfico del histórico frente a la media provincial.
- **Se instala como app:** abre la web en el móvil → menú del navegador → "Añadir a pantalla de inicio".

## Cómo funciona

```
Worker de Cloudflare (min 8 y 38) ─┐
GitHub Actions (min 23 y 53) ──────┴─► scripts/collect.mjs ──► docs/data/*.json ──► GitHub Pages (docs/)
```

La programación propia de GitHub se retrasa o se salta a menudo, así que la tarea la lanza sobre todo el
Worker de Cloudflare (`cloudflare/`, plan gratuito) con un token *fine-grained* de GitHub guardado como
secreto `GITHUB_TOKEN` en Cloudflare (permiso *Actions: Read and write* solo en este repositorio).
**Ese token caduca:** GitHub avisa por correo antes; hay que crear otro y cambiarlo en Cloudflare
(Workers → gasolina-girona-cron → Settings → Variables and Secrets).

Al abrir la web se muestra al instante la copia guardada y, a la vez, se piden los precios **en directo**
a la API del Ministerio. Si responde, la cabecera pasa a "En directo HH:MM"; si no, se queda la copia
("Guardado HH:MM"). Tocar esa etiqueta vuelve a consultar. La tarea horaria sigue siendo la que guarda
el histórico para los gráficos. `docs/transform.mjs` es el código común a la web y al recolector.

| Archivo | Contenido |
|---|---|
| `docs/data/latest.json` | Precios actuales de todas las gasolineras |
| `docs/data/h/<id>.json` | Histórico de cada gasolinera (solo se guarda cuando el precio cambia) |
| `docs/data/avg.json` | Media provincial por combustible (últimos 400 días) |

## Publicarlo (una sola vez)

1. Crea un repositorio **público** en GitHub (Pages gratis requiere público) y sube esta carpeta.
2. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main`, carpeta `/docs`.
3. **Settings → Actions → General → Workflow permissions:** *Read and write permissions*.
4. **Actions → Actualizar precios → Run workflow** para lanzarlo la primera vez.
5. La web queda en `https://<tu-usuario>.github.io/<repo>/`.

> GitHub desactiva los workflows programados de un repositorio sin actividad en 60 días; como el propio
> workflow hace commits cada vez que cambian los precios, se mantiene activo solo.

## Avisos por correo si algo deja de funcionar

El workflow **Vigilancia** (`.github/workflows/vigilancia.yml`, cada 2 horas) ejecuta `scripts/vigilar.mjs`,
que comprueba desde fuera:

- que la web publicada responde (página, `app.js`, `transform.mjs`);
- que `data/latest.json` tiene gasolineras y es de hace menos de 2 horas (detecta el Worker parado, el token
  caducado o GitHub Pages sin desplegar);
- que la última ejecución de "Actualizar precios" terminó bien y es reciente;
- que la API del Ministerio responde con datos y permite llamadas desde el navegador (CORS).

Si algo falla, la ejecución termina en error y **GitHub manda un correo**; la web no muestra ningún aviso.
También llega correo si falla "Actualizar precios" o "Pruebas". Para recibirlos:
GitHub → Settings → Notifications → System → **Actions**: marca *Email* y *Only notify for failed workflows*.

Opcional, para enterarse aunque GitHub esté parado: crea un *check* gratis en
[healthchecks.io](https://healthchecks.io) con periodo 30 min y gracia 1 h, y guarda su URL de ping como
secreto `HEALTHCHECK_URL` del repositorio. "Actualizar precios" lo avisa en cada ejecución correcta y
healthchecks.io manda un correo cuando deja de recibirlo.

En local: `node scripts/vigilar.mjs` (sin `GITHUB_TOKEN` se salta la comprobación de la tarea).

## En local

Necesita Node 20+.

```bash
node scripts/collect.mjs   # descarga los precios actuales
node scripts/serve.mjs     # http://localhost:8080
```

Para otra provincia: `PROVINCIA=08 node scripts/collect.mjs` (código INE de provincia).

## Pruebas

| Tipo | Qué comprueba | Cómo se ejecuta |
|---|---|---|
| Unitarias | Conversión de datos del Ministerio, histórico, medias, reintentos, Worker y vigilancia | `npm run test:unit` |
| Integración | Recolector completo contra una API simulada (fallos, idempotencia, ficheros corruptos, ids peligrosos) y servidor local | `npm run test:integration` |
| Contrato | Que la API real del Ministerio mantiene formato, rangos de precios y CORS | `npm run test:contract` (también cada día en CI) |
| E2E (Playwright) | Flujos en Android e iPhone: directo/copia, fallos de red, filtros, búsqueda, "Cerca de mí", ficha y gráfico, accesibilidad (axe, claro y oscuro), diseño adaptable, seguridad, PWA y modo sin conexión | `npm install && npx playwright install && npm run test:e2e` |

`npm test` lanza unitarias e integración (no necesita instalar nada). Todo se ejecuta en GitHub Actions
(`.github/workflows/tests.yml`) en cada cambio de código.
