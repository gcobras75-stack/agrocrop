# AgroCrop — Analisis Satelital de Cultivos

App de analisis agricola con datos satelitales en tiempo real para productores mexicanos.

## Caracteristicas

- 5 satelites: Sentinel-2, Landsat 8/9, Sentinel-1 SAR, MODIS, SMAP
- Multiples cultivos: maiz riego/temporal, mango Ataulfo/Kent/Tommy
- Mapa de calor con rendimiento por hectarea
- Proyeccion de cosecha al dia de la trilla
- OCR de titulos parcelarios (RAN, Procede) con Claude Vision
- Estimacion de valor en MXN
- Reportes WhatsApp para compartir
- Multi-poligono con analisis consolidado

## Stack

- Expo / React Native (iOS + Android)
- Google Earth Engine (Sentinel-2, Landsat, SAR, MODIS, SMAP)
- Claude API (Sonnet + Vision)
- Railway (GEE proxy server)

## Correr localmente

```bash
npm install
npx expo start --tunnel
```

## Servidor GEE

Usa el servidor compartido en Railway:
`https://prospector-gee-server-production.up.railway.app`

Endpoints:
- POST /api/biomass-analysis
- POST /api/biomass-analysis-extended
- POST /api/biomass-grid
