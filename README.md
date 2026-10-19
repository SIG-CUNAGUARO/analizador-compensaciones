# Analizador de Compensaciones — Fundación Cunaguaro (web)

Versión web del analizador de escritorio, pensada para publicarse en **GitHub Pages**.
Todo el cálculo ocurre en el navegador del usuario: las capas y el Excel **no se suben a ningún servidor**.

La geometría usa **GEOS** compilado a WebAssembly (el mismo motor de Shapely, QGIS y PostGIS),
de modo que los cruces se comportan igual que en la versión de escritorio.

web: https://sig-cunaguaro.github.io/analizador-compensaciones/


## Capas incluidas

La aplicación carga sola, al abrirse, dos capas de referencia ubicadas en `public/data/` (copiadas a `docs/data/` al compilar):

| Capa | Archivo | Configuración por defecto |
|---|---|---|
| Coberturas | `coberturas_referencia.zip` (Cobertura_Tierra_EIA_PMA, 735 polígonos, EPSG:9377) | campo `OBSERV` |
| Ecosistemas | `ecosistemas_referencia.zip` (ecosistemas_ai_4221, 2191 polígonos, EPSG:9377) | llave y grupo `bioma_IAvH` |

| Factores | `factores_compensacion.xlsx` (399 BUB con Crp, Cra, Crm, Ctt y FC) | FC = Crp + Cra + Crm + Ctt |

El usuario solo carga las intervenciones. Puede elegir otra capa y luego
«Volver a la capa incluida». Para cambiar las capas incluidas, reemplace los .zip y edite `public/data/capas.json`;
para quitarlas, borre esa carpeta.

**Importante:** un sitio de GitHub Pages es público. Cualquiera con el enlace puede descargar estas capas.

## Formatos de entrada

- Shapefile (elegir juntos `.shp`, `.dbf`, `.prj` y, si existe, `.cpg`), o Shapefile dentro de `.zip`.
- GeoPackage (`.gpkg`), con todas sus capas.
- GeoJSON (se asume EPSG:4326 salvo que declare otro CRS).
- «Elegir carpeta» recorre subcarpetas, como el escaneo recursivo de la versión de escritorio.

### Intervenciones en un solo .zip

Comprima todos los Shapefile de las intervenciones en un único `.zip` (pueden estar en subcarpetas y en CRS
distintos) y súbalo con «Elegir archivos o .zip». Cada Shapefile aparece como una capa, todas quedan marcadas
y al ejecutar se reparan, se reproyectan al CRS de análisis y se **disuelven en una sola huella**; los
traslapes entre intervenciones no se cuentan dos veces. Desmarque las capas que no quiera incluir.
Ejemplo: `datos_prueba/intervenciones_6_poligonos.zip`.

Las File Geodatabase (`.gdb`) no se pueden leer en el navegador: expórtelas a GeoPackage desde QGIS.
Las capas sin CRS se rechazan para evitar áreas incorrectas.

## Áreas: planimétrica y elipsoidal

| En la app | Equivalente en QGIS | Qué calcula |
|---|---|---|
| Planimétrica | `area($geometry)` con la capa en el CRS de análisis | Área cartesiana en el plano del CRS proyectado (por defecto EPSG:9377). |
| Elipsoidal | `$area` con el elipsoide del proyecto (GRS80 para MAGNA-SIRGAS) | Área sobre el elipsoide, con GeographicLib. |

Ojo: en QGIS `$area` es la **elipsoidal** (usa el elipsoide del proyecto) y `area($geometry)` la **planimétrica**.
Si el proyecto de QGIS no tiene elipsoide («Ninguno/Planimétrico»), `$area` también devuelve el área plana.

La diferencia no es despreciable: EPSG:9377 tiene factor de escala 0,9992 en su meridiano central, así que
cerca del origen un área planimétrica es alrededor de 0,16 % menor que la elipsoidal.
Ambos valores de la huella quedan en la pestaña Diagnóstico y en la hoja Parámetros del Excel.
El método se puede cambiar después de ejecutar sin repetir el cruce. Todas las tablas muestran m² y ha.

## Residuos geométricos

Cuando los límites de la capa de ecosistemas y la de coberturas casi coinciden, el cruce produce
polígonos diminutos (de milímetros). La pestaña **Residuos** los lista uno por uno y el paso 5 controla:

- **Umbral (m²)**, evaluado con el área planimétrica de cada polígono (antes era fijo en 0,01 m²).
- **Tratamiento**:
  - *Sumar al vecino* (predeterminado): el residuo se asigna a la unidad con la que comparte más borde,
    prefiriendo una del mismo bioma. No se pierde área y las tablas cuadran con la huella.
  - *Descartar*: se excluye de las tablas de ecosistemas y coberturas (comportamiento de la v0.1.2).
  - *Conservar*: se deja como unidad propia.

Cambiar el umbral o el tratamiento recalcula sin repetir el cruce. Al pulsar un residuo se ubica en el mapa.

## Factores de compensación

La tabla sigue el Manual de Compensaciones del Componente Biótico (Resolución 256 de 2018):

**FC = Crp + Cra + Crm + Ctt**

| Criterio | Significado |
|---|---|
| Crp | Representatividad del ecosistema en el SINAP |
| Cra | Rareza |
| Crm | Remanencia |
| Ctt | Tasa de transformación anual |

Si el Excel trae las columnas `Crp_Valor`, `Cra_Valor`, `Crm_Valor` y `Ctt_Valor`, la app las lee, verifica
que FC sea la suma en cada fila (avisa si no) y permite editar cada criterio en la pestaña Factores: el FC
se recalcula como la suma. También se puede escribir el FC directamente, lo que prevalece sobre la suma.
La pestaña indica el origen de cada FC (Excel, suma con criterio editado o escrito a mano).

En el libro exportado, `Factores_BUB_FC` lleva los cuatro criterios y el FC como `=SUM(Crp:Ctt)`; las hojas
de resultados lo consultan con BUSCARV. Cambiar un criterio en Excel recalcula todas las tablas.
Si el Excel solo trae BUB y FC, se usa el FC tal cual.

## Variantes de escritura

Con la opción «Unificar nombres…» (activada por defecto), los valores que solo difieren en mayúsculas,
tildes o puntuación se tratan como uno solo y se nombran con la escritura más frecuente. En la capa de
coberturas incluida esto une «Zonas Pantanosas» con «Zonas pantanosas» y «Lagunas Lagos y Ciénagas Naturales»
con «Lagunas, lagos y ciénagas naturales». Cada unificación queda registrada en Diagnóstico y en el Excel.

La app también avisa cuando una capa tiene polígonos de distinta clase traslapados dentro de la huella
(la capa de ecosistemas incluida tiene 1,47 m² así entre biomas), porque esa área se cuenta en más de un grupo.

## Edición de resultados

Las celdas con fondo pajizo son editables; las que usted modificó se resaltan y tienen una × para volver al valor calculado.

- **FC** por valor de la llave (`bioma_IAvH`), en las pestañas Factores, Biomas o Ecosistemas.
- **FCcob** por cobertura (panel superior de Coberturas) o **por fila** (en la tabla).
- **Nombre visible** de cada bioma y de cada ecosistema, para acortar o corregir etiquetas.
- **Plantilla del nombre del ecosistema**: `{cobertura} del {bioma}` por defecto; admite `{grupo}`.

«Guardar ajustes» descarga un `.json` con todas las ediciones; «Cargar ajustes» las vuelve a aplicar.

## Libro Excel

Hojas: Biomas, Ecosistemas, Coberturas, Factores_BUB_FC, Factores_cobertura, Residuos, FC_no_encontrados,
Parámetros y Advertencias. Las hojas de resultados llevan **fórmulas vivas**: ha = m²/10 000, FC y FCcob se buscan
en las hojas de factores con BUSCARV y el área a compensar se multiplica en la celda. Si edita un FC en
`Factores_BUB_FC` o un FCcob en `Factores_cobertura`, todo el libro se recalcula. Las filas con FCcob propio
llevan el valor escrito y quedan marcadas.

## Estructura

```
src/crs.js       Sistemas de referencia (MAGNA-SIRGAS, CTM12, UTM) y detección desde .prj/GPKG
src/geo.js       Envoltura de GEOS y área elipsoidal (GeographicLib)
src/readers.js   Lectores de Shapefile, DBF (UTF-8/Latin-1), GeoPackage, WKB y GeoJSON
src/engine.js    Huella, recortes, disolución, cruce, residuos (corre en el Worker)
src/tables.js    Tablas a partir del resultado y las ediciones (función pura)
src/excel.js     Lectura de factores y exportación con fórmulas
src/app.js       Interfaz
public/          HTML, CSS y logo
docs/            Aplicación compilada lista para GitHub Pages
```

## Nota sobre dependencias

`xlsx` 0.18.5 es la última versión de SheetJS publicada en npm y tiene advertencias de seguridad conocidas
al **leer** archivos manipulados. Aquí solo lee el Excel de factores que usted mismo elige. Si se desea,
puede reemplazarse por la versión del CDN oficial de SheetJS (`https://cdn.sheetjs.com`).
