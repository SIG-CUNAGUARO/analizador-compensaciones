// Motor geoespacial: registro de capas, huella, cruces, residuos y áreas.
// Se ejecuta dentro de un Web Worker (o en Node para las pruebas).
import { unzipSync } from 'fflate';
import * as geo from './geo.js';
import { resolveCrs, transformer, transformGeometry, transformBbox, CRS_DEFS, ELLIPSOIDS } from './crs.js';
import {
  ext, stem, baseName, dirName, cpgToEncoding, dbfHeader, readDbf, readShpPolygons, shpGeomType,
  openGpkg, gpkgLayers, readGpkgLayer, parseGeojson,
} from './readers.js';

const SEP = '\u241f';
const SIN_DATO = 'SIN DATO';
const layers = new Map();
let seq = 1;
let state = null;

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const textOf = async (blob) => (typeof blob.text === 'function' ? blob.text() : new TextDecoder().decode(await bytesOf(blob)));
/** Llave para comparar nombres sin importar mayúsculas, tildes ni puntuación. */
export const spellingKey = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Para cada atributo, agrupa variantes de escritura y usa la más frecuente como nombre. */
function canonicalizer(features, fields) {
  const maps = {};
  const merged = [];
  for (const f of fields) {
    const counts = new Map();
    for (const feat of features) {
      const v = clean(feat.properties?.[f]);
      const k = spellingKey(v);
      if (!counts.has(k)) counts.set(k, new Map());
      const m = counts.get(k);
      m.set(v, (m.get(v) || 0) + 1);
    }
    const map = new Map();
    for (const variants of counts.values()) {
      const sorted = [...variants].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
      for (const [v] of sorted) map.set(v, sorted[0][0]);
      if (sorted.length > 1) merged.push({ field: f, label: sorted[0][0], variants: sorted.map(([v, n]) => `${v} (${n})`) });
    }
    maps[f] = map;
  }
  return { canon: (f, v) => maps[f]?.get(clean(v)) ?? clean(v), merged };
}

const clean = (v) => {
  if (v === null || v === undefined) return SIN_DATO;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? SIN_DATO : s;
};

function crsInfo(crs) {
  if (!crs) return { crsCode: null, crsLabel: 'Sin CRS', crsError: 'La capa no tiene CRS definido.' };
  if (crs.error) return { crsCode: null, crsLabel: 'CRS no reconocido', crsError: crs.error };
  return { crsCode: crs.code, crsLabel: `${crs.label} (${crs.code})`, crsError: null };
}

function publicLayer(L) {
  const { read, sample, ...pub } = L;
  return pub;
}

// ------------------------------------------------------------------ registro
/**
 * entries: [{path, blob}] — blob es un File/Blob. Devuelve las capas encontradas.
 * Los Shapefile se agrupan por nombre base; los .zip se abren; los .gpkg se listan.
 */
export async function registerFiles(entries, { encoding = 'auto', group = 'general' } = {}) {
  const found = [];
  const errors = [];
  const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]));

  for (const e of entries) {
    const x = ext(e.path);
    try {
      if (x === '.shp') {
        const base = stem(e.path).toLowerCase();
        const sib = (s) => byPath.get(base + s);
        found.push(await registerShapefile(e.path, e.blob, sib('.dbf')?.blob, sib('.prj')?.blob, sib('.cpg')?.blob, encoding, group));
      } else if (x === '.zip') {
        const files = unzipSync(await bytesOf(e.blob));
        const inner = Object.entries(files)
          .filter(([name, data]) => !name.includes('__MACOSX') && data.length)
          .map(([name, data]) => ({ path: `${e.path}/${name}`, blob: new Blob([data]) }));
        const sub = await registerFiles(inner, { encoding, group });
        found.push(...sub.layers);
        errors.push(...sub.errors);
      } else if (x === '.gpkg') {
        found.push(...(await registerGpkg(e.path, e.blob, group)));
      } else if (x === '.geojson' || x === '.json') {
        found.push(await registerGeojson(e.path, e.blob, group));
      }
    } catch (err) {
      errors.push(`${e.path}: ${err.message || err}`);
    }
  }
  return { layers: found.filter(Boolean).map(publicLayer), errors };
}

async function registerShapefile(path, shpBlob, dbfBlob, prjBlob, cpgBlob, encoding, group) {
  const head = await bytesOf(shpBlob.slice(0, 100));
  const geometryType = shpGeomType(head);
  let fields = [];
  let count = null;
  if (dbfBlob) {
    // Solo se lee la cabecera del DBF para listar campos.
    const first = await bytesOf(dbfBlob.slice(0, 32));
    const hlen = new DataView(first.buffer).getUint16(8, true);
    const h = dbfHeader(await bytesOf(dbfBlob.slice(0, hlen)));
    fields = h.fields.map((f) => ({ name: f.name, type: f.type }));
    count = h.records;
  }
  let crs = null;
  if (prjBlob) { try { crs = resolveCrs({ wkt: await textOf(prjBlob) }); } catch (err) { crs = { error: err.message }; } }
  const enc = encoding !== 'auto' ? encoding : cpgToEncoding(cpgBlob ? await textOf(cpgBlob) : null);
  let dbfCache = null;
  const loadDbf = async (wanted) => {
    if (!dbfBlob) return null;
    if (!dbfCache) dbfCache = await bytesOf(dbfBlob);
    return readDbf(dbfCache, { encoding: enc, fields: wanted });
  };
  const L = {
    id: `L${seq++}`, group, kind: 'Shapefile', path, dir: dirName(path), name: baseName(path), layer: stem(baseName(path)),
    geometryType, fields, count, encoding: enc, ...crsInfo(crs),
    async read({ bbox = null, fields: wanted = null } = {}) {
      const shp = await bytesOf(shpBlob);
      const filter = bbox ? (b) => b[2] >= bbox[0] && b[0] <= bbox[2] && b[3] >= bbox[1] && b[1] <= bbox[3] : null;
      const geoms = readShpPolygons(shp, { bboxFilter: filter });
      const dbf = await loadDbf(wanted);
      const feats = [];
      geoms.forEach((g, i) => {
        if (!g) return;
        const props = dbf ? dbf.rows[i] : {};
        if (props && props.__deleted) return;
        feats.push({ geometry: g, properties: props || {} });
      });
      return { crs, features: feats, skippedNull: geoms.filter((g) => g === null).length };
    },
    async sample(field) {
      const dbf = await loadDbf([field]);
      return dbf ? dbf.rows.filter((r) => !r.__deleted).map((r) => r[field]) : [];
    },
  };
  layers.set(L.id, L);
  return L;
}

async function registerGpkg(path, blob, group) {
  const db = await openGpkg(await bytesOf(blob));
  return gpkgLayers(db).map((info) => {
    const L = {
      id: `L${seq++}`, group, kind: 'GeoPackage', path, dir: dirName(path), name: baseName(path), layer: info.table,
      geometryType: info.geometryType, fields: info.fields.map((f) => ({ name: f.name, type: f.type })), count: info.count,
      hasSpatialIndex: info.hasRtree, ...crsInfo(info.crs),
      async read({ bbox = null, fields = null } = {}) {
        return { crs: info.crs, features: readGpkgLayer(db, info, { bbox, fields }), skippedNull: 0 };
      },
      async sample(field) {
        return readGpkgLayer(db, info, { fields: [field] }).map((f) => f.properties[field]);
      },
    };
    layers.set(L.id, L);
    return L;
  });
}

async function registerGeojson(path, blob, group) {
  const parsed = parseGeojson(await textOf(blob));
  const keys = new Map();
  for (const f of parsed.features.slice(0, 500)) for (const [k, v] of Object.entries(f.properties || {})) if (!keys.has(k)) keys.set(k, typeof v);
  const L = {
    id: `L${seq++}`, group, kind: 'GeoJSON', path, dir: dirName(path), name: baseName(path), layer: stem(baseName(path)),
    geometryType: parsed.features[0]?.geometry?.type || 'Desconocida', fields: [...keys].map(([name, type]) => ({ name, type })),
    count: parsed.features.length, ...crsInfo(parsed.crs),
    async read() { return { crs: parsed.crs, features: parsed.features.filter((f) => f.geometry), skippedNull: 0 }; },
    async sample(field) { return parsed.features.map((f) => f.properties?.[field]); },
  };
  layers.set(L.id, L);
  return L;
}

export function forgetGroup(group) {
  for (const [id, L] of layers) if (L.group === group) layers.delete(id);
}

export async function sampleField(layerId, field, limit = 40) {
  const L = layers.get(layerId);
  if (!L) throw new Error('Capa no registrada.');
  const counts = new Map();
  for (const v of await L.sample(field)) { const k = clean(v); counts.set(k, (counts.get(k) || 0) + 1); }
  const values = [...counts].sort((a, b) => b[1] - a[1]);
  return { total: values.length, values: values.slice(0, limit).map(([value, n]) => ({ value, n })) };
}

// ------------------------------------------------------------------ análisis
function freeState() {
  if (!state) return;
  geo.destroyPrepared(state.prepared);
  geo.destroy(state.footprint);
  for (const g of state.ecoGroups) geo.destroy(g.ptr);
  for (const g of state.covGroups) geo.destroy(g.ptr);
  for (const p of state.parts) geo.destroy(p.ptr);
  state = null;
}

const bboxOverlap = (a, b, tol = 0) => a[2] + tol >= b[0] && a[0] - tol <= b[2] && a[3] + tol >= b[1] && a[1] - tol <= b[3];

async function readPolygons(layerId, analysisCrs, { bbox = null, fields = null, label }) {
  const L = layers.get(layerId);
  if (!L) throw new Error(`La capa ${label} ya no está cargada.`);
  if (L.crsError) throw new Error(`${label} (${L.name}${L.kind === 'GeoPackage' ? ' — ' + L.layer : ''}): ${L.crsError} Asígnele un CRS en QGIS antes de usarla, para evitar áreas incorrectas.`);
  const toLayer = transformer(analysisCrs, L.crsCode);
  const layerBbox = bbox ? transformBbox(bbox, toLayer) : null;
  const pad = layerBbox ? Math.max(layerBbox[2] - layerBbox[0], layerBbox[3] - layerBbox[1]) * 0.01 + (CRS_DEFS[L.crsCode]?.projected === false ? 1e-4 : 1) : 0;
  const filter = layerBbox ? [layerBbox[0] - pad, layerBbox[1] - pad, layerBbox[2] + pad, layerBbox[3] + pad] : null;
  const { features, skippedNull } = await L.read({ bbox: filter, fields });
  const toAnalysis = transformer(L.crsCode, analysisCrs);
  return { L, features, skippedNull, toAnalysis };
}

function geosFrom(geom, fn) {
  const g = geo.fromGJ(transformGeometry(geom, fn));
  const p = geo.polygonal(g, { repair: true });
  geo.destroy(g);
  return p;
}

/**
 * params = { interventions:[layerId], eco:{id,keyField,groupField}, cov:{id,field},
 *            crs:'EPSG:9377', ellipsoid:'GRS80', residue:{threshold, action} }
 */
export async function runAnalysis(params, progress = () => {}) {
  const t0 = Date.now();
  freeState();
  const crs = params.crs || 'EPSG:9377';
  if (!CRS_DEFS[crs]?.projected) throw new Error('El CRS de análisis debe ser proyectado (en metros).');
  const ell = ELLIPSOIDS[params.ellipsoid || 'GRS80'];
  const toLonLat = transformer(crs, 'EPSG:4686');
  const warnings = [];

  // 1. Huella disuelta -------------------------------------------------------
  if (!params.interventions?.length) throw new Error('Seleccione al menos una capa de intervención.');
  const fpParts = [];
  let featCount = 0;
  for (const [i, id] of params.interventions.entries()) {
    const L0 = layers.get(id);
    progress(`1/6 — Intervención ${i + 1}/${params.interventions.length}: ${L0?.name || id}`);
    const { L, features, toAnalysis } = await readPolygons(id, crs, { fields: [], label: 'Intervención' });
    featCount += features.length;
    let ignored = 0;
    for (const f of features) {
      const p = geosFrom(f.geometry, toAnalysis);
      if (p && geo.area(p) > 0) fpParts.push(p); else { ignored++; geo.destroy(p); }
    }
    if (ignored) warnings.push(`${L.name}: se omitieron ${ignored} geometrías sin área poligonal válida.`);
  }
  progress('1/6 — Disolviendo intervenciones…');
  const footprint = geo.unionAll(fpParts);
  fpParts.forEach(geo.destroy);
  if (!footprint || geo.isEmpty(footprint)) throw new Error('No fue posible construir una huella poligonal disuelta.');
  const fpBbox = geo.bounds(footprint);
  const prepared = geo.prepare(footprint);
  state = { footprint, prepared, ecoGroups: [], covGroups: [], parts: [], crs, ell, toLonLat };

  // 2-3. Capas temáticas recortadas y disueltas por atributo -----------------
  const unify = params.unifySpelling !== false;
  const clipAndGroup = async (layerId, keyOf, fields, label, step) => {
    progress(`${step} — Leyendo ${label}…`);
    const { features, toAnalysis, L } = await readPolygons(layerId, crs, { bbox: fpBbox, fields, label });
    for (const f of fields) if (!L.fields.some((x) => x.name === f)) throw new Error(`El campo '${f}' no existe en la capa de ${label}.`);
    const { canon, merged } = unify ? canonicalizer(features, fields) : { canon: (f, v) => clean(v), merged: [] };
    for (const m of merged) warnings.push(`${label}, campo ${m.field}: se unificaron como «${m.label}» las variantes ${m.variants.join(', ')}.`);
    const keyFn = (props) => keyOf(props, canon);
    const groups = new Map();
    let ignored = 0;
    for (const [i, f] of features.entries()) {
      if (i % 500 === 0) progress(`${step} — Recortando ${label}: ${i}/${features.length}`);
      const g = geosFrom(f.geometry, toAnalysis);
      if (!g) { ignored++; continue; }
      if (!bboxOverlap(geo.bounds(g), fpBbox) || !geo.preparedIntersects(prepared, g)) { geo.destroy(g); continue; }
      const inter = geo.intersection(footprint, g);
      geo.destroy(g);
      const piece = geo.polygonal(inter, { repair: false });
      geo.destroy(inter);
      if (!piece || geo.area(piece) <= 0) { geo.destroy(piece); continue; }
      const attrs = keyFn(f.properties || {});
      const k = attrs.join(SEP);
      if (!groups.has(k)) groups.set(k, { attrs, ptrs: [] });
      groups.get(k).ptrs.push(piece);
    }
    if (ignored) warnings.push(`${label}: se omitieron ${ignored} geometrías sin área poligonal válida.`);
    progress(`${step} — Disolviendo ${label} por atributo…`);
    const out = [];
    for (const { attrs, ptrs } of groups.values()) {
      const u = ptrs.length === 1 ? geo.clone(ptrs[0]) : geo.unionAll(ptrs);
      ptrs.forEach(geo.destroy);
      if (u && !geo.isEmpty(u)) out.push({ attrs, ptr: u, bbox: geo.bounds(u) });
    }
    // Traslapes entre grupos distintos: esa área se contaría dos veces.
    if (out.length > 1) {
      const sumGroups = out.reduce((acc, g) => acc + geo.area(g.ptr), 0);
      const all = geo.unionAll(out.map((g) => g.ptr));
      const overlap = sumGroups - geo.area(all);
      geo.destroy(all);
      if (overlap > 0.001) warnings.push(`La capa de ${label} tiene ${overlap.toFixed(4)} m² dentro de la huella donde se traslapan polígonos de distinto ${fields.join('/')}; esa área queda contada en más de un grupo. Revise la topología en QGIS si es relevante.`);
    }
    return out;
  };

  const { keyField, groupField } = params.eco;
  const ecoFields = [...new Set([keyField, groupField])];
  const eco = await clipAndGroup(params.eco.id, (p, c) => [c(keyField, p[keyField]), c(groupField, p[groupField])], ecoFields, 'ecosistemas', '2/6');
  if (!eco.length) throw new Error('La intervención seleccionada no intersecta la capa de ecosistemas.');
  state.ecoGroups = eco.map((g, i) => ({ id: i, key: g.attrs[0], group: g.attrs[1], ptr: g.ptr, bbox: g.bbox }));

  const cov = await clipAndGroup(params.cov.id, (p, c) => [c(params.cov.field, p[params.cov.field])], [params.cov.field], 'coberturas', '3/6');
  if (!cov.length) throw new Error('La intervención seleccionada no intersecta la capa de coberturas.');
  state.covGroups = cov.map((g, i) => ({ id: i, cov: g.attrs[0], ptr: g.ptr, bbox: g.bbox }));

  // 4. Unidades ecosistema–cobertura (explotadas en polígonos simples) -------
  progress('4/6 — Cruzando ecosistemas con coberturas…');
  let pid = 0;
  for (const e of state.ecoGroups) {
    for (const c of state.covGroups) {
      if (!bboxOverlap(e.bbox, c.bbox) || !geo.intersects(e.ptr, c.ptr)) continue;
      const inter = geo.intersection(e.ptr, c.ptr);
      for (const part of geo.polygonParts(inter)) {
        const a = geo.area(part);
        if (a <= 0) { geo.destroy(part); continue; }
        state.parts.push({ id: pid++, key: e.key, group: e.group, cov: c.cov, ptr: part, planar: a, bbox: geo.bounds(part) });
      }
      geo.destroy(inter);
    }
  }
  if (!state.parts.length) throw new Error('No se generaron unidades de ecosistema y cobertura dentro de la intervención.');

  // 5. Áreas planimétricas y elipsoidales -------------------------------------
  progress('5/6 — Calculando áreas planimétricas y elipsoidales…');
  const geod = (ptr) => geo.geodesicArea(transformGeometry(geo.toGJ(ptr), toLonLat), ell);
  const fpPlanar = geo.area(footprint);
  const fpGeod = geod(footprint);
  for (const e of state.ecoGroups) { e.planar = geo.area(e.ptr); e.geod = geod(e.ptr); }
  for (const p of state.parts) p.geod = geod(p.ptr);

  // 6. Residuos ----------------------------------------------------------------
  progress('6/6 — Evaluando residuos geométricos…');
  const residues = applyResidues(params.residue || {});

  const ecoPlanar = state.ecoGroups.reduce((s, e) => s + e.planar, 0);
  const unitsPlanar = state.parts.reduce((s, p) => s + p.planar, 0);
  const pct = (x) => (fpPlanar ? (x / fpPlanar) * 100 : NaN);
  if (Math.abs(ecoPlanar - fpPlanar) / fpPlanar > 0.001) warnings.push(`La capa de ecosistemas cubre el ${pct(ecoPlanar).toFixed(3)} % de la huella (no el 100 %).`);
  if (Math.abs(unitsPlanar - fpPlanar) / fpPlanar > 0.001) warnings.push(`El cruce ecosistema–cobertura cubre el ${pct(unitsPlanar).toFixed(3)} % de la huella (no el 100 %).`);

  return {
    footprint: { planar: fpPlanar, geod: fpGeod, sources: params.interventions.length, features: featCount },
    ecoPieces: state.ecoGroups.map(({ id, key, group, planar, geod: g }) => ({ id, key, group, planar, geod: g })),
    parts: state.parts.map(({ id, key, group, cov, planar, geod: g }) => ({ id, key, group, cov, planar, geod: g })),
    residues,
    coverage: { ecoPct: pct(ecoPlanar), unitsPct: pct(unitsPlanar) },
    warnings,
    seconds: (Date.now() - t0) / 1000,
  };
}

/**
 * Clasifica los polígonos menores al umbral (m², planimétrico).
 *  - 'reasignar': se suman al vecino con el que comparten más borde, dando
 *     prioridad a vecinos del mismo bioma. No se pierde área.
 *  - 'descartar': se excluyen de las tablas de ecosistemas y coberturas.
 *  - 'conservar': se dejan tal cual.
 */
export function applyResidues({ threshold = 0.01, action = 'reasignar' } = {}) {
  if (!state) throw new Error('Ejecute primero el análisis.');
  const thr = Math.max(0, Number(threshold) || 0);
  const small = state.parts.filter((p) => p.planar < thr);
  const big = state.parts.filter((p) => p.planar >= thr);
  const out = [];
  for (const r of small) {
    const rec = { id: r.id, planar: r.planar, geod: r.geod, key: r.key, group: r.group, cov: r.cov, status: action, to: null, shared: 0, dist: null };
    if (action === 'reasignar') {
      const cands = big.filter((b) => bboxOverlap(b.bbox, r.bbox, 1));
      let best = null;
      for (const b of cands) {
        const len = geo.sharedBoundaryLength(r.ptr, b.ptr);
        const same = b.key === r.key && b.group === r.group;
        const score = [len > 1e-9 ? 1 : 0, same ? 1 : 0, len];
        if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) best = { b, score, len };
      }
      if (best && best.len <= 1e-9) {
        // Sin borde común exacto: vecino más cercano (≤ 1 m), prefiriendo el mismo bioma.
        best = null;
        for (const b of cands) {
          const d = geo.distance(r.ptr, b.ptr);
          if (d > 1) continue;
          const same = b.key === r.key && b.group === r.group ? 0 : 1;
          if (!best || same < best.same || (same === best.same && d < best.d)) best = { b, d, same };
        }
        if (best) { rec.to = best.b.id; rec.dist = best.d; }
      } else if (best) {
        rec.to = best.b.id; rec.shared = best.len;
      }
      if (rec.to === null) rec.status = 'conservar-sin-vecino';
    }
    out.push(rec);
  }
  return { threshold: thr, action, items: out };
}

/** Geometrías en EPSG:4326 para el visor. */
export function mapData() {
  if (!state) return null;
  const to4326 = transformer(state.crs, 'EPSG:4326');
  const gj = (ptr) => transformGeometry(geo.toGJ(ptr), to4326);
  return {
    footprint: gj(state.footprint),
    eco: state.ecoGroups.map((e) => ({ type: 'Feature', geometry: gj(e.ptr), properties: { id: e.id, key: e.key, group: e.group } })),
    parts: state.parts.map((p) => ({ type: 'Feature', geometry: gj(p.ptr), properties: { id: p.id, key: p.key, group: p.group, cov: p.cov } })),
  };
}

/** GeoJSON de las unidades en el CRS de análisis (para exportar). */
export function exportUnits(attrsById) {
  if (!state) return null;
  const toCrs = (ptr) => geo.toGJ(ptr);
  return {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: `urn:ogc:def:crs:${state.crs.replace(':', '::')}` } },
    features: state.parts.map((p) => ({ type: 'Feature', geometry: toCrs(p.ptr), properties: attrsById[p.id] || { id: p.id } })),
  };
}

export function exportFootprint() {
  if (!state) return null;
  return {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: `urn:ogc:def:crs:${state.crs.replace(':', '::')}` } },
    features: [{ type: 'Feature', geometry: geo.toGJ(state.footprint), properties: { area_m2: geo.area(state.footprint), area_ha: geo.area(state.footprint) / 1e4 } }],
  };
}

export { layers };
