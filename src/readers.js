// Lectores de capas vectoriales en el navegador: Shapefile (suelto o .zip),
// GeoPackage y GeoJSON. Todo se procesa localmente; nada se sube a un servidor.
import { unzipSync } from 'fflate';
import { resolveCrs } from './crs.js';

const VECTOR_EXT = ['.shp', '.zip', '.gpkg', '.geojson', '.json'];
const ext = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); };
const stem = (name) => { const i = name.lastIndexOf('.'); return i < 0 ? name : name.slice(0, i); };
const baseName = (path) => path.split('/').pop();
const dirName = (path) => { const parts = path.split('/'); parts.pop(); return parts.join('/') || '.'; };

// --------------------------------------------------------------- decodificación
export function makeDecoder(encoding) {
  const enc = (encoding || 'auto').toLowerCase();
  if (enc !== 'auto') {
    const label = /1252|latin|8859/.test(enc) ? 'windows-1252' : enc;
    const d = new TextDecoder(label);
    return (bytes) => d.decode(bytes);
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin = new TextDecoder('windows-1252');
  return (bytes) => { try { return utf8.decode(bytes); } catch { return latin.decode(bytes); } };
}

function cpgToEncoding(cpg) {
  if (!cpg) return 'auto';
  const t = cpg.trim().toLowerCase();
  if (/utf-?8/.test(t)) return 'utf-8';
  if (/1252|8859|latin|ansi/.test(t)) return 'windows-1252';
  return 'auto';
}

// -------------------------------------------------------------------- DBF
export function dbfHeader(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const records = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  const fields = [];
  let off = 32;
  const latin = new TextDecoder('windows-1252');
  while (off + 32 <= headerLen && buf[off] !== 0x0d) {
    let nameBytes = buf.subarray(off, off + 11);
    const z = nameBytes.indexOf(0);
    if (z >= 0) nameBytes = nameBytes.subarray(0, z);
    fields.push({ name: latin.decode(nameBytes).trim(), type: String.fromCharCode(buf[off + 11]), len: buf[off + 16], dec: buf[off + 17] });
    off += 32;
  }
  return { records, headerLen, recLen, fields };
}

export function readDbf(buf, { encoding = 'auto', fields: wanted = null } = {}) {
  const h = dbfHeader(buf);
  const decode = makeDecoder(encoding);
  const want = wanted ? new Set(wanted) : null;
  const rows = new Array(h.records);
  let pos = h.headerLen;
  for (let r = 0; r < h.records; r++, pos += h.recLen) {
    const row = {};
    row.__deleted = buf[pos] === 0x2a; // '*'
    let off = pos + 1;
    for (const f of h.fields) {
      if (!want || want.has(f.name)) {
        const raw = buf.subarray(off, off + f.len);
        if (f.type === 'N' || f.type === 'F') {
          const s = decode(raw).trim();
          row[f.name] = s === '' || /^\*+$/.test(s) ? null : Number(s);
        } else if (f.type === 'L') {
          const s = decode(raw).trim().toUpperCase();
          row[f.name] = s === '' || s === '?' ? null : 'YT'.includes(s);
        } else {
          const s = decode(raw).replace(/\0+$/, '').trim();
          row[f.name] = s === '' ? null : s;
        }
      }
      off += f.len;
    }
    rows[r] = row;
  }
  return { header: h, rows };
}

// -------------------------------------------------------------------- SHP
const SHP_TYPES = { 0: 'Null', 1: 'Point', 3: 'LineString', 5: 'Polygon', 8: 'MultiPoint', 11: 'PointZ', 13: 'LineStringZ', 15: 'PolygonZ', 18: 'MultiPointZ', 21: 'PointM', 23: 'LineStringM', 25: 'PolygonM', 28: 'MultiPointM', 31: 'MultiPatch' };
export const shpGeomType = (buf) => SHP_TYPES[new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(32, true)] || 'Desconocida';

function ringSignedArea(r) {
  let s = 0;
  for (let i = 0, n = r.length - 1; i < n; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** En shapefile los anillos exteriores van en sentido horario y los huecos antihorario. */
export function ringsToGeometry(rings) {
  const outers = [], holes = [];
  for (const r of rings) {
    if (r.length < 4) continue;
    (ringSignedArea(r) <= 0 ? outers : holes).push(r);
  }
  if (!outers.length && holes.length) { outers.push(...holes.map((h) => h.slice().reverse())); holes.length = 0; }
  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    const target = polys.find((p) => pointInRing(h[0], p[0])) || polys.find((p) => h.some((pt) => pointInRing(pt, p[0])));
    if (target) target.push(h); else polys.push([h.slice().reverse()]);
  }
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

/**
 * Lee polígonos de un .shp. `bboxFilter([xmin,ymin,xmax,ymax])` permite
 * descartar registros sin decodificar sus vértices (cada registro trae su bbox).
 */
export function readShpPolygons(buf, { bboxFilter = null } = {}) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const fileLen = dv.getInt32(24, false) * 2;
  const out = [];
  let pos = 100;
  let idx = 0;
  while (pos + 8 <= Math.min(fileLen, buf.byteLength)) {
    const contentLen = dv.getInt32(pos + 4, false) * 2;
    const rec = pos + 8;
    const type = dv.getInt32(rec, true);
    let geom = null;
    if (type === 5 || type === 15 || type === 25) {
      const bbox = [dv.getFloat64(rec + 4, true), dv.getFloat64(rec + 12, true), dv.getFloat64(rec + 20, true), dv.getFloat64(rec + 28, true)];
      if (!bboxFilter || bboxFilter(bbox)) {
        const nParts = dv.getInt32(rec + 36, true);
        const nPoints = dv.getInt32(rec + 40, true);
        const partsOff = rec + 44;
        const ptsOff = partsOff + 4 * nParts;
        const rings = [];
        for (let p = 0; p < nParts; p++) {
          const start = dv.getInt32(partsOff + 4 * p, true);
          const end = p + 1 < nParts ? dv.getInt32(partsOff + 4 * (p + 1), true) : nPoints;
          const ring = new Array(end - start);
          for (let k = start; k < end; k++) ring[k - start] = [dv.getFloat64(ptsOff + 16 * k, true), dv.getFloat64(ptsOff + 16 * k + 8, true)];
          rings.push(ring);
        }
        geom = ringsToGeometry(rings);
        if (geom) geom.__bbox = bbox;
      } else {
        geom = undefined; // fuera del área de interés
      }
    }
    out.push(geom);
    pos = rec + contentLen;
    idx++;
  }
  return out;
}

// -------------------------------------------------------------------- WKB
export function readWkb(dv, offset = 0) {
  let pos = offset;
  const parse = () => {
    const little = dv.getUint8(pos) === 1; pos += 1;
    let t = dv.getUint32(pos, little); pos += 4;
    let dims = 2;
    if (t & 0x80000000) dims++; // EWKB Z
    if (t & 0x40000000) dims++; // EWKB M
    if (t & 0x20000000) pos += 4; // EWKB SRID
    t &= 0x0fffffff;
    if (t >= 3000) { dims = 4; t -= 3000; } else if (t >= 2000) { dims = 3; t -= 2000; } else if (t >= 1000) { dims = 3; t -= 1000; }
    const pt = () => { const x = dv.getFloat64(pos, little), y = dv.getFloat64(pos + 8, little); pos += 8 * dims; return [x, y]; };
    const seq = () => { const n = dv.getUint32(pos, little); pos += 4; const a = new Array(n); for (let i = 0; i < n; i++) a[i] = pt(); return a; };
    const poly = () => { const n = dv.getUint32(pos, little); pos += 4; const r = []; for (let i = 0; i < n; i++) r.push(seq()); return r; };
    switch (t) {
      case 1: return { type: 'Point', coordinates: pt() };
      case 2: return { type: 'LineString', coordinates: seq() };
      case 3: return { type: 'Polygon', coordinates: poly() };
      case 4: case 5: case 6: case 7: {
        const n = dv.getUint32(pos, little); pos += 4;
        const g = []; for (let i = 0; i < n; i++) g.push(parse());
        if (t === 6) return { type: 'MultiPolygon', coordinates: g.flatMap((x) => (x.type === 'Polygon' ? [x.coordinates] : x.coordinates || [])) };
        if (t === 4) return { type: 'MultiPoint', coordinates: g.map((x) => x.coordinates) };
        if (t === 5) return { type: 'MultiLineString', coordinates: g.map((x) => x.coordinates) };
        return { type: 'GeometryCollection', geometries: g };
      }
      case 15: case 16: { // PolyhedralSurface / TIN como multipolígono
        const n = dv.getUint32(pos, little); pos += 4;
        const g = []; for (let i = 0; i < n; i++) g.push(parse());
        return { type: 'MultiPolygon', coordinates: g.map((x) => x.coordinates) };
      }
      case 10: case 12: { // CurvePolygon / MultiSurface sin arcos
        const n = dv.getUint32(pos, little); pos += 4;
        const g = []; for (let i = 0; i < n; i++) g.push(parse());
        if (t === 10) return { type: 'Polygon', coordinates: g.map((x) => x.coordinates) };
        return { type: 'MultiPolygon', coordinates: g.flatMap((x) => (x.type === 'Polygon' ? [x.coordinates] : x.coordinates || [])) };
      }
      default: throw new Error(`Tipo WKB no soportado: ${t}`);
    }
  };
  return parse();
}

export function readGpkgGeometry(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x47 || bytes[1] !== 0x50) return readWkb(dv, 0); // WKB puro
  const flags = bytes[3];
  if (flags & 0x10) return null; // geometría vacía
  const envCode = (flags >> 1) & 0x07;
  const envLen = [0, 32, 48, 48, 64][envCode] ?? 0;
  return readWkb(dv, 8 + envLen);
}

// ---------------------------------------------------------------- GeoPackage
let sqlPromise = null;
export function setSqlLoader(loader) { sqlPromise = loader; }
async function getSql() {
  if (!sqlPromise) throw new Error('El lector de GeoPackage (sql.js) no está disponible.');
  return typeof sqlPromise === 'function' ? (sqlPromise = sqlPromise()) : sqlPromise;
}

function q(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

export async function openGpkg(bytes) {
  const SQL = await getSql();
  return new SQL.Database(bytes);
}

export function gpkgLayers(db) {
  const rows = q(db, `SELECT c.table_name AS t, g.column_name AS g, g.geometry_type_name AS gt, c.srs_id AS srs,
      s.organization AS org, s.organization_coordsys_id AS code, s.definition AS wkt
    FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
    LEFT JOIN gpkg_spatial_ref_sys s ON s.srs_id = c.srs_id WHERE c.data_type = 'features'`);
  return rows.map((r) => {
    const cols = q(db, `PRAGMA table_info(${qi(r.t)})`);
    const pk = (cols.find((c) => c.pk === 1) || {}).name || 'rowid';
    const fields = cols.filter((c) => c.name !== r.g).map((c) => ({ name: c.name, type: c.type }));
    const count = (q(db, `SELECT count(*) AS n FROM ${qi(r.t)}`)[0] || {}).n;
    const hasRtree = q(db, `SELECT name FROM sqlite_master WHERE name = ?`, [`rtree_${r.t}_${r.g}`]).length > 0;
    let crs = null;
    try { crs = resolveCrs({ epsg: String(r.org || '').toUpperCase() === 'EPSG' ? r.code : null, wkt: r.wkt && r.wkt !== 'undefined' ? r.wkt : null }); } catch (e) { crs = { error: e.message }; }
    return { table: r.t, geomCol: r.g, geometryType: r.gt, srsId: r.srs, crs, pk, fields, count, hasRtree };
  });
}

function gpkgEnvelope(bytes) {
  if (!bytes || bytes.length < 8 || bytes[0] !== 0x47 || bytes[1] !== 0x50) return null;
  const flags = bytes[3];
  const envCode = (flags >> 1) & 0x07;
  if (!envCode) return null;
  const little = (flags & 1) === 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Orden en la cabecera: minx, maxx, miny, maxy
  return [dv.getFloat64(8, little), dv.getFloat64(24, little), dv.getFloat64(16, little), dv.getFloat64(32, little)];
}

function geomBbox(g) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c) => {
    if (typeof c[0] === 'number') { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; }
    else for (const x of c) visit(x);
  };
  if (g.type === 'GeometryCollection') g.geometries.forEach((x) => visit(x.coordinates)); else visit(g.coordinates);
  return b;
}

export function readGpkgLayer(db, layer, { bbox = null, fields = null } = {}) {
  const cols = (fields || layer.fields.map((f) => f.name)).filter((f) => f !== layer.geomCol);
  const sel = cols.map(qi).join(', ');
  const sql = `SELECT ${sel ? sel + ', ' : ''}${qi(layer.geomCol)} AS __g FROM ${qi(layer.table)}`;
  // sql.js no trae el módulo R-tree: se filtra con el envolvente de la cabecera GPKG.
  const hit = (b) => !bbox || (b[2] >= bbox[0] && b[0] <= bbox[2] && b[3] >= bbox[1] && b[1] <= bbox[3]);
  const stmt = db.prepare(sql);
  const feats = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const blob = row.__g;
    delete row.__g;
    if (bbox) { const env = gpkgEnvelope(blob); if (env && !hit(env)) continue; }
    const g = readGpkgGeometry(blob);
    if (!g) continue;
    if (bbox && !gpkgEnvelope(blob) && g.type !== 'Point' && !hit(geomBbox(g))) continue;
    feats.push({ geometry: g, properties: row });
  }
  stmt.free();
  return feats;
}

// ---------------------------------------------------------------- GeoJSON
function geojsonCrs(obj) {
  const name = obj?.crs?.properties?.name || '';
  const m = String(name).match(/EPSG:{1,2}(\d+)/i);
  if (m) return resolveCrs({ epsg: m[1] });
  if (/CRS84/i.test(name) || !name) return resolveCrs({ epsg: '4326' });
  return resolveCrs({ epsg: '4326' });
}
export function parseGeojson(text) {
  const obj = JSON.parse(text);
  const feats = obj.type === 'FeatureCollection' ? obj.features : obj.type === 'Feature' ? [obj] : [{ type: 'Feature', geometry: obj, properties: {} }];
  return { crs: geojsonCrs(obj), features: feats.map((f) => ({ geometry: f.geometry, properties: f.properties || {} })) };
}

export { VECTOR_EXT, ext, stem, baseName, dirName, cpgToEncoding };
