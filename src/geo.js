// Envoltura mínima de GEOS (WebAssembly) — el mismo motor de Shapely, QGIS y PostGIS.
import initGeosJs from 'geos-wasm';
import { geojsonToGeosGeom, geosGeomToGeojson } from 'geos-wasm/helpers';
import geodesic from 'geographiclib-geodesic';

let G = null;
let dbl = 0;

export async function initGeos() {
  if (!G) {
    G = await initGeosJs();
    dbl = G.Module._malloc(8);
  }
  return G;
}

const readDouble = () => G.Module.getValue(dbl, 'double');

export function fromGJ(geom) { return geojsonToGeosGeom(geom, G); }
export function toGJ(ptr) { return ptr ? geosGeomToGeojson(ptr, G) : null; }
export function destroy(ptr) { if (ptr) G.GEOSGeom_destroy(ptr); }
export function clone(ptr) { return G.GEOSGeom_clone(ptr); }
export function isEmpty(ptr) { return !ptr || G.GEOSisEmpty(ptr) === 1; }
export function isValid(ptr) { return G.GEOSisValid(ptr) === 1; }
export function area(ptr) { if (!ptr) return 0; G.GEOSArea(ptr, dbl); return readDouble(); }
export function length(ptr) { if (!ptr) return 0; G.GEOSLength(ptr, dbl); return readDouble(); }
export function distance(a, b) { G.GEOSDistance(a, b, dbl); return readDouble(); }
export function intersects(a, b) { return G.GEOSIntersects(a, b) === 1; }
export function intersection(a, b) { return G.GEOSIntersection(a, b); }
export function boundary(a) { return G.GEOSBoundary(a); }
export function unaryUnion(a) { return G.GEOSUnaryUnion(a); }
export function makeValid(a) { return G.GEOSMakeValid(a); }

export function bounds(ptr) {
  const f = ['GEOSGeom_getXMin', 'GEOSGeom_getYMin', 'GEOSGeom_getXMax', 'GEOSGeom_getYMax'];
  return f.map((name) => { G[name](ptr, dbl); return readDouble(); });
}

export function prepare(ptr) { return G.GEOSPrepare(ptr); }
export function preparedIntersects(prep, ptr) { return G.GEOSPreparedIntersects(prep, ptr) === 1; }
export function destroyPrepared(prep) { if (prep) G.GEOSPreparedGeom_destroy(prep); }

/** Crea una colección (toma posesión de los punteros). */
export function collection(ptrs, typeId = null) {
  const type = typeId ?? G.GEOS_GEOMETRYCOLLECTION;
  if (!ptrs.length) return G.GEOSGeom_createEmptyCollection(type);
  const buf = G.Module._malloc(4 * ptrs.length);
  G.Module.HEAPU32.set(new Uint32Array(ptrs), buf / 4);
  const out = G.GEOSGeom_createCollection(type, buf, ptrs.length);
  G.Module._free(buf);
  return out;
}

/** Copias de cada polígono contenido en la geometría (recorre colecciones). */
export function polygonParts(ptr) {
  const out = [];
  const walk = (g) => {
    const t = G.GEOSGeomTypeId(g);
    if (t === G.GEOS_POLYGON) {
      if (G.GEOSisEmpty(g) !== 1) out.push(G.GEOSGeom_clone(g));
    } else if (t === G.GEOS_MULTIPOLYGON || t === G.GEOS_GEOMETRYCOLLECTION) {
      const n = G.GEOSGetNumGeometries(g);
      for (let i = 0; i < n; i++) walk(G.GEOSGetGeometryN(g, i));
    }
  };
  if (ptr) walk(ptr);
  return out;
}

/**
 * Equivalente a _polygonal_part() de la versión de escritorio: repara la
 * geometría si es inválida y conserva solo la parte poligonal. Devuelve un
 * puntero nuevo (MultiPolygon) o 0. No destruye la entrada.
 */
export function polygonal(ptr, { repair = true } = {}) {
  if (!ptr || isEmpty(ptr)) return 0;
  let work = ptr;
  let owned = false;
  if (repair && !isValid(ptr)) { work = makeValid(ptr); owned = true; }
  const parts = polygonParts(work);
  if (owned) destroy(work);
  if (!parts.length) return 0;
  return collection(parts, G.GEOS_MULTIPOLYGON);
}

/** Unión de una lista de punteros (no los destruye). Devuelve polígono(s) o 0. */
export function unionAll(ptrs) {
  if (!ptrs.length) return 0;
  const coll = collection(ptrs.map(clone));
  const u = unaryUnion(coll);
  destroy(coll);
  const p = polygonal(u, { repair: true });
  destroy(u);
  return p;
}

/** Longitud del borde que comparte `a` con `b`. */
export function sharedBoundaryLength(a, b) {
  const ba = boundary(a);
  const inter = intersection(ba, b);
  const len = length(inter);
  destroy(ba); destroy(inter);
  return len;
}

// ----------------------------------------------------------- área elipsoidal
const geodCache = new Map();
function geodFor(ell) {
  const key = `${ell.a}/${ell.f}`;
  if (!geodCache.has(key)) geodCache.set(key, new geodesic.Geodesic.Geodesic(ell.a, ell.f));
  return geodCache.get(key);
}

function ringGeodArea(geod, ring) {
  const poly = geod.Polygon(false);
  // El último vértice repite el primero; GeographicLib cierra el anillo solo.
  const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) poly.AddPoint(ring[i][1], ring[i][0]);
  const r = poly.Compute(false, true);
  return Math.abs(r.area);
}

/**
 * Área sobre el elipsoide (m²) de una geometría GeoJSON en coordenadas
 * geográficas lon/lat. Es el cálculo que hace QGIS con $area cuando el
 * proyecto tiene un elipsoide definido.
 */
export function geodesicArea(geomLonLat, ellipsoid) {
  const geod = geodFor(ellipsoid);
  const polys = geomLonLat.type === 'Polygon' ? [geomLonLat.coordinates]
    : geomLonLat.type === 'MultiPolygon' ? geomLonLat.coordinates : [];
  let total = 0;
  for (const rings of polys) {
    if (!rings.length) continue;
    let a = ringGeodArea(geod, rings[0]);
    for (let i = 1; i < rings.length; i++) a -= ringGeodArea(geod, rings[i]);
    total += a;
  }
  return total;
}
