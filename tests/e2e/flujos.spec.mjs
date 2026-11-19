// Flujos de uso en el móvil
import { test, expect } from '@playwright/test';
import { mockData, waitLiveSettled, cardPrices, cardNames, GIRONA, RAW, RAW_CAT, snapshot, abrirZona } from './helpers.mjs';

test.describe('carga de datos y barra de origen', () => {
  test('muestra los precios en directo del Ministerio, ordenados por precio', async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);

    const src = page.locator('#source');
    await expect(src).toHaveAttribute('data-kind', 'live');
    await expect(src).toContainText('Actualizado a las');
    await expect(src).toContainText('En directo del Ministerio');
    await expect(src).toContainText(/copia \d{2}:\d{2}/);

    // Gasolina 95 por defecto; la de venta restringida (1004) sale siempre, con su etiqueta
    await expect.poll(() => cardPrices(page)).toEqual(['1,199', '1,269', '1,279', '1,549', '1,589', '1,629']);
    await expect.poll(() => cardNames(page)).toEqual(['Cooperativa Agrícola', 'Petrem', 'Ballenoil', 'Galp', 'Repsol', 'Shell']);
    await expect(page.locator('#summary')).toContainText('1,199 €');
    await expect(page.locator('#summary')).toContainText('6');
    await expect(page.locator('.card').first()).toContainText('Más barata');
  });

  test('primero enseña la copia horaria y luego la sustituye por el directo', async ({ page }) => {
    await mockData(page, { live: { delay: 2500 } });
    await page.goto('/');
    const src = page.locator('#source');
    // Copia (1 céntimo más cara) mientras se consulta
    await expect(page.locator('.card .price .v').first()).toHaveText('1,209');
    await expect(src).toContainText('Consultando al Ministerio');
    await expect(src).toContainText('Copia de GitHub');
    // Llega el directo
    await expect(src).toHaveAttribute('data-kind', 'live', { timeout: 10_000 });
    await expect(page.locator('.card .price .v').first()).toHaveText('1,199');
  });

  test('si el Ministerio no responde, se queda la copia horaria y lo indica; tocar reintenta', async ({ page }) => {
    let liveOk = false;
    await mockData(page, {
      live: (route) => liveOk
        ? route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(RAW) })
        : route.abort('failed'),
    });
    await page.goto('/');
    await waitLiveSettled(page);

    const src = page.locator('#source');
    await expect(src).toHaveAttribute('data-kind', 'error');
    await expect(src).toContainText('Copia de GitHub');
    await expect(src).toContainText('El Ministerio no responde');
    await expect(page.locator('.card')).toHaveCount(6);
    await expect(page.locator('.card .price .v').first()).toHaveText('1,209');

    liveOk = true;
    await src.click();
    await expect(src).toHaveAttribute('data-kind', 'live');
    await expect(page.locator('.card .price .v').first()).toHaveText('1,199');
  });

  test('sin copia horaria, funciona solo con el directo', async ({ page }) => {
    await mockData(page, { snap: 'fail' });
    await page.goto('/');
    await waitLiveSettled(page);
    await expect(page.locator('#source')).toHaveAttribute('data-kind', 'live');
    await expect(page.locator('.card')).toHaveCount(6);
  });

  test('si fallan las dos fuentes, avisa al usuario', async ({ page }) => {
    await mockData(page, { snap: 'fail', live: 'fail' });
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('No se han podido cargar los datos');
    await expect(page.locator('#source')).toContainText('Toca para reintentar');
    await expect(page.locator('.card')).toHaveCount(0);
  });

  test('una copia horaria de ayer muestra la fecha y "hace X h"', async ({ page }) => {
    await mockData(page, { live: 'fail', snap: snapshot({ hoursAgo: 26 }) });
    await page.goto('/');
    await waitLiveSettled(page);
    await expect(page.locator('#source .src-main')).toContainText(/Actualizado a las \d+ \w+\.?, \d{2}:\d{2} \(hace 26 h\)/);
  });
});

test.describe('filtros', () => {
  test.beforeEach(async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
  });

  test('cambiar de combustible reordena la lista', async ({ page }) => {
    await page.getByRole('radio', { name: 'Diésel', exact: true }).click();
    await expect.poll(() => cardPrices(page)).toEqual(['1,450', '1,589', '1,599', '1,659', '1,689', '1,729']);
    await page.getByRole('radio', { name: 'GLP / Autogás' }).click();
    await expect.poll(() => cardNames(page)).toEqual(['Petrem']);
  });

  test('combustible que solo vende una gasolinera restringida: sale con su etiqueta', async ({ page }) => {
    await page.getByRole('radio', { name: /Gasóleo B/ }).click();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('Restringida');
  });

  test('la venta restringida se incluye siempre y su casilla no se ve', async ({ page }) => {
    await expect(page.getByLabel('Incluir venta restringida')).toBeHidden();
    await expect(page.locator('.card')).toHaveCount(6);
    await expect(page.locator('.card').first()).toContainText('Cooperativa Agrícola');
    await expect(page.locator('.card').first()).toContainText('1,199');
  });

  test('filtrar por municipio', async ({ page }) => {
    await abrirZona(page);

    await page.getByLabel('Municipio').selectOption('Figueres');
    await expect.poll(() => cardNames(page)).toEqual(['Cooperativa Agrícola', 'Shell']);
    // El municipio está dentro de su comarca: para ir a otra comarca se vuelve a «Todas»
    await expect(page.getByLabel('Comarca', { exact: true })).toHaveValue('Alt Empordà');
    await abrirZona(page);

    await page.getByLabel('Comarca', { exact: true }).selectOption('');
    await abrirZona(page);

    await page.getByLabel('Municipio').selectOption('Girona');
    await expect.poll(() => cardNames(page)).toEqual(['Ballenoil', 'Repsol']);
    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('');
    await expect(page.getByLabel('Municipio')).toHaveValue('');
    await expect(page.locator('.card')).toHaveCount(6);
  });

  test('buscar por marca o dirección, sin importar acentos ni mayúsculas', async ({ page }) => {
    const q = page.getByLabel('Buscar marca o dirección');
    await q.fill('REPSOL');
    await expect(page.locator('.card')).toHaveCount(1);
    await q.fill('dali');
    await expect.poll(() => cardNames(page)).toEqual(['Shell']);
    await q.fill('zzzz');
    await expect(page.locator('.card')).toHaveCount(0);
    await q.fill('');
    await expect(page.locator('.card')).toHaveCount(6);
  });

  test('las preferencias (combustible y municipio) se recuerdan al volver', async ({ page }) => {
    await page.getByRole('radio', { name: 'Diésel', exact: true }).click();
    await abrirZona(page);

    await page.getByLabel('Municipio').selectOption('Girona');
    await page.reload();
    await waitLiveSettled(page);
    await expect(page.getByRole('radio', { name: 'Diésel', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('17');
    await expect(page.getByLabel('Comarca', { exact: true })).toHaveValue('Gironès');
    await expect(page.getByLabel('Municipio')).toHaveValue('Girona');
    await expect.poll(() => cardPrices(page)).toEqual(['1,599', '1,689']);
  });
});

test.describe('cerca de mí', () => {
  test('ordena por precio dentro del radio y luego por distancia', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(GIRONA);
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);

    await page.getByRole('button', { name: 'Cerca de mí' }).click();
    await expect(page.getByRole('button', { name: 'Cerca de mí' })).toHaveAttribute('aria-pressed', 'true');
    for (const z of ['Provincia', 'Comarca', 'Municipio']) await expect(page.getByLabel(z, { exact: true })).toBeDisabled();

    // Radio 10 km por defecto: solo 3 gasolineras
    await expect.poll(() => cardNames(page)).toEqual(['Petrem', 'Ballenoil', 'Repsol']);
    await expect(page.locator('.card .meta').first()).toContainText('km');

    await page.getByLabel('Ordenar por').selectOption('dist');
    await expect.poll(() => cardNames(page)).toEqual(['Repsol', 'Ballenoil', 'Petrem']);

    await page.getByLabel('Radio').selectOption('50');
    await expect(page.locator('.card')).toHaveCount(6);

    // Desactivar vuelve al filtro por municipio
    await page.getByRole('button', { name: 'Cerca de mí' }).click();
    for (const z of ['Provincia', 'Comarca', 'Municipio']) await expect(page.getByLabel(z, { exact: true })).toBeEnabled();
    await expect(page.locator('#nearControls')).toBeHidden();
  });

  test('sin permiso de ubicación, explica qué pasa y no se queda bloqueado', async ({ page, context }) => {
    await context.clearPermissions();
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, ko) => setTimeout(() => ko({ code: 1, message: 'denied' }), 50);
    });
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    await page.getByRole('button', { name: 'Cerca de mí' }).click();
    await expect(page.locator('#status')).toContainText('Permiso de ubicación denegado');
    await expect(page.getByRole('button', { name: 'Cerca de mí' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.card')).toHaveCount(6);
  });
});

test.describe('ficha de gasolinera', () => {
  test.beforeEach(async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('.card', { hasText: 'Repsol' }).click();
  });

  test('muestra precios, horario y enlace para llegar', async ({ page }) => {
    const dlg = page.locator('#detail');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#dTitle')).toHaveText('Repsol');
    await expect(dlg.locator('#dAddr')).toContainText('Carretera N-II Km. 710');
    await expect(dlg.locator('#dHours')).toContainText('06:00-22:00');
    await expect(dlg.locator('#dPrices .stat')).toHaveCount(4);
    await expect(dlg.getByRole('link', { name: 'Cómo llegar' }))
      .toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=41.99,2.82');
  });

  test('gráfico del histórico: líneas, leyenda, periodos y tooltip', async ({ page }) => {
    const chart = page.locator('#chart');
    await expect(chart.locator('svg path.line:not(.ref)')).toHaveCount(1);
    await expect(chart.locator('svg path.line.ref')).toHaveCount(1);
    await expect(chart.locator('.legend')).toContainText('Media provincia');

    for (const label of ['7 días', '90 días', '1 año', '30 días']) {
      await page.locator('#dRange').getByRole('radio', { name: label }).click();
      await expect(page.locator('#dRange').getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
      await expect(chart.locator('svg path.line:not(.ref)')).toHaveAttribute('d', /^M/);
    }

    const box = await chart.locator('svg').boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await expect(chart.locator('.tip')).toBeVisible();
    await expect(chart.locator('.tip')).toContainText('€');
    await expect(chart.locator('.tip')).toContainText('Media');
    // El globo va en la franja de encima del gráfico: no tapa las líneas
    const tip = await chart.locator('.tip').boundingBox();
    expect(tip.y + tip.height).toBeLessThanOrEqual(box.y + 1);
    expect(tip.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(tip.x + tip.width).toBeLessThanOrEqual(box.x + box.width + 1);

    // Cambiar de combustible en el gráfico
    await page.locator('#dFuelChips').getByRole('radio', { name: 'Diésel', exact: true }).click();
    await expect(page.locator('#dFuelChips').getByRole('radio', { name: 'Diésel', exact: true })).toHaveAttribute('aria-checked', 'true');
  });

  test('tabla de cambios de precio como alternativa al gráfico', async ({ page }) => {
    await page.getByText('Ver cambios de precio en tabla').click();
    const rows = page.locator('#dTable tr');
    expect(await rows.count()).toBeGreaterThan(5);
    await expect(rows.nth(1)).toContainText('1,589 €');
  });

  test('la tabla sigue el periodo elegido, sin avisos de falta de datos', async ({ page }) => {
    // El histórico de prueba empieza hace 30 días
    await page.getByText('Ver cambios de precio en tabla').click();
    const rows = page.locator('#dTable tr');
    const range = page.locator('#dRange');
    await range.getByRole('radio', { name: '7 días' }).click();
    await expect(rows).toHaveCount(5); // cabecera + precio al empezar + 3 cambios
    await range.getByRole('radio', { name: '1 año' }).click();
    await expect(rows).toHaveCount(12);
    await expect(page.locator('#chart')).not.toContainText('Solo hay datos');
  });

  test('el eje de fechas abarca el periodo elegido aunque haya menos datos', async ({ page }) => {
    const firstLabel = () => page.locator('#chart svg text.axis-label[text-anchor="start"]').textContent();
    const fmt = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000)
      .toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short' });
    for (const [label, days] of [['7 días', 7], ['90 días', 90]]) {
      await page.locator('#dRange').getByRole('radio', { name: label }).click();
      await expect.poll(firstLabel).toBe(fmt(days));
    }
  });

  test('con «1 año» el eje muestra todos los meses', async ({ page }) => {
    await page.locator('#dRange').getByRole('radio', { name: '1 año' }).click();
    const labels = page.locator('#chart svg text.axis-label.month');
    await expect.poll(() => labels.count()).toBeGreaterThanOrEqual(12);
    const mes = new Date(Date.now() - 180 * 86400_000)
      .toLocaleString('es-ES', { timeZone: 'Europe/Madrid', month: 'short' }).replace('.', '').slice(0, 3);
    await expect(labels.filter({ hasText: new RegExp(`^(${mes}|${mes[0].toUpperCase()})$`) })).toHaveCount(1);
  });

  test('se cierra con el botón, con Escape y tocando fuera', async ({ page }) => {
    const dlg = page.locator('#detail');
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dlg).toBeHidden();

    await page.locator('.card', { hasText: 'Repsol' }).click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await page.locator('.card', { hasText: 'Repsol' }).click();
    await expect(dlg).toBeVisible();
    await page.mouse.click(5, 5); // fondo del diálogo
    await expect(dlg).toBeHidden();
  });
});

test('gasolinera sin histórico guardado: avisa en vez de romper el gráfico', async ({ page }) => {
  await mockData(page);
  await page.route('**/data/h/*.json*', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await waitLiveSettled(page);
  await page.locator('.card', { hasText: 'Galp' }).click();
  // Sin histórico se dibuja solo el precio en directo y se explica
  await expect(page.locator('#chart')).toContainText(/histórico se acumula|Aún no hay histórico/);
});

test.describe('toda Cataluña', () => {
  test('por defecto muestra las 4 provincias y pide al Ministerio toda la comunidad', async ({ page }) => {
    const urls = [];
    page.on('request', (r) => { if (/minetur/.test(r.url())) urls.push(r.url()); });
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    await expect(page.locator('#source')).toHaveAttribute('data-kind', 'live');
    await expect(page.locator('#prov option:checked')).toHaveText('Toda Cataluña');
    await expect(page.locator('#comarca option:checked')).toHaveText('Todas');
    await expect(page.locator('#muni option:checked')).toHaveText('Todos');
    await expect(page.locator('.card')).toHaveCount(10);
    await expect(page.locator('.card').first()).toContainText('1,199');
    expect(urls.some((u) => /FiltroCCAA\/09$/.test(u))).toBe(true);
    // Las cuatro provincias, ordenadas por nombre
    expect(await page.locator('#prov option').allTextContents()).toEqual(['Toda Cataluña', 'Barcelona', 'Girona', 'Lleida', 'Tarragona']);
  });

  test('elegir una provincia filtra y solo pide en directo esa provincia', async ({ page }) => {
    const urls = [];
    page.on('request', (r) => { if (/minetur/.test(r.url())) urls.push(r.url()); });
    await page.addInitScript(() => localStorage.setItem('gg.scope', '"25"'));
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    await expect(page.locator('#source')).toHaveAttribute('data-kind', 'live');
    await expect.poll(() => cardNames(page)).toEqual(['Petrocat']);
    expect(urls.filter((u) => /FiltroProvincia\/25$/.test(u)).length).toBeGreaterThan(0);
    expect(urls.some((u) => /FiltroCCAA/.test(u))).toBe(false);

    // Barcelona aún no está en directo: enseña la copia (1 céntimo más cara) y luego el directo
    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('08');
    await expect.poll(() => cardPrices(page)).toEqual(['1,259', '1,659']);
    await waitLiveSettled(page);
    expect(urls.some((u) => /FiltroProvincia\/08$/.test(u))).toBe(true);
    await expect(page.locator('#summary')).toContainText('2');

    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('Tarragona');
    await expect.poll(() => cardNames(page)).toEqual(['Galp']);
  });

  test('quien tenía guardado un municipio de Girona lo sigue viendo', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gg.muni', '"Figueres"'));
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('17');
    await expect(page.getByLabel('Comarca', { exact: true })).toHaveValue('Alt Empordà');
    await expect(page.getByLabel('Municipio')).toHaveValue('Figueres');
    await expect.poll(() => cardNames(page)).toEqual(['Cooperativa Agrícola', 'Shell']);
  });

  test('la zona ocupa una sola fila: un botón que despliega los tres desplegables', async ({ page }) => {
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    const btn = page.locator('#zonaBtn');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#zonaPanel')).toBeHidden();
    await expect(btn).toContainText('Toda Cataluña');

    await btn.click();
    await expect(page.locator('#zonaPanel')).toBeVisible();
    await page.getByLabel('Provincia', { exact: true }).selectOption('Girona');
    await page.getByLabel('Comarca', { exact: true }).selectOption('Gironès');
    await expect(page.locator('#zonaPanel')).toBeVisible();
    await expect(btn).toContainText('Gironès');
    await expect(btn).toContainText('Girona');

    // Al elegir el municipio se recoge y el botón lo resume
    await page.getByLabel('Municipio').selectOption('Sarrià de Ter');
    await expect(page.locator('#zonaPanel')).toBeHidden();
    await expect(page.locator('#zonaMain')).toHaveText('Sarrià de Ter');
    await expect(page.locator('#zonaSub')).toHaveText('Gironès, Girona');
  });

  test('los desplegables de zona se recogen al bajar por la lista', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 500 });
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('#zonaBtn').click();
    await expect(page.locator('#zonaPanel')).toBeVisible();
    // WebKit móvil no admite la rueda del ratón: se desplaza la página directamente
    await page.evaluate(() => window.scrollBy(0, 300));
    await expect(page.locator('#zonaPanel')).toBeHidden();
    await expect(page.locator('#zonaBtn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('se elige Provincia → Comarca → Municipio y cada lista solo ofrece lo de la anterior', async ({ page }) => {
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    const opts = (id) => page.locator(`${id} option`).allTextContents();
    // Sin provincia se ofrecen las comarcas de toda Cataluña
    expect(await opts('#comarca')).toEqual(['Todas', 'Alt Empordà', 'Barcelonès', 'Garrotxa', 'Gironès', 'Segrià', 'Tarragonès']);

    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('Girona');
    expect(await opts('#comarca')).toEqual(['Todas', 'Alt Empordà', 'Garrotxa', 'Gironès']);
    expect(await opts('#muni')).toEqual(['Todos', 'Aiguaviva', 'Figueres', 'Girona', 'Olot', 'Sarrià de Ter']);

    await abrirZona(page);

    await page.getByLabel('Comarca', { exact: true }).selectOption('Gironès');
    expect(await opts('#muni')).toEqual(['Todos', 'Aiguaviva', 'Girona', 'Sarrià de Ter']);
    await expect(page.locator('.card')).toHaveCount(3); // la cuarta no vende Gasolina 95
    await expect(page.locator('#summary')).toHaveAttribute('aria-label', /Gironès/);

    await abrirZona(page);

    await page.getByLabel('Municipio').selectOption('Girona');
    await expect.poll(() => cardNames(page)).toEqual(['Ballenoil', 'Repsol']);

    // Cambiar de provincia vacía la comarca y el municipio
    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('Lleida');
    await expect(page.getByLabel('Comarca', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Municipio')).toHaveValue('');
    await expect.poll(() => cardNames(page)).toEqual(['Petrocat']);

    // Elegir directamente una comarca o un municipio coloca también lo de arriba
    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('');
    await abrirZona(page);

    await page.getByLabel('Comarca', { exact: true }).selectOption('Tarragonès');
    await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('43');
    await abrirZona(page);

    await page.getByLabel('Provincia', { exact: true }).selectOption('');
    await abrirZona(page);

    await page.getByLabel('Municipio').selectOption('Barcelona');
    await expect(page.getByLabel('Provincia', { exact: true })).toHaveValue('08');
    await expect(page.getByLabel('Comarca', { exact: true })).toHaveValue('Barcelonès');
    await expect(page.locator('.card')).toHaveCount(2);
  });

  test('la ficha compara con la media de su provincia', async ({ page }) => {
    await mockData(page, { snap: snapshot({ raw: RAW_CAT }), liveBody: RAW_CAT });
    await page.goto('/');
    await waitLiveSettled(page);
    // Girona tiene media en los datos de prueba; Barcelona no
    await page.locator('.card', { hasText: 'Repsol' }).filter({ hasText: 'N-II' }).click();
    await expect(page.locator('#chart svg path.line.ref')).toHaveCount(1);
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await page.locator('.card', { hasText: 'Plenoil' }).click();
    await expect(page.locator('#chart svg path.line:not(.ref)')).toHaveCount(1);
    await expect(page.locator('#chart svg path.line.ref')).toHaveCount(0);
  });
});

test('gasolinera sin ubicar (0,0): «Cómo llegar» busca por la dirección', async ({ page }) => {
  const raw = JSON.parse(JSON.stringify(RAW_CAT));
  const e = raw.ListaEESSPrecio.find((x) => x.IDEESS === '2004');
  e.Latitud = '0,000000'; e['Longitud (WGS84)'] = '0,000000';
  await mockData(page, { snap: snapshot({ raw }), liveBody: raw });
  await page.goto('/');
  await waitLiveSettled(page);
  await page.locator('.card', { hasText: 'Galp' }).filter({ hasText: 'Catalunya' }).click();
  await expect(page.getByRole('link', { name: 'Cómo llegar' }))
    .toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=Avinguda%20Catalunya%2C%203%2C%2043002%20Tarragona');
});
