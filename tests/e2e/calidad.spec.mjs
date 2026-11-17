// Accesibilidad, diseño adaptable, temas, seguridad, PWA y funcionamiento sin conexión
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockData, waitLiveSettled, RAW, snapshot } from './helpers.mjs';

const axe = (page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
const serious = (r) => r.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
const describe = (vs) => vs.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`).join('\n');

test.describe('accesibilidad (axe, WCAG 2.1 AA)', () => {
  for (const scheme of ['light', 'dark']) {
    test(`pantalla principal sin fallos graves (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockData(page);
      await page.goto('/');
      await waitLiveSettled(page);
      const v = serious(await axe(page).analyze());
      expect(v, describe(v)).toEqual([]);
    });

    test(`ficha con gráfico sin fallos graves (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockData(page);
      await page.goto('/');
      await waitLiveSettled(page);
      await page.locator('.card').first().click();
      await expect(page.locator('#chart svg')).toBeVisible();
      const v = serious(await axe(page).include('#detail').analyze());
      expect(v, describe(v)).toEqual([]);
    });
  }

  test('se puede usar con teclado: tarjetas enfocables y ficha con Enter', async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('.card').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#detail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#detail')).toBeHidden();
  });

  test('los botones táctiles tienen al menos 40 px de alto', async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    for (const sel of ['#nearBtn', '#muni', '#q', '#source', '.card']) {
      const box = await page.locator(sel).first().boundingBox();
      expect(box.height, sel).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe('diseño adaptable', () => {
  for (const width of [320, 375, 414, 768, 1280]) {
    test(`sin scroll horizontal a ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockData(page);
      await page.goto('/');
      await waitLiveSettled(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.locator('.card').first().click();
      const overflowDlg = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflowDlg).toBeLessThanOrEqual(0);
    });
  }

  test('la cabecera se queda fija al hacer scroll', async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    // Más contenido para que haya scroll incluso en pantallas grandes
    await page.getByLabel('Incluir venta restringida').check();
    await page.evaluate(() => { document.querySelector('main').style.paddingBottom = '2000px'; window.scrollTo(0, 1500); });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const top = await page.locator('header.top').boundingBox();
    expect(Math.round(top.y)).toBe(0);
  });
});

test.describe('temas claro y oscuro', () => {
  for (const [scheme, bg] of [['light', 'rgb(244, 243, 240)'], ['dark', 'rgb(18, 18, 17)']]) {
    test(`fondo correcto en modo ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockData(page);
      await page.goto('/');
      await expect(page.locator('body')).toHaveCSS('background-color', bg);
    });
  }
});

test.describe('seguridad', () => {
  test('textos del Ministerio con HTML se muestran como texto, sin ejecutarse', async ({ page }) => {
    const evil = JSON.parse(JSON.stringify(RAW));
    evil.ListaEESSPrecio[0]['Rótulo'] = '<img src=x onerror="window.__xss=1">';
    evil.ListaEESSPrecio[0]['Dirección'] = '<script>window.__xss=2</script>';
    evil.ListaEESSPrecio[0]['Horario'] = '"><b onmouseover=alert(1)>';
    await mockData(page, { liveBody: evil });
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('.card', { hasText: '<img' }).click();
    await expect(page.locator('#detail')).toBeVisible();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('.card img, .card script, #detail img, .card b').count()).toBe(0);
  });

  test('el enlace a Google Maps abre en otra pestaña sin acceso a la web (noopener)', async ({ page }) => {
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('.card').first().click();
    const link = page.getByRole('link', { name: 'Cómo llegar' });
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('solo se hacen peticiones a la propia web y al Ministerio', async ({ page }) => {
    const hosts = new Set();
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    await mockData(page);
    await page.goto('/');
    await waitLiveSettled(page);
    await page.locator('.card').first().click();
    await expect(page.locator('#chart svg')).toBeVisible();
    expect([...hosts].sort()).toEqual(['localhost:4173', 'sedeaplicaciones.minetur.gob.es']);
  });
});

test.describe('app instalable (PWA)', () => {
  test('manifest válido con iconos accesibles', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const res = await request.get(href);
    expect(res.ok()).toBeTruthy();
    const m = await res.json();
    expect(m.name).toBe('Gasolina Girona');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('./');
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of m.icons) expect((await request.get(icon.src)).ok(), icon.src).toBeTruthy();
  });

  test('icono para iPhone y metadatos de app', async ({ page, request }) => {
    await page.goto('/');
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect((await request.get(apple)).ok()).toBeTruthy();
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);
    await expect(page).toHaveTitle('Gasolina Girona');
  });
});

test.describe('sin conexión', () => {
  // El service worker solo se prueba en Chromium (en WebKit de Playwright no está soportado)
  test.use({ serviceWorkers: 'allow' });

  test('tras una visita, la web abre sin conexión con la última copia y lo indica', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Service worker solo en Chromium');
    // Sin page.route: con el service worker activo se usan los datos reales servidos en local
    await page.route(/sedeaplicaciones\.minetur\.gob\.es/, (route) => route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(RAW),
    }));
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // ahora la página está controlada por el service worker
    await waitLiveSettled(page);
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    await context.setOffline(true);
    await page.route(/sedeaplicaciones\.minetur\.gob\.es/, (route) => route.abort('internetdisconnected'));
    await page.reload();
    await waitLiveSettled(page);
    await expect(page.locator('h1')).toHaveText('Gasolina Girona');
    expect(await page.locator('.card').count()).toBeGreaterThan(0);
    await expect(page.locator('#source')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('#source')).toContainText('El Ministerio no responde');
    await context.setOffline(false);
  });
});

test.describe('hora de Girona', () => {
  // Un móvil configurado en Nueva York debe ver igualmente la hora de España
  test.use({ timezoneId: 'America/New_York' });

  test('las horas se muestran en hora de España aunque el móvil esté en otra zona', async ({ page }) => {
    const snap = { ...snapshot(), actualizado: '2026-11-17T22:39:00Z' }; // 23:39 en Girona, 17:39 en Nueva York
    await mockData(page, { live: 'fail', snap });
    await page.goto('/');
    await waitLiveSettled(page);
    const main = page.locator('#source .src-main');
    await expect(main).toContainText('23:39');
    await expect(main).not.toContainText('17:39');
  });
});
