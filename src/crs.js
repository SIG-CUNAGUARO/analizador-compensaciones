// Sistemas de referencia: definiciones PROJ y detección desde .prj / GeoPackage.
import proj4 from 'proj4';

const TM = (lat0, lon0, k, x0, y0) =>
  `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=${k} +x_0=${x0} +y_0=${y0} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;

export const CRS_DEFS = {
  'EPSG:4326': { label: 'WGS 84 (geográficas)', def: '+proj=longlat +datum=WGS84 +no_defs', projected: false },
  'EPSG:4686': { label: 'MAGNA-SIRGAS (geográficas)', def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs', projected: false },
  'EPSG:9377': { label: 'MAGNA-SIRGAS / Origen-Nacional (CTM12)', def: TM(4, -73, 0.9992, 5000000, 2000000), projected: true },
  'EPSG:3116': { label: 'MAGNA-SIRGAS / Colombia Bogotá', def: TM(4.596200416666666, -74.07750791666666, 1, 1000000, 1000000), projected: true },
  'EPSG:3115': { label: 'MAGNA-SIRGAS / Colombia Oeste', def: TM(4.596200416666666, -77.07750791666666, 1, 1000000, 1000000), projected: true },
  'EPSG:3117': { label: 'MAGNA-SIRGAS / Colombia Este Central', def: TM(4.596200416666666, -71.07750791666666, 1, 1000000, 1000000), projected: true },
  'EPSG:3118': { label: 'MAGNA-SIRGAS / Colombia Este', def: TM(4.596200416666666, -68.07750791666666, 1, 1000000, 1000000), projected: true },
  'EPSG:3114': { label: 'MAGNA-SIRGAS / Colombia Oeste Oeste', def: TM(4.596200416666666, -80.07750791666666, 1, 1000000, 1000000), projected: true },
  'EPSG:32617': { label: 'WGS 84 / UTM 17N', def: '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs', projected: true },
  'EPSG:32618': { label: 'WGS 84 / UTM 18N', def: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs', projected: true },
  'EPSG:32619': { label: 'WGS 84 / UTM 19N', def: '+proj=utm +zone=19 +datum=WGS84 +units=m +no_defs', projected: true },
  'EPSG:3857': { label: 'Web Mercator', def: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs', projected: true },
  'EPSG:21897': { label: 'Bogotá 1975 / Colombia Bogotá', def: '+proj=tmerc +lat_0=4.599047222222222 +lon_0=-74.08091666666667 +k=1 +x_0=1000000 +y_0=1000000 +ellps=intl +towgs84=307,304,-318,0,0,0,0 +units=m +no_defs', projected: true },
};
for (const [code, { def }] of Object.entries(CRS_DEFS)) proj4.defs(code, def);

export const ANALYSIS_CRS = ['EPSG:9377', 'EPSG:3116', 'EPSG:3115', 'EPSG:3117', 'EPSG:3118', 'EPSG:3114', 'EPSG:32618', 'EPSG:32619'];

export const ELLIPSOIDS = {
  GRS80: { label: 'GRS80 (MAGNA-SIRGAS)', a: 6378137, f: 1 / 298.257222101 },
  WGS84: { label: 'WGS 84', a: 6378137, f: 1 / 298.257223563 },
};

// Coincidencias por nombre en WKT ESRI/OGC. El orden importa (Este_Este antes que Este).
const NAME_HINTS = [
  [/origen[-_ ]?nacional|ctm[-_ ]?12/i, 'EPSG:9377'],
  [/colombia[_ ]?east[_ ]?east|colombia[_ ]?este[_ ]?este/i, 'EPSG:3118'],
  [/colombia[_ ]?west[_ ]?west|colombia[_ ]?oeste[_ ]?oeste/i, 'EPSG:3114'],
  [/magna.*(colombia[_ ]?east|este[_ ]?central|colombia[_ ]?este)/i, 'EPSG:3117'],
  [/magna.*(colombia[_ ]?west|colombia[_ ]?oeste)/i, 'EPSG:3115'],
  [/magna.*bogota/i, 'EPSG:3116'],
  [/utm[_ ]?zone[_ ]?17n/i, 'EPSG:32617'],
  [/utm[_ ]?zone[_ ]?18n/i, 'EPSG:32618'],
  [/utm[_ ]?zone[_ ]?19n/i, 'EPSG:32619'],
];

function topLevelAuthority(wkt) {
  // AUTHORITY["EPSG","9377"] o ID["EPSG",9377] que cierra el WKT completo.
  const m = wkt.match(/(?:AUTHORITY\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]|ID\[\s*"EPSG"\s*,\s*(\d+)\s*\])\s*\]\s*$/i);
  return m ? `EPSG:${m[1] || m[2]}` : null;
}

/** Devuelve {code, label, def, projected} a partir de un código EPSG y/o un WKT. */
export function resolveCrs({ epsg = null, wkt = null } = {}) {
  if (epsg && CRS_DEFS[`EPSG:${epsg}`]) return { code: `EPSG:${epsg}`, ...CRS_DEFS[`EPSG:${epsg}`] };
  if (wkt && wkt.trim()) {
    const text = wkt.trim();
    const auth = topLevelAuthority(text);
    if (auth && CRS_DEFS[auth]) return { code: auth, ...CRS_DEFS[auth] };
    const isProjected = /^\s*(PROJCS|PROJCRS)/i.test(text);
    if (isProjected) {
      for (const [re, code] of NAME_HINTS) if (re.test(text)) return { code, ...CRS_DEFS[code] };
    } else if (/^\s*(GEOGCS|GEOGCRS|GEODCRS)/i.test(text)) {
      if (/magna/i.test(text)) return { code: 'EPSG:4686', ...CRS_DEFS['EPSG:4686'] };
      if (/wgs[_ ]?(19)?84/i.test(text)) return { code: 'EPSG:4326', ...CRS_DEFS['EPSG:4326'] };
    }
    try {
      const p = proj4(text);
      const def = p.oProj ? p.oProj : p;
      proj4.defs(`WKT:${hash(text)}`, text);
      return { code: `WKT:${hash(text)}`, label: (text.match(/^\s*\w+\[\s*"([^"]+)"/) || [, 'CRS desde WKT'])[1], def: text, projected: isProjected, fromWkt: !!def };
    } catch (e) {
      throw new Error(`No se reconoce el sistema de referencia: ${text.slice(0, 120)}…`);
    }
  }
  if (epsg) throw new Error(`EPSG:${epsg} no está registrado en la aplicación. Reproyecte la capa a EPSG:9377 o EPSG:4686.`);
  return null;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function transformer(fromCode, toCode) {
  if (fromCode === toCode) return null;
  const t = proj4(fromCode, toCode);
  return (c) => t.forward([c[0], c[1]]);
}

export function transformGeometry(geom, fn) {
  if (!fn || !geom) return geom;
  const ring = (r) => r.map(fn);
  switch (geom.type) {
    case 'Polygon': return { type: 'Polygon', coordinates: geom.coordinates.map(ring) };
    case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(ring)) };
    case 'GeometryCollection': return { type: 'GeometryCollection', geometries: geom.geometries.map((g) => transformGeometry(g, fn)) };
    case 'LineString': return { type: 'LineString', coordinates: ring(geom.coordinates) };
    case 'MultiLineString': return { type: 'MultiLineString', coordinates: geom.coordinates.map(ring) };
    case 'Point': return { type: 'Point', coordinates: fn(geom.coordinates) };
    case 'MultiPoint': return { type: 'MultiPoint', coordinates: ring(geom.coordinates) };
    default: return geom;
  }
}

/** Transforma un bbox densificando sus bordes (el rectángulo deja de serlo al reproyectar). */
export function transformBbox(bbox, fn, steps = 24) {
  if (!fn) return bbox;
  const [x0, y0, x1, y1] = bbox;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([x0 + (x1 - x0) * t, y0], [x0 + (x1 - x0) * t, y1], [x0, y0 + (y1 - y0) * t], [x1, y0 + (y1 - y0) * t]);
  }
  let out = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const [x, y] = fn(p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out = [Math.min(out[0], x), Math.min(out[1], y), Math.max(out[2], x), Math.max(out[3], y)];
  }
  return out;
}
