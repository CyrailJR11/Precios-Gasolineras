// Conversión de la respuesta de la API del Ministerio al formato compacto de la app.
// Lo usan tanto el recolector horario (Node) como la web (navegador), para que ambos den lo mismo.

export const API_BASE =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/';

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

export const FUEL_LABELS = Object.fromEntries(Object.entries(FUELS).map(([k, [, label]]) => [k, label]));

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

// "17/11/2026 21:05:28" (hora peninsular) -> "2026-11-17T21:05:28"
export function parseFechaMinisterio(f) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(f || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}` : null;
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

// Comprueba que la respuesta tiene la forma esperada
export function isValidResponse(json) {
  return !!json && Array.isArray(json.ListaEESSPrecio) && json.ListaEESSPrecio.length > 0;
}
