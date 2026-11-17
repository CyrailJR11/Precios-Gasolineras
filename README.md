# Gasolina Girona

Web para el móvil con los precios de los carburantes de todas las gasolineras de la provincia de Girona.
Los precios se actualizan cada hora y se guarda el histórico.

- **Fuente:** API oficial del Geoportal de Gasolineras (Ministerio para la Transición Ecológica), provincia 17.
- **Funciones:** lista ordenada por precio, filtro por combustible y municipio, búsqueda, "Cerca de mí" (radio y orden por distancia), ficha con todos los precios, cómo llegar y gráfico del histórico frente a la media provincial.
- **Se instala como app:** abre la web en el móvil → menú del navegador → "Añadir a pantalla de inicio".

## Cómo funciona

```
GitHub Actions (cada hora) ──► scripts/collect.mjs ──► docs/data/*.json ──► GitHub Pages (docs/)
```

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

## En local

Necesita Node 18+.

```bash
node scripts/collect.mjs   # descarga los precios actuales
node scripts/serve.mjs     # http://localhost:8080
```

Para otra provincia: `PROVINCIA=08 node scripts/collect.mjs` (código INE de provincia).

## Pruebas

| Tipo | Qué comprueba | Cómo se ejecuta |
|---|---|---|
| Unitarias | Conversión de datos del Ministerio, histórico, medias, reintentos | `npm run test:unit` |
| Integración | Recolector completo contra una API simulada (fallos, idempotencia, ficheros corruptos, ids peligrosos) y servidor local | `npm run test:integration` |
| Contrato | Que la API real del Ministerio mantiene formato, rangos de precios y CORS | `npm run test:contract` (también cada día en CI) |
| E2E (Playwright) | Flujos en Android e iPhone: directo/copia, fallos de red, filtros, búsqueda, "Cerca de mí", ficha y gráfico, accesibilidad (axe, claro y oscuro), diseño adaptable, seguridad, PWA y modo sin conexión | `npm install && npx playwright install && npm run test:e2e` |

`npm test` lanza unitarias e integración (no necesita instalar nada). Todo se ejecuta en GitHub Actions
(`.github/workflows/tests.yml`) en cada cambio de código.
