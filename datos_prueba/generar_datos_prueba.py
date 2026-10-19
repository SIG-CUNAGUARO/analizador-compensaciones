import geopandas as gpd, numpy as np, pandas as pd
from shapely.geometry import Polygon, box
from shapely import voronoi_polygons, MultiPoint
from shapely.affinity import translate
import os, shutil
rng = np.random.default_rng(7)
x0, y0 = 5_120_000, 2_150_000  # Casanare aprox en 9377
for d in ['interv/2024','interv/2025','eco','cov']: os.makedirs(d, exist_ok=True)
# Ecosistemas: voronoi
pts = MultiPoint([(x0+rng.uniform(-3000,3000), y0+rng.uniform(-3000,3000)) for _ in range(14)])
frame = box(x0-4000,y0-4000,x0+4000,y0+4000)
cells = [c.intersection(frame) for c in voronoi_polygons(pts, extend_to=frame).geoms]
biomas = ['Peinobioma de la Orinoquía','Helobioma de la Orinoquía','Zonobioma húmedo tropical del Meta']
eco = gpd.GeoDataFrame({
  'bioma_IAvH':[biomas[i%3] for i in range(len(cells))],
  'gran_bioma':['Gran bioma del bosque húmedo tropical' if i%3==2 else 'Gran bioma de la sabana' for i in range(len(cells))],
  'ecos_sinte':[f'Herbazal denso del {biomas[i%3]}' for i in range(len(cells))],
}, geometry=cells, crs=9377)
eco.to_crs(3116).to_file('eco/ecosistemas_prueba.shp', encoding='latin1')
os.remove('eco/ecosistemas_prueba.cpg') if os.path.exists('eco/ecosistemas_prueba.cpg') else None
# Coberturas: mismas celdas (desplazadas 2 mm) re-agrupadas + otras celdas -> residuos
pts2 = MultiPoint([(x0+rng.uniform(-3000,3000), y0+rng.uniform(-3000,3000)) for _ in range(6)])
cells2 = [c.intersection(frame) for c in voronoi_polygons(pts2, extend_to=frame).geoms]
covs = ['Pastos limpios','Herbazal denso de tierra firme','Bosque de galería y ripario','Explotación de hidrocarburos']
geoms=[]; names=[]
for i,c in enumerate(cells):
    g = translate(c, 0.002, -0.0015)  # casi coincidente con ecosistemas
    geoms.append(g); names.append(covs[i%4])
covdf = gpd.GeoDataFrame({'cobertura':names}, geometry=geoms, crs=9377)
# superponer otra partición en una región (coberturas manda): unión tipo "identity"
over = gpd.GeoDataFrame({'cobertura':[covs[(i+1)%4] for i in range(len(cells2))]}, geometry=[c.intersection(box(x0-500,y0-4000,x0+4000,y0+500)) for c in cells2], crs=9377)
over = over[~over.is_empty]
base = gpd.overlay(covdf, over[['geometry']], how='difference')
cov_final = pd.concat([base, over], ignore_index=True)
cov_final = gpd.GeoDataFrame(cov_final, crs=9377)
cov_final.to_file('cov/coberturas_2024.gpkg', layer='coberturas', driver='GPKG')
# Intervenciones
i1 = gpd.GeoDataFrame({'nombre':['Pozo A','Vía A']}, geometry=[box(x0-1500,y0-900,x0+600,y0+700), Polygon([(x0+500,y0),(x0+2600,y0+300),(x0+2650,y0+250),(x0+520,y0-60)])], crs=9377)
i1.to_file('interv/2024/plataforma_2024.shp')
i2 = gpd.GeoDataFrame({'nombre':['Locación B']}, geometry=[box(x0+200,y0-1800,x0+1800,y0-200)], crs=9377).to_crs(4686)
i2.to_file('interv/2025/locacion_2025.shp')
pd.DataFrame({'BUB':['Peinobioma de la Orinoquia','Helobioma de la Orinoquía','Otro bioma'],'FC':['4,25','5.5',3]}).to_excel('Factores_de_Compensacion.xlsx', index=False, sheet_name='Factores')
# referencia
fp = gpd.GeoDataFrame(geometry=[pd.concat([i1, i2.to_crs(9377)]).union_all()], crs=9377)
e = gpd.overlay(eco, fp, how='intersection').dissolve('bioma_IAvH', as_index=False)
c = gpd.overlay(cov_final, fp, how='intersection').dissolve('cobertura', as_index=False)
u = gpd.overlay(e[['bioma_IAvH','geometry']], c[['cobertura','geometry']], how='intersection').explode(index_parts=False)
u['a']=u.area
print('huella m2', fp.area.sum(), 'geod', fp.to_crs(4686).geometry.apply(lambda g: abs(__import__('pyproj').Geod(ellps='GRS80').geometry_area_perimeter(g)[0])).sum())
print(e.assign(a=e.area)[['bioma_IAvH','a']].to_string())
print('partes', len(u), 'menores 0.01:', (u.a<0.01).sum(), 'menores 1:', (u.a<1).sum(), 'total', u.a.sum())
print(u.groupby(['bioma_IAvH','cobertura']).a.sum().to_string())

# Residuos explícitos: triángulo de 0.005 m², franja de 0.006 m² y parche de 0.5 m²
tiny = [Polygon([(x0+10,y0+10),(x0+10.1,y0+10),(x0+10,y0+10.1)]),
        box(x0-200,y0+100,x0-198,y0+100.003),
        box(x0+300,y0-300,x0+300.5,y0-299)]
extra = gpd.GeoDataFrame({'cobertura':['Pastos arbolados','Vegetación secundaria','Pastos enmalezados']}, geometry=tiny, crs=9377)
cov2 = gpd.overlay(cov_final, extra[['geometry']], how='difference')
cov2 = gpd.GeoDataFrame(pd.concat([cov2, extra], ignore_index=True), crs=9377)
os.remove('cov/coberturas_2024.gpkg')
cov2.to_file('cov/coberturas_2024.gpkg', layer='coberturas', driver='GPKG')
c = gpd.overlay(cov2, fp, how='intersection').dissolve('cobertura', as_index=False)
u = gpd.overlay(e[['bioma_IAvH','geometry']], c[['cobertura','geometry']], how='intersection').explode(index_parts=False)
u['a']=u.area
print('V2 partes', len(u), 'menores 0.01:', (u.a<0.01).sum(), 'menores 1:', (u.a<1).sum(), 'total', u.a.sum())
print(u.sort_values('a').head(5)[['bioma_IAvH','cobertura','a']].to_string())
