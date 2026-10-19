# Historial de cambios

## 0.2.0-web

Primera versión web, publicable en GitHub Pages. Reproduce el flujo de la v0.1.2 de escritorio y agrega:

- Cálculo de área planimétrica o elipsoidal, con elipsoide GRS80 o WGS 84; ambos valores de la huella en el diagnóstico.
- Control del umbral de residuos y de su tratamiento (sumar al vecino, descartar, conservar), con lista auditable.
- Campo llave FC seleccionable (antes fijo en `bioma_IAvH`) y vista previa de los valores de cada campo.
- Plantilla editable para el nombre del ecosistema.
- Edición de FC, FCcob por cobertura y por fila, y nombres de biomas y ecosistemas; guardado y carga de ajustes.
- Excel con fórmulas vivas vinculadas a las hojas de factores.
- Exportación de la huella y de las unidades ecosistema–cobertura en GeoJSON.
- Capas de coberturas (Cobertura_Tierra_EIA_PMA, campo OBSERV) y ecosistemas (ecosistemas_ai_4221, bioma_IAvH) incluidas y precargadas.
- Opción «Solo FCcob» por cobertura: área a compensar = ha × FCcob, ignorando el FC del bioma (también en el Excel, con fórmula).
- Un solo campo de bioma: sirve de llave para el FC y de agrupación de la tabla de biomas.
- Tabla de factores incluida y lectura de los criterios Crp, Cra, Crm y Ctt (FC = suma, Resolución 256 de 2018): validación de la suma, edición por criterio y FC como fórmula en el Excel exportado.
- Unificación de variantes de escritura en los nombres (mayúsculas, tildes, puntuación), con registro en Diagnóstico.
- Aviso de traslapes entre polígonos de distinta clase dentro de la huella.
- Intervenciones desde un solo .zip con varios Shapefile; al cargarlas quedan todas marcadas para disolverse en una huella.

Correcciones respecto a la v0.1.2:

- La tabla de coberturas se sumaba a partir de valores ya redondeados (m² a 2 decimales, ha a 6); ahora se
  redondea solo al mostrar y exportar.
- Los residuos se excluían solo de las tablas de ecosistemas y coberturas, pero no de la de biomas, así que
  los totales no cuadraban entre tablas. Con «sumar al vecino» cuadran con la huella.
- El residuo se evaluaba por par ecosistema–cobertura completo; ahora se evalúa cada polígono, de modo que
  también aparecen las astillas sueltas que antes quedaban dentro de una unidad grande.
