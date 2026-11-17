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
