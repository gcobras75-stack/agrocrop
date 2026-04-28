import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Modal, TextInput, ScrollView, Switch, Share } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import MapView, { Marker, Polygon, Region, MapPressEvent } from 'react-native-maps';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import NetInfo from '@react-native-community/netinfo';
import { initDB } from '../core/Database';
import { askClaudeGeologist, analyzeCropBiomassWithClaude, CropBiomassStats } from '../core/ClaudeServices';
import { getBiomassAnalysis, BiomassAnalysisResult, generateCirclePolygon, getBiomassGrid, GridCell, getBiomassExtended, BiomassExtendedResult } from '../core/GEEService';
import { AgroCropPolygon, generatePolygonId, getPolygonColor, extractCoordsFromPhoto, calcConsolidatedSummary } from '../core/AgroCropService';

type Coordinate = { latitude: number; longitude: number };
type DrawingType = 'none' | 'polygon';

// --- GEO CALCULATIONS ---

function calcPolygonArea(coords: Coordinate[]): number {
  if (!coords || coords.length < 3) return 0;
  const R = 6378137;
  let sumY = 0;
  for (const c of coords) sumY += c.latitude;
  const avgLat = (sumY / coords.length) * Math.PI / 180;

  const points = coords.map(c => ({
    x: c.longitude * Math.PI / 180 * R * Math.cos(avgLat),
    y: c.latitude * Math.PI / 180 * R
  }));

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p1.x * p2.y - p2.x * p1.y);
  }
  return Math.abs(area / 2);
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AgroCropDashboard() {
  const mapRef = useRef<MapView>(null);
  
  // --- Chat IA ---
  const [showChatModal, setShowChatModal] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role: string, content: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isTypingChat, setIsTypingChat] = useState(false);

  // --- Red y Sync ---
  const [isConnected, setIsConnected] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const online = state.isConnected && state.isInternetReachable;
      setIsConnected(!!online);
    });
    return () => unsubscribe();
  }, []);

  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [heading, setHeading] = useState<Location.LocationHeadingObject | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [mapCenter, setMapCenter] = useState<Region | null>(null);
  const [drawingType, setDrawingType] = useState<DrawingType>('none');
  
  const [polygonCoords, setPolygonCoords] = useState<Coordinate[]>([]);
  const [mapRotation, setMapRotation] = useState(0);

  // Settings & Configuration
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [activeProject, setActiveProject] = useState('Mi Finca');
  const [useAI, setUseAI] = useState(true);
  const [vibrationEnabled, setVibrationEnabled] = useState(true);

  // AgroCrop — Crop Biomass Analysis
  const [showCropModal, setShowCropModal] = useState(false);
  const [showCropResults, setShowCropResults] = useState(false);
  const [showCropConfig, setShowCropConfig] = useState(false);
  const [cropAnalyzing, setCropAnalyzing] = useState(false);
  const [cropStep, setCropStep] = useState('');
  const [cropRadioKm, setCropRadioKm] = useState(20);
  const [cropTipoCultivo, setCropTipoCultivo] = useState('maiz_riego');
  const [cropFechaFin] = useState(() => new Date().toISOString().split('T')[0]);
  const [cropFechaInicio] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0];
  });
  const [cropData, setCropData] = useState<BiomassAnalysisResult | null>(null);
  const [cropClaudeAnalysis, setCropClaudeAnalysis] = useState<string>('');
  const [cropError, setCropError] = useState<string>('');
  const [cropGridCells, setCropGridCells] = useState<GridCell[]>([]);
  const [showCropHeatmap, setShowCropHeatmap] = useState(false);
  const [cropGridLoading, setCropGridLoading] = useState(false);
  const [showHeatLegend, setShowHeatLegend] = useState(true);
  const [showSatSources, setShowSatSources] = useState(false);
  const [cropAreaMode, setCropAreaMode] = useState<'circle' | 'draw' | 'coords'>('circle');
  const [cropCoordsText, setCropCoordsText] = useState('');
  const [cropDrawing, setCropDrawing] = useState(false);
  const [cropPolygons, setCropPolygons] = useState<AgroCropPolygon[]>([]);
  const [ocrProcessing, setOcrProcessing] = useState(false);
  const [cropExtended, setCropExtended] = useState<BiomassExtendedResult | null>(null);
  const [cropExtendedLoading, setCropExtendedLoading] = useState(false);

  const sendChatMessage = async () => {
    if (!chatInput.trim() || isTypingChat) return;
    const userMsg = { role: 'user', content: chatInput.trim() };
    const newContext = [...chatMessages, userMsg];
    setChatMessages(newContext);
    setChatInput('');
    setIsTypingChat(true);
    triggerHaptic('medium');
    try {
      const response = await askClaudeGeologist(newContext);
      setChatMessages([...newContext, { role: 'assistant', content: response }]);
      triggerHaptic('success');
    } catch(e: any) {
      Alert.alert('Error Chat IA', e.message);
    } finally {
      setIsTypingChat(false);
    }
  };

  // ── AgroCrop analysis flow ─────────────────────────────────────────────
  const startCropAnalysis = async () => {
    setCropError('');
    setCropAnalyzing(true);
    setCropClaudeAnalysis('');
    setCropData(null);
    setCropGridCells([]);
    setCropExtended(null);
    setCropExtendedLoading(false);
    setShowCropResults(true);
    triggerHaptic('medium');

    try {
      // Build coordinates based on area mode
      let geeCoords: number[][];
      console.log('[AgroCrop] Modo area:', cropAreaMode, '| polygonCoords:', polygonCoords.length);

      if (cropAreaMode !== 'circle' && polygonCoords.length >= 3) {
        // Manual trace or coordinates — use existing polygonCoords
        geeCoords = polygonCoords.map(c => [c.longitude, c.latitude]);
        geeCoords.push(geeCoords[0]); // close ring
        console.log('[AgroCrop] Usando poligono', cropAreaMode, ':', polygonCoords.length, 'vertices');
        // Zoom to polygon center
        const lats = polygonCoords.map(c => c.latitude);
        const lngs = polygonCoords.map(c => c.longitude);
        const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
        const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
        const dLat = (Math.max(...lats) - Math.min(...lats)) * 1.3;
        const dLng = (Math.max(...lngs) - Math.min(...lngs)) * 1.3;
        mapRef.current?.animateToRegion({ latitude: cLat, longitude: cLng, latitudeDelta: Math.max(0.1, dLat), longitudeDelta: Math.max(0.1, dLng) }, 800);
      } else {
        // Circle mode — generate Oso Viejo circle
        geeCoords = generateCirclePolygon(24.3994, -107.1714, cropRadioKm);
        const mapCoords = geeCoords.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
        setPolygonCoords(mapCoords);
        console.log('[AgroCrop] Circulo Oso Viejo:', cropRadioKm, 'km,', mapCoords.length, 'vertices');
        const delta = Math.max(0.3, (cropRadioKm / 111.32) * 2.5);
        mapRef.current?.animateToRegion({ latitude: 24.3994, longitude: -107.1714, latitudeDelta: delta, longitudeDelta: delta }, 800);
      }

      // Step 1: Satellite query
      setCropStep('Procesando Sentinel-2... (30-60s)');
      const result = await getBiomassAnalysis(geeCoords, cropFechaInicio, cropFechaFin, cropTipoCultivo);
      setCropData(result);
      triggerHaptic('light');

      // Step 2: Claude analysis
      setCropStep('Generando pronostico de produccion...');
      const biomassStats: CropBiomassStats = {
        ndvi_mean: result.ndvi_mean,
        evi_mean: result.evi_mean,
        ndre_mean: result.ndre_mean,
        lswi_mean: result.lswi_mean,
        hectareas_cultivo_activo: result.hectareas_cultivo_activo,
        tonelaje_estimado: result.tonelaje_estimado,
        tonelaje_minimo: result.tonelaje_minimo,
        tonelaje_maximo: result.tonelaje_maximo,
        rendimiento_por_hectarea: result.rendimiento_por_hectarea,
        porcentaje_area_optima: result.porcentaje_area_optima,
        clasificacion_vigor: result.clasificacion_vigor,
      };
      const tipoLabel = result.tipo_cultivo_label || cropTipoCultivo;
      const claudeText = await analyzeCropBiomassWithClaude(biomassStats, tipoLabel);
      setCropClaudeAnalysis(claudeText);
      triggerHaptic('success');
      setCropStep('');

      // Step 3: Fetch heatmap grid + extended satellites in parallel (non-blocking)
      setCropGridLoading(true);
      setCropExtendedLoading(true);

      // Grid (awaited)
      try {
        setCropStep('Construyendo mapa de calor...');
        const gridResult = await getBiomassGrid(geeCoords, cropFechaInicio, cropFechaFin);
        setCropGridCells(gridResult.grid);
        setShowCropHeatmap(true);
        console.log('[AgroCrop] Grid recibido:', gridResult.grid.length, 'celdas');
      } catch (gridErr: any) {
        console.warn('[AgroCrop] Grid failed:', gridErr.message);
      } finally {
        setCropGridLoading(false);
        setCropStep('');
      }

      // Extended satellites (fire-and-forget, updates UI when ready)
      getBiomassExtended(geeCoords, cropFechaInicio, cropFechaFin)
        .then(ext => {
          setCropExtended(ext);
          setCropExtendedLoading(false);
          console.log('[AgroCrop] Extended:', ext.sentinel1?.fecha, ext.smap?.humedad_suelo_pct + '%');
        })
        .catch(e => {
          console.warn('[AgroCrop] Extended failed:', e.message);
          setCropExtendedLoading(false);
        });
    } catch (e: any) {
      setCropError(e.message || 'Error desconocido');
      setCropStep('');
      triggerHaptic('heavy');
    } finally {
      setCropAnalyzing(false);
    }
  };

  const shareAgroCropResults = async () => {
    if (!cropData) return;
    try {
      // 1. Hide results panel, zoom to fit circle
      setShowCropResults(false);
      const delta = (cropRadioKm / 111.32) * 2.4;
      mapRef.current?.animateToRegion({
        latitude: 24.3994, longitude: -107.1714,
        latitudeDelta: delta, longitudeDelta: delta,
      }, 800);
      await new Promise(r => setTimeout(r, 1500));

      // 2. Capture map
      let imageUri = '';
      try {
        imageUri = await captureRef(mapRef, { format: 'png', quality: 0.9, result: 'tmpfile' });
      } catch (e) {
        console.warn('[AgroCrop] Screenshot failed:', e);
      }

      // 3. Restore results panel
      setShowCropResults(true);

      // 4. Build message
      const imgMonth = parseInt(cropData.fecha_imagen.split('-')[1], 10);
      const etapa = (imgMonth >= 10 && imgMonth <= 11) ? 'Siembra' : (imgMonth === 12 || imgMonth === 1) ? 'Desarrollo vegetativo' : (imgMonth === 2 || imgMonth === 3) ? 'Floracion/Llenado de grano' : 'Madurez/Cosecha';
      const precision = (imgMonth === 2 || imgMonth === 3) ? 'Alta' : (imgMonth === 12 || imgMonth === 1) ? 'Media' : 'Baja';
      const areaKm2 = Math.round(Math.PI * cropRadioKm * cropRadioKm).toLocaleString();
      const hoy = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });

      const cropEmoji = cropData.tipo_cultivo?.startsWith('mango') ? '🥭' : '🌽';
      const mangoSection = cropData.mango ? `
━━━━━━━━━━━━━━━━━
🌳 *METRICAS MANGO*
━━━━━━━━━━━━━━━━━
🌳 Arboles: ~${cropData.mango.arboles_estimados.toLocaleString()}
🥭 ~${cropData.mango.frutos_por_arbol} frutos/arbol
💰 Valor cosecha: $${(cropData.mango.valor_cosecha_mxn / 1e6).toFixed(1)}M MXN` : '';

      const msg = `${cropEmoji} *ANALISIS ${cropData.tipo_cultivo_label?.toUpperCase() || 'BIOMASA'} - SINALOA*
📅 Analisis: ${hoy}
🛰️ Imagen satelital: ${cropData.fecha_imagen} (Sentinel-2)
📍 Centro: 24.3994°N, 107.1714°W
📏 Radio analizado: ${cropRadioKm}km
📐 Area total: ${areaKm2} km2

━━━━━━━━━━━━━━━━━
📡 *ESTADO ACTUAL*
━━━━━━━━━━━━━━━━━
🎯 Rendimiento medido: ${cropData.rendimiento_por_hectarea} ton/ha
💰 Total actual: *${cropData.tonelaje_estimado.toLocaleString()} ton*
🌾 Hectareas: ${cropData.hectareas_cultivo_activo.toLocaleString()} ha
${(cropData as any).proyeccion ? `
━━━━━━━━━━━━━━━━━
📊 *PROYECCION DE COSECHA*
━━━━━━━━━━━━━━━━━
🎯 Rendimiento esperado: ${(cropData as any).proyeccion.ton_ha} ton/ha
💰 Total al cosechar: *${(cropData as any).proyeccion.tonelaje_proyectado.toLocaleString()} ton*
📈 Incremento: +${(cropData as any).proyeccion.incremento_pct}%
📅 Fecha cosecha: ${(cropData as any).proyeccion.fecha_cosecha} (${(cropData as any).proyeccion.dias_a_cosecha}d)
📊 Rango: ${(cropData as any).proyeccion.rango_min.toLocaleString()} - ${(cropData as any).proyeccion.rango_max.toLocaleString()}
✅ Confianza: ${(cropData as any).proyeccion.confianza}` : ''}

━━━━━━━━━━━━━━━━━
🌿 *INDICADORES VEGETATIVOS*
━━━━━━━━━━━━━━━━━
• NDVI (Vigor): ${cropData.ndvi_mean}
• EVI (Biomasa): ${cropData.evi_mean}
• NDRE (Nitrogeno): ${cropData.ndre_mean}
• LSWI (Humedad): ${cropData.lswi_mean}

━━━━━━━━━━━━━━━━━
📊 *CLASIFICACION*
━━━━━━━━━━━━━━━━━
🌱 Vigor: ${cropData.clasificacion_vigor}
📍 Etapa fenologica: ${etapa}
✅ Precision estimada: ${precision}
🏆 Area optima (NDVI>0.7): ${cropData.porcentaje_area_optima}%

━━━━━━━━━━━━━━━━━
🛰️ *FUENTES (5 satelites)*
━━━━━━━━━━━━━━━━━
- Sentinel-2: ${cropData.fuentes_satelitales?.sentinel2?.fecha || 'N/A'}
- Landsat 8/9: ${cropData.fuentes_satelitales?.landsat89?.fecha || 'N/A'}
- Sentinel-1 SAR: ${cropData.fuentes_satelitales?.sentinel1?.fecha || 'N/A'}
- MODIS: ${cropData.fuentes_satelitales?.modis?.fecha || 'N/A'}
- SMAP humedad: ${cropData.fuentes_satelitales?.smap?.fecha || 'N/A'} (${cropData.fuentes_satelitales?.smap?.humedad_suelo_pct || 0}%)
✅ Imagen mas fresca: ${cropData.frescura_dias ?? '?'}d | ${cropData.confianza_fusion || ''}

━━━━━━━━━━━━━━━━━
${mangoSection}

🤖 _Generado con AgroCrop v1.0_
_Datos: ESA Copernicus, NASA, USGS_`;

      await Share.share({
        message: msg,
        ...(imageUri ? { url: imageUri } : {}),
        title: 'Analisis AgroCrop',
      });
    } catch (e: any) {
      if (e.message !== 'User did not share') {
        Alert.alert('Error', 'No se pudo compartir: ' + e.message);
      }
      setShowCropResults(true);
    }
  };

  const loadOsoViejoPolygon = (radioKm: number) => {
    console.log('Cargando circulo radio:', radioKm, 'km');
    const circle = generateCirclePolygon(24.3994, -107.1714, radioKm, 32);
    const coords: Coordinate[] = circle.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
    setPolygonCoords(coords);
    const delta = Math.max(0.3, (radioKm / 111.32) * 2.5);
    mapRef.current?.animateToRegion({
      latitude: 24.3994,
      longitude: -107.1714,
      latitudeDelta: delta,
      longitudeDelta: delta,
    }, 800);
    triggerHaptic('light');
  };

  const parseCoordsText = (text: string): Coordinate[] | null => {
    try {
      const clean = text.trim();
      let pairs: [number, number][] = [];
      // GeoJSON array format
      if (clean.startsWith('[')) {
        const arr = JSON.parse(clean.startsWith('[[') ? clean : `[${clean}]`);
        pairs = arr.map((p: number[]) => [p[1], p[0]] as [number, number]); // [lng,lat] → [lat,lng]
      } else {
        // Lines or semicolons: "lat, lng" per entry
        const entries = clean.includes(';') ? clean.split(';') : clean.split('\n');
        for (const e of entries) {
          const nums = e.trim().split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
          if (nums.length >= 2) pairs.push([nums[0], nums[1]]);
        }
      }
      if (pairs.length < 3) return null;
      const valid = pairs.every(([lat, lng]) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180);
      if (!valid) return null;
      return pairs.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    } catch { return null; }
  };

  const applyCoordsFromText = () => {
    const coords = parseCoordsText(cropCoordsText);
    if (!coords) {
      Alert.alert('Error', 'Coordenadas invalidas. Necesitas minimo 3 pares lat,lng.');
      return;
    }
    setCropAreaMode('coords');
    setPolygonCoords(coords);
    console.log('[AgroCrop] Coordenadas procesadas:', coords.length, 'vertices');
    const lats = coords.map(c => c.latitude);
    const lngs = coords.map(c => c.longitude);
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const dLat = Math.max(...lats) - Math.min(...lats);
    const dLng = Math.max(...lngs) - Math.min(...lngs);
    mapRef.current?.animateToRegion({ latitude: cLat, longitude: cLng, latitudeDelta: dLat * 1.3, longitudeDelta: dLng * 1.3 }, 800);
    triggerHaptic('success');
  };

  const startCropDrawMode = () => {
    setCropAreaMode('draw');
    setShowCropModal(false);
    setCropDrawing(true);
    setPolygonCoords([]);
    selectMode('polygon');
    console.log('[AgroCrop] Modo trazado iniciado');
  };

  const finishCropDraw = () => {
    setCropDrawing(false);
    selectMode('none');
    setCropAreaMode('draw'); // ensure mode stays draw
    console.log('[AgroCrop] Trazado finalizado:', polygonCoords.length, 'vertices');
    if (polygonCoords.length >= 3) {
      setShowCropModal(true);
    }
  };

  // ── OCR: Photo of parcel title ────────────────────────────────────────
  const handlePhotoOCR = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;

      setOcrProcessing(true);
      setShowCropModal(false);
      setCropStep('Procesando titulo parcelario con IA...');
      setShowCropResults(true);
      setCropAnalyzing(true);

      const ocr = await extractCoordsFromPhoto(result.assets[0].base64);
      if (!ocr.vertices || ocr.vertices.length < 3) {
        Alert.alert('Error OCR', 'No se detectaron suficientes coordenadas (min 3)');
        setShowCropResults(false);
        return;
      }

      const coords = ocr.vertices.map(v => ({ latitude: v.lat, longitude: v.lng }));
      setPolygonCoords(coords);
      setCropAreaMode('coords');

      // Add to multi-polygon list
      const newPoly: AgroCropPolygon = {
        id: generatePolygonId(),
        nombre: ocr.datos?.ejido || `Parcela OCR`,
        origen: 'foto_titulo',
        coords,
        hectareas: ocr.datos?.superficie_ha || Math.round(calcPolygonArea(coords) / 10000),
        color: getPolygonColor(cropPolygons.length),
        datosOCR: { ...ocr.datos, formato_origen: ocr.formato_origen, confianza: ocr.confianza },
      };
      setCropPolygons(prev => [...prev, newPoly]);

      // Zoom to polygon
      const lats = coords.map(c => c.latitude);
      const lngs = coords.map(c => c.longitude);
      mapRef.current?.animateToRegion({
        latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
        longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
        latitudeDelta: (Math.max(...lats) - Math.min(...lats)) * 1.4,
        longitudeDelta: (Math.max(...lngs) - Math.min(...lngs)) * 1.4,
      }, 800);

      Alert.alert('Titulo procesado',
        `${ocr.vertices.length} vertices detectados\n` +
        `${ocr.datos?.superficie_ha ? ocr.datos.superficie_ha + ' ha' : ''}\n` +
        `${ocr.datos?.propietario || ''}\n` +
        `Confianza: ${ocr.confianza || '?'}`,
        [{ text: 'Analizar', onPress: () => startCropAnalysis() }, { text: 'Ver en mapa' }]
      );
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setOcrProcessing(false);
      setCropAnalyzing(false);
      setCropStep('');
    }
  };

  // Save current polygon to multi-polygon list
  const saveCurrentPolygon = () => {
    if (polygonCoords.length < 3) return;
    const newPoly: AgroCropPolygon = {
      id: generatePolygonId(),
      nombre: `Poligono ${cropPolygons.length + 1}`,
      origen: cropAreaMode === 'draw' ? 'manual' : cropAreaMode === 'coords' ? 'coordenadas' : 'circulo',
      coords: polygonCoords,
      hectareas: Math.round(calcPolygonArea(polygonCoords) / 10000),
      color: getPolygonColor(cropPolygons.length),
    };
    setCropPolygons(prev => [...prev, newPoly]);
    triggerHaptic('success');
  };

  // ── Heatmap grid polygon data (memoized) ────────────────────────────────
  const cropGridPolygons = useMemo(() => {
    if (!cropGridCells.length) return [];
    // Detect cell size from spacing between first two cells in same row
    let halfDeg = 0.0045;
    if (cropGridCells.length >= 2) {
      const sorted = [...cropGridCells].sort((a, b) => a.lat === b.lat ? a.lng - b.lng : a.lat - b.lat);
      for (let i = 1; i < sorted.length; i++) {
        if (Math.abs(sorted[i].lat - sorted[i - 1].lat) < 0.001) {
          halfDeg = Math.abs(sorted[i].lng - sorted[i - 1].lng) / 2;
          break;
        }
      }
    }
    console.log('[AgroCrop] Renderizando', cropGridCells.length, 'poligonos en mapa, halfDeg:', halfDeg.toFixed(5));
    return cropGridCells.map((cell, i) => ({
      key: `hm-${i}`,
      coords: [
        { latitude: cell.lat - halfDeg, longitude: cell.lng - halfDeg },
        { latitude: cell.lat - halfDeg, longitude: cell.lng + halfDeg },
        { latitude: cell.lat + halfDeg, longitude: cell.lng + halfDeg },
        { latitude: cell.lat + halfDeg, longitude: cell.lng - halfDeg },
      ],
      fill: cell.color_hex + 'A6',
      label: cell.rendimiento_ton_ha.toFixed(1),
      lat: cell.lat,
      lng: cell.lng,
    }));
  }, [cropGridCells]);

  // Stable viewport ref — avoids re-renders during pan/zoom
  const viewportRef = useRef<Region | null>(null);
  const [stableViewport, setStableViewport] = useState<Region | null>(null);

  // Debounced viewport update for grid filtering (only after pan/zoom settles)
  const updateGridViewport = useCallback((region: Region) => {
    viewportRef.current = region;
    setStableViewport(region);
  }, []);

  // Filter + cap visible polygons
  const visibleGridPolygons = useMemo(() => {
    if (!cropGridPolygons.length) return [];
    const vp = stableViewport || mapCenter;
    if (!vp) {
      // No viewport yet — show all (capped)
      console.log('[Grid] No viewport, showing all:', cropGridPolygons.length);
      return cropGridPolygons.length > 500 ? cropGridPolygons.slice(0, 500) : cropGridPolygons;
    }
    const margin = 0.5;
    const minLat = vp.latitude - vp.latitudeDelta / 2 - margin;
    const maxLat = vp.latitude + vp.latitudeDelta / 2 + margin;
    const minLng = vp.longitude - vp.longitudeDelta / 2 - margin;
    const maxLng = vp.longitude + vp.longitudeDelta / 2 + margin;
    let filtered = cropGridPolygons.filter(p =>
      p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng
    );
    if (filtered.length > 500) {
      filtered = [...filtered].sort((a, b) => parseFloat(b.label) - parseFloat(a.label)).slice(0, 500);
    }
    console.log('[Grid] cells totales:', cropGridPolygons.length, 'visibles:', filtered.length);
    return filtered;
  }, [cropGridPolygons, stableViewport, mapCenter]);

  // Live zoom level for label visibility (updated during pan/zoom)
  const [currentZoom, setCurrentZoom] = useState(0.5);
  const showGridLabels = currentZoom < 0.5 && visibleGridPolygons.length <= 200;

  const triggerHaptic = (type: 'light' | 'medium' | 'heavy' | 'success') => {
    if (!vibrationEnabled) return;
    if (type === 'heavy') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else if (type === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (type === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (type === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // Location Watcher
  useEffect(() => {
    let posSub: Location.LocationSubscription;
    let headSub: Location.LocationSubscription;

    const startWatching = async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permisos de GPS denegados');
        return;
      }
      try {
        const initialLoc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setLocation(initialLoc);
        setMapCenter({
            latitude: initialLoc.coords.latitude,
            longitude: initialLoc.coords.longitude,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
        });

        posSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 4000, 
            distanceInterval: 3,
          },
          (loc) => setLocation(loc)
        );

        headSub = await Location.watchHeadingAsync((head) => {
          setHeading(head);
        });
      } catch (err) {
        console.warn('GPS Error: ', err);
      }
    };
    startWatching();
    return () => {
      if (posSub) posSub.remove();
      if (headSub) headSub.remove();
    };
  }, []);

  useEffect(() => {
    const loadSaved = async () => {
      try {
        const saved = await AsyncStorage.getItem('lastPolygon');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.length > 0) setPolygonCoords(parsed);
        }
        await initDB();
      } catch (e) {}
    };
    loadSaved();
  }, []);

  const handleRegionChangeComplete = (region: Region) => {
    setMapCenter(region);
    updateGridViewport(region);
  };

  const handleMapPress = (_e: MapPressEvent) => {
    // AgroCrop: map taps are no-op unless in polygon drawing mode (handled by crosshair)
  };

  const selectMode = (type: DrawingType) => {
    setPolygonCoords([]);
    setDrawingType(type);
  };

  const clearShapes = async () => {
    setPolygonCoords([]);
    setDrawingType('none');
    triggerHaptic('light');
    await AsyncStorage.removeItem('lastPolygon');
  };

  const zoomIn = () => {
    if (mapCenter && mapRef.current) {
      mapRef.current.animateToRegion({
        ...mapCenter,
        latitudeDelta: Math.max(mapCenter.latitudeDelta / 2, 0.0001),
        longitudeDelta: Math.max(mapCenter.longitudeDelta / 2, 0.0001),
      }, 250);
    }
  };

  const zoomOut = () => {
    if (mapCenter && mapRef.current) {
      mapRef.current.animateToRegion({
        ...mapCenter,
        latitudeDelta: Math.min(mapCenter.latitudeDelta * 2, 90),
        longitudeDelta: Math.min(mapCenter.longitudeDelta * 2, 90),
      }, 250);
    }
  };

  const addPointFromCrosshair = () => {
    const center = mapCenter ?? (location ? {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    } : null);
    if (!center) return;
    triggerHaptic('heavy');
    const newPoint = { latitude: center.latitude, longitude: center.longitude };
    setPolygonCoords((prev) => [...prev, newPoint]);
  };

  const finishDrawing = async (overrideCoords?: Coordinate[]) => {
    setDrawingType('none');
    const finalCoords = overrideCoords || polygonCoords;
    if (finalCoords.length >= 3) {
      triggerHaptic('success');
      await AsyncStorage.setItem('lastPolygon', JSON.stringify(finalCoords));
    }
  };

  // Calc stats
  const resolvedPolygonCoords = polygonCoords;
  let areaM2 = 0;
  let infoText = "";

  if (resolvedPolygonCoords.length > 2) {
    areaM2 = calcPolygonArea(resolvedPolygonCoords);
    infoText = `Vertices: ${resolvedPolygonCoords.length}`;
  }

  const areaHa = (areaM2 / 10000).toFixed(2);
  const areaKm2 = (areaM2 / 1000000).toFixed(4);
  const showStatsBox = areaM2 > 0;

  if (errorMsg) return <View style={styles.center}><Text style={styles.errorText}>{errorMsg}</Text></View>;
  if (!location) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#2d7a2d" />
      <Text style={styles.loadingText}>Calibrando GPS...</Text>
    </View>
  );

  const { latitude, longitude, altitude } = location.coords;
  const trueHeading = heading ? heading.trueHeading || heading.magHeading : 0;

  return (
    <View style={styles.container}>
      
      {/* 70% MAPA SUPERIOR */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={styles.map}
          mapType="satellite"
          showsUserLocation={false}
          followsUserLocation={false}
          showsCompass={false}
          region={mapCenter || undefined}
          onRegionChange={(region: any) => { if (region.heading !== undefined) { setMapRotation(region.heading); } setCurrentZoom(region.latitudeDelta); }}
          onRegionChangeComplete={handleRegionChangeComplete}
          onPress={handleMapPress}
        >
          {location && (
            <Marker coordinate={{latitude: location.coords.latitude, longitude: location.coords.longitude}} anchor={{x: 0.5, y: 0.5}} zIndex={100} flat>
              <View style={{alignItems: 'center'}}>
                {trueHeading !== null && trueHeading !== undefined && (
                  <View style={{ transform: [{ rotate: `${trueHeading}deg` }], marginBottom: -4, zIndex: -1 }}>
                    <MaterialCommunityIcons name="navigation" size={20} color="rgba(0,122,255,0.8)" />
                  </View>
                )}
                <View style={{width: 16, height: 16, borderRadius: 8, backgroundColor: '#007AFF', borderWidth: 2, borderColor: '#FFF', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3, elevation: 5}} />
              </View>
            </Marker>
          )}

          {resolvedPolygonCoords.length > 0 && (
            <Polygon
              coordinates={resolvedPolygonCoords}
              strokeColor="#2d7a2d"
              fillColor="rgba(45, 122, 45, 0.3)"
              strokeWidth={3}
              zIndex={3}
            />
          )}

          {resolvedPolygonCoords.map((coord, i) => (
            <Marker key={`p-${i}`} coordinate={coord} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={[styles.numberedMarker, { backgroundColor: '#4CAF50', borderColor: '#FFF', width: 22, height: 22 }]}>
                <Text style={[styles.numberedMarkerText, { fontSize: 11 }]}>{i + 1}</Text>
              </View>
            </Marker>
          ))}

          {/* AgroCrop heatmap grid */}
          {showCropHeatmap && visibleGridPolygons.map(p => (
            <Polygon
              key={p.key}
              coordinates={p.coords}
              fillColor={p.fill}
              strokeColor="transparent"
              strokeWidth={0}
              tappable={false}
            />
          ))}
          {showCropHeatmap && showGridLabels && visibleGridPolygons.map(p => (
            <Marker
              key={`lbl-${p.key}`}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
            >
              <View style={{ backgroundColor: 'rgba(0,0,0,0.75)', borderRadius: 3, padding: 2 }}>
                <Text style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>{p.label}t/ha</Text>
              </View>
            </Marker>
          ))}
        </MapView>

        {/* OVERLAYS DENTRO DEL MAPA */}

        {/* CHATBOT BUTTON REMOVED IN FAVOR OF DIRECT MAP TAP */}

        {/* CROSSHAIR */}
        {drawingType === 'polygon' && (
          <View style={styles.crosshairContainer} pointerEvents="none">
            <MaterialCommunityIcons name="crosshairs" size={50} color="#2d7a2d" />
          </View>
        )}

        {/* CROP DRAW MODE OVERLAY */}
        {cropDrawing && (
          <>
            <View style={{ position: 'absolute', top: 44, left: 10, right: 10, zIndex: 999, backgroundColor: 'rgba(255,193,7,0.95)', padding: 10, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: '#000', fontWeight: '900', fontSize: 13 }}>TRAZANDO POLIGONO AGROCROP</Text>
              <Text style={{ color: '#333', fontSize: 10 }}>Toca "Marcar Punto" para agregar vertices ({polygonCoords.length} vertices)</Text>
            </View>
            <View style={{ position: 'absolute', bottom: 120, left: 16, right: 16, zIndex: 999, flexDirection: 'row', gap: 8 }}>
              {polygonCoords.length > 0 && (
                <TouchableOpacity style={{ flex: 1, backgroundColor: '#333', padding: 12, borderRadius: 8, alignItems: 'center' }} onPress={() => setPolygonCoords(polygonCoords.slice(0, -1))}>
                  <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 12 }}>Deshacer</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={{ flex: 1, backgroundColor: '#F44336', padding: 12, borderRadius: 8, alignItems: 'center' }} onPress={() => { setCropDrawing(false); selectMode('none'); setPolygonCoords([]); }}>
                <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 12 }}>Cancelar</Text>
              </TouchableOpacity>
              {polygonCoords.length >= 3 && (
                <TouchableOpacity style={{ flex: 2, backgroundColor: '#4CAF50', padding: 12, borderRadius: 8, alignItems: 'center' }} onPress={finishCropDraw}>
                  <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 13 }}>FINALIZAR ({polygonCoords.length}v)</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* DEBUG VERSION TAG */}
        <View style={{ position: 'absolute', top: 44, left: 10, backgroundColor: 'rgba(0,0,0,0.8)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, zIndex: 50, maxWidth: 220 }}>
          <Text style={{ color: '#4CAF50', fontSize: 9, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>AgroCrop v1.0</Text>
        </View>


        {/* MINI OVERLAY PANELES */}
        {!showStatsBox && (
          <View style={[styles.panel, styles.topPanel, { borderRadius: 12}]}>
            <View style={styles.row}>
              <MaterialCommunityIcons name="satellite-variant" size={16} color="#2d7a2d" />
              <Text style={[styles.titleText, {fontSize: 11}]}> GPS: LAT {latitude.toFixed(4)} | LON {longitude.toFixed(4)}</Text>
            </View>
          </View>
        )}

        {/* ÁREA EN PANTALLA FIJA */}
        {showStatsBox && (
          <View style={[styles.panel, { top: 50, left: 10, backgroundColor: 'rgba(0,0,0,0.7)', paddingVertical: 4, paddingHorizontal: 8, alignItems: 'flex-start', borderRadius: 8 }]}>
            <Text style={[styles.statsTextHighlight, {fontSize: 10, marginBottom: 0}]}>ZONA SELECCIONADA</Text>
            <Text style={[styles.statsTextArea, {fontSize: 14}]}>{areaHa} ha</Text>
            <Text style={[styles.statsTextAreaSm, {fontSize: 8, marginTop: 0}]}>{areaKm2} km² | Radio: {cropRadioKm}km | {infoText}</Text>
          </View>
        )}

        {/* ZOOM BOTONES */}
        <View style={styles.zoomControlsContainer}>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomIn}>
            <MaterialCommunityIcons name="plus" size={24} color="#000" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.zoomBtn} onPress={zoomOut}>
            <MaterialCommunityIcons name="minus" size={24} color="#000" />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.locationButton} onPress={() => { if (location) { mapRef.current?.animateToRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500); } }}><MaterialCommunityIcons name="crosshairs-gps" size={24} color="#2d7a2d" /></TouchableOpacity>

        {/* AgroCrop heatmap legend toggle + legend */}
        {cropGridCells.length > 0 && (
          <View style={{ position: 'absolute', top: 180, right: 8, zIndex: 999, alignItems: 'flex-end' }}>
            <TouchableOpacity
              style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', marginBottom: 4 }}
              onPress={() => setShowHeatLegend(!showHeatLegend)}
            >
              <Text style={{ fontSize: 14 }}>🌡️</Text>
            </TouchableOpacity>
            {showHeatLegend && (
              <View style={{ backgroundColor: 'rgba(0,0,0,0.7)', padding: 6, borderRadius: 6 }}>
                {[
                  { color: '#1a5c1a', label: '+10 t/ha' },
                  { color: '#4caf50', label: '8-10' },
                  { color: '#cddc39', label: '6-8' },
                  { color: '#ff9800', label: '4-6' },
                  { color: '#f44336', label: '<4' },
                ].map((item, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: item.color, marginRight: 4 }} />
                    <Text style={{ color: '#DDD', fontSize: 9 }}>{item.label}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        <TouchableOpacity style={styles.northIndicator} onPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }} onLongPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }}><View style={[styles.northArrow, { transform: [{ rotate: `${-mapRotation}deg` }] }]}><MaterialCommunityIcons name="arrow-up" size={28} color="#2d7a2d" /><Text style={styles.northText}>N</Text></View></TouchableOpacity>

        {/* CONNECTION & SPECTRAL INDICATOR (TOP RIGHT) */}
        <View style={{ position: 'absolute', top: 50, right: 10, backgroundColor: 'rgba(0,0,0,0.7)', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center', zIndex: 30, borderWidth: 1, borderColor: '#333' }}>
           <TouchableOpacity onPress={() => Alert.alert('Conexión', isSyncing ? 'Sincronizando...' : (isConnected ? 'Online (Conectado a Claude)' : 'Offline (Motor Local)'))} style={{flexDirection: 'row', alignItems: 'center'}}>
             <View style={{width: 8, height: 8, borderRadius: 4, backgroundColor: isConnected ? '#44FF44' : '#888', marginRight: 6}} />
             <Text style={{color: '#FFF', fontSize: 10, fontWeight: 'bold'}}>Online</Text>
           </TouchableOpacity>
           <View style={{width: 1, height: 12, backgroundColor: '#555', marginHorizontal: 8}} />
           <TouchableOpacity onPress={() => setShowCropHeatmap(!showCropHeatmap)} style={{flexDirection: 'row', alignItems: 'center'}}>
             <Text style={{color: showCropHeatmap ? '#4CAF50' : '#888', fontSize: 10, fontWeight: 'bold'}}>Capa {showCropHeatmap ? 'ON' : 'OFF'}</Text>
           </TouchableOpacity>
        </View>

        {/* ALTITUDE & COMPASS (CORNERS) */}
        <View style={[styles.panel, { bottom: 10, left: 10, width: 50, height: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.7)', padding: 0 }]}>
          <Text style={[styles.labelText, {fontSize: 8}]}>ALTITUD</Text>
          <Text style={[styles.dataTextLarge, {fontSize: 12, marginTop: 4}]}>{altitude !== null && altitude !== undefined ? `${altitude.toFixed(0)}m` : '---'}</Text>
        </View>

        <View style={[styles.panel, { bottom: 10, right: 10, width: 60, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.7)', padding: 0 }]}>
          <Text style={[styles.labelText, {fontSize: 8}]}>RUMBO</Text>
          <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 4}}>
             {trueHeading !== null && trueHeading !== undefined && (
               <MaterialCommunityIcons name="navigation" size={12} color="#00FFFF" style={{ transform: [{ rotate: `${trueHeading}deg` }], marginRight: 4 }} />
             )}
            <Text style={[styles.dataTextLarge, {fontSize: 12, marginTop: 0}]}>{trueHeading !== null && trueHeading !== undefined ? `${Math.round(trueHeading)}°` : '---'}</Text>
          </View>
        </View>

      </View>

      {/* 30% CONSOLA DE MANDO INFERIOR */}
      <View style={styles.consoleContainer}>

        {/* BARRA DE HERRAMIENTAS AGROCROP */}
        <View style={{ width: '100%', backgroundColor: '#000', borderBottomWidth: 1, borderBottomColor: '#2d7a2d', paddingVertical: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, gap: 12 }}>

            <TouchableOpacity
              style={{ flex: 1, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#2d7a2d', borderRadius: 10, elevation: 5 }}
              onPress={() => setShowCropModal(true)}
            >
              <MaterialCommunityIcons name="corn" size={22} color="#FFF" />
              <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '900', marginTop: 2 }}>ANALIZAR</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ width: 55, height: 55, justifyContent: 'center', alignItems: 'center', backgroundColor: '#111', borderRadius: 8, borderWidth: 1, borderColor: '#333' }}
              onPress={() => setShowConfigModal(true)}
            >
              <MaterialCommunityIcons name="cog" size={20} color="#888" />
              <Text style={{ color: '#888', fontSize: 9, fontWeight: 'bold', marginTop: 2 }}>Ajustes</Text>
            </TouchableOpacity>

          </View>
        </View>

        {/* ÁREA DINÁMICA DE TRABAJO */}
        <View style={styles.consoleContentArea}>
          {drawingType === 'polygon' ? (
             <View style={styles.actionBox}>
               <Text style={[styles.instructionText, {fontSize: 10, marginBottom: 5, color: '#4CAF50'}]}>TRAZANDO POLIGONO ({polygonCoords.length} VERTICES)</Text>

               <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center', marginTop: 5, paddingHorizontal: 10, gap: 8 }}>
                 <TouchableOpacity
                   style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#000', backgroundColor: '#2d7a2d', elevation: 5 }}
                   onPress={addPointFromCrosshair}
                 >
                    <MaterialCommunityIcons name="target" size={20} color="#FFF" />
                    <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 11, marginLeft: 6 }}>MARCAR PUNTO ({polygonCoords.length})</Text>
                 </TouchableOpacity>

                 {polygonCoords.length >= 3 && (
                   <TouchableOpacity
                     style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#000', backgroundColor: '#f5c518', elevation: 5 }}
                     onPress={() => finishDrawing()}
                   >
                      <MaterialCommunityIcons name="check" size={20} color="#000" />
                      <Text style={{ color: '#000', fontWeight: '900', fontSize: 11, marginLeft: 6 }}>FINALIZAR</Text>
                   </TouchableOpacity>
                 )}
               </View>

               <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-between', marginTop: 8, paddingHorizontal: 10 }}>
                 <TouchableOpacity style={[styles.cancelDrawBtn, { flex: 1, marginRight: 8, height: 35, borderRadius: 8, justifyContent: 'center', padding: 0, marginTop: 0 }]} onPress={() => setPolygonCoords([])}>
                    <Text style={[styles.cancelDrawText, { textAlign: 'center', fontSize: 10 }]}>LIMPIAR</Text>
                 </TouchableOpacity>
                 <TouchableOpacity style={[styles.cancelDrawBtn, { flex: 1, height: 35, borderRadius: 8, justifyContent: 'center', padding: 0, marginTop: 0 }]} onPress={() => selectMode('none')}>
                    <Text style={[styles.cancelDrawText, { textAlign: 'center', fontSize: 10 }]}>SALIR</Text>
                 </TouchableOpacity>
               </View>
             </View>
          ) : (
             <View style={styles.actionBox}>
               {(polygonCoords.length >= 3) ? (
                 <>
                   <Text style={[styles.instructionText, { fontSize: 10, marginBottom: 5, color: '#4CAF50' }]}>AREA LISTA ({(calcPolygonArea(polygonCoords) / 10000).toFixed(0)} ha)</Text>
                   <TouchableOpacity
                     style={{ backgroundColor: '#2d7a2d', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, width: '80%', borderRadius: 10, elevation: 5 }}
                     onPress={() => { setShowCropModal(false); startCropAnalysis(); }}
                   >
                     <MaterialCommunityIcons name="satellite-uplink" size={18} color="#FFF" />
                     <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 13, marginLeft: 8 }}>ANALIZAR AREA</Text>
                   </TouchableOpacity>
                   <TouchableOpacity style={{ marginTop: 8 }} onPress={clearShapes}>
                     <Text style={{ color: '#FF5555', fontSize: 10 }}>Borrar poligono</Text>
                   </TouchableOpacity>
                 </>
               ) : (
                 <View style={{ alignItems: 'center', paddingHorizontal: 20 }}>
                   <Text style={{ color: '#4CAF50', fontSize: 16, fontWeight: '900', marginBottom: 4 }}>Bienvenido a AgroCrop</Text>
                   <Text style={{ color: '#888', fontSize: 12, textAlign: 'center', marginBottom: 8 }}>Analisis satelital de cultivos en tiempo real</Text>
                   <Text style={{ color: '#666', fontSize: 11, textAlign: 'center' }}>Toca el boton verde "ANALIZAR" para empezar</Text>
                 </View>
               )}
             </View>
          )}
        </View>
      </View>

      {/* CHAT AGRONOMICO MODAL */}
      <Modal visible={showChatModal} transparent animationType="slide">
        <View style={[styles.modalOverlay, {backgroundColor: 'rgba(0,0,0,0.85)'}]}>
          <View style={{backgroundColor: '#000', borderColor: '#4CAF50', borderWidth: 2, borderRadius: 20, padding: 20, width: '95%', height: '80%'}}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: '#333', paddingBottom: 10 }}>
               <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#4CAF50' }}>Asistente Agronomico IA</Text>
               <TouchableOpacity onPress={() => setShowChatModal(false)}>
                 <MaterialCommunityIcons name="close" size={28} color="#4CAF50" />
               </TouchableOpacity>
            </View>
            <ScrollView style={{flex: 1, marginBottom: 15}}>
              {chatMessages.length === 0 && (
                <Text style={{color: '#888', textAlign: 'center', marginTop: 20}}>Soy tu asistente agronomo. Preguntame sobre cultivos, indices vegetativos, plagas, riego o fenologia.</Text>
              )}
              {chatMessages.map((msg, idx) => (
                <View key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? '#333' : '#4CAF50', padding: 12, borderRadius: 12, maxWidth: '80%', marginBottom: 10 }}>
                  <Text style={{ color: msg.role === 'user' ? '#FFF' : '#000', fontSize: 14 }}>{msg.content}</Text>
                </View>
              ))}
              {isTypingChat && <ActivityIndicator color="#4CAF50" style={{alignSelf: 'flex-start', marginTop: 10}} />}
            </ScrollView>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
              <TextInput
                style={{ flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, backgroundColor: '#222', color: '#FFF', borderColor: '#444' }}
                placeholder="Escribe tu consulta agronomica..."
                placeholderTextColor="#666"
                value={chatInput}
                onChangeText={setChatInput}
              />
              <TouchableOpacity onPress={sendChatMessage} style={{backgroundColor: '#4CAF50', padding: 12, borderRadius: 8}}>
                 <MaterialCommunityIcons name="send" size={24} color="#FFF" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* CONFIGURATION MODAL */}
      <Modal visible={showConfigModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { borderColor: '#2d7a2d' }]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
               <Text style={[styles.modalTitle, { color: '#2d7a2d' }]}>Configuracion</Text>
               <TouchableOpacity onPress={() => setShowConfigModal(false)}>
                  <MaterialCommunityIcons name="close" size={28} color="#2d7a2d" />
               </TouchableOpacity>
            </View>

            <Text style={[styles.sectionLabelModal, { color: '#4CAF50' }]}>NOMBRE DE FINCA / PROYECTO</Text>
            <TextInput
              style={[styles.modalInput, { height: 44, marginBottom: 10, fontSize: 15, fontWeight: 'bold' }]}
              value={activeProject}
              onChangeText={setActiveProject}
              placeholder="Ej: Mi Finca Norte"
              placeholderTextColor="#888"
            />

            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, { color: '#4CAF50', marginBottom: 0, marginTop: 0 }]}>Claude Vision (IA)</Text>
              <Switch value={useAI} onValueChange={setUseAI} trackColor={{ true: '#4CAF50' }} />
            </View>
            {useAI && <Text style={{color: '#888', fontSize: 11}}>Modelo: claude-haiku-4-5-20251001</Text>}

            <View style={styles.prefsRow}>
              <Text style={[styles.sectionLabelModal, { color: '#4CAF50', marginBottom: 0, marginTop: 0 }]}>Vibracion haptica</Text>
              <Switch value={vibrationEnabled} onValueChange={setVibrationEnabled} trackColor={{ true: '#4CAF50' }} />
            </View>

            <View style={[styles.modalActions, { marginTop: 30 }]}>
              <TouchableOpacity style={[styles.modalBtnSave, { backgroundColor: '#2d7a2d' }]} onPress={() => setShowConfigModal(false)}>
                <Text style={[styles.modalBtnTextBlack, { color: '#FFF' }]}>Guardar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── AGROCROP CONFIG MODAL (v5.0 con ScrollView) ────────────────── */}
      <Modal visible={showCropModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15}}>
              <Text style={[styles.modalTitle, { color: '#4CAF50' }]}>AgroCrop</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TouchableOpacity
                  style={{ backgroundColor: '#4CAF50', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
                  onPress={() => { setShowCropModal(false); startCropAnalysis(); }}
                >
                  <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 14 }}>ANALIZAR</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowCropModal(false)}>
                  <MaterialCommunityIcons name="close" size={28} color="#4CAF50" />
                </TouchableOpacity>
              </View>
            </View>

            <ScrollView showsVerticalScrollIndicator={true} contentContainerStyle={{ paddingBottom: 50 }}>

              {/* Area source selector */}
              <Text style={{ color: '#4CAF50', fontSize: 11, fontWeight: 'bold', marginBottom: 6 }}>FUENTE DEL AREA</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
                {([
                  { key: 'circle' as const, icon: 'target', label: 'Circulo' },
                  { key: 'draw' as const, icon: 'draw-pen', label: 'Trazar' },
                  { key: 'coords' as const, icon: 'map-marker-multiple', label: 'Coordenadas' },
                ] as const).map(m => (
                  <TouchableOpacity key={m.key} style={{ flex: 1, padding: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: cropAreaMode === m.key ? '#4CAF50' : '#444', backgroundColor: cropAreaMode === m.key ? 'rgba(76,175,80,0.2)' : '#222' }} onPress={() => setCropAreaMode(m.key)}>
                    <MaterialCommunityIcons name={m.icon as any} size={18} color={cropAreaMode === m.key ? '#4CAF50' : '#888'} />
                    <Text style={{ color: cropAreaMode === m.key ? '#4CAF50' : '#888', fontSize: 10, fontWeight: 'bold', marginTop: 2 }}>{m.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Circle mode */}
              {cropAreaMode === 'circle' && (
                <>
                  <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
                    {[10, 20, 40, 60, 80].map(r => (
                      <TouchableOpacity key={r} style={{ width: 48, paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: cropRadioKm === r ? '#4CAF50' : '#222', borderWidth: 1, borderColor: cropRadioKm === r ? '#4CAF50' : '#444' }} onPress={() => setCropRadioKm(r)}>
                        <Text style={{ color: cropRadioKm === r ? '#FFF' : '#AAA', fontWeight: '900', fontSize: 14 }}>{r}</Text>
                        <Text style={{ color: cropRadioKm === r ? 'rgba(255,255,255,0.7)' : '#666', fontSize: 8 }}>km</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TouchableOpacity style={{ backgroundColor: '#222', borderWidth: 1, borderColor: '#4CAF50', borderRadius: 8, padding: 8, marginBottom: 6, alignItems: 'center' }} onPress={() => { loadOsoViejoPolygon(cropRadioKm); }}>
                    <Text style={{ color: '#4CAF50', fontWeight: 'bold', fontSize: 11 }}>Oso Viejo {cropRadioKm}km (Maiz)</Text>
                  </TouchableOpacity>
                  <Text style={{ color: '#FF9800', fontSize: 10, fontWeight: 'bold', marginBottom: 4 }}>MANGO (Sinaloa Sur)</Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                    {[
                      { label: 'Escuinapa 10km', lat: 22.8317, lng: -105.7791, r: 10 },
                      { label: 'Rosario 15km', lat: 22.9939, lng: -105.8533, r: 15 },
                    ].map((area, i) => (
                      <TouchableOpacity key={i} style={{ flex: 1, backgroundColor: '#222', borderWidth: 1, borderColor: '#FF9800', borderRadius: 8, padding: 8, alignItems: 'center' }} onPress={() => {
                        const circle = generateCirclePolygon(area.lat, area.lng, area.r, 32);
                        setPolygonCoords(circle.map(([lng, lat]) => ({ latitude: lat, longitude: lng })));
                        setCropTipoCultivo('mango_ataulfo');
                        setCropAreaMode('circle');
                        const delta = Math.max(0.2, (area.r / 111.32) * 2.5);
                        mapRef.current?.animateToRegion({ latitude: area.lat, longitude: area.lng, latitudeDelta: delta, longitudeDelta: delta }, 800);
                        triggerHaptic('light');
                      }}>
                        <Text style={{ color: '#FF9800', fontWeight: 'bold', fontSize: 10 }}>{area.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              {/* Draw mode */}
              {cropAreaMode === 'draw' && (
                <TouchableOpacity style={{ backgroundColor: '#222', borderWidth: 1, borderColor: '#FFC107', borderRadius: 8, padding: 14, marginBottom: 10, alignItems: 'center' }} onPress={startCropDrawMode}>
                  <MaterialCommunityIcons name="draw-pen" size={24} color="#FFC107" />
                  <Text style={{ color: '#FFC107', fontWeight: 'bold', fontSize: 13, marginTop: 4 }}>Trazar poligono en el mapa</Text>
                  <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>Toca puntos en el mapa para crear vertices</Text>
                </TouchableOpacity>
              )}

              {/* Coordinates mode */}
              {cropAreaMode === 'coords' && (
                <>
                  <TextInput
                    style={{ backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 10, fontSize: 12, borderWidth: 1, borderColor: '#333', height: 80, textAlignVertical: 'top', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 6 }}
                    multiline
                    placeholder={'24.3994, -107.1714\n24.4100, -107.1500\n24.3800, -107.1200'}
                    placeholderTextColor="#555"
                    value={cropCoordsText}
                    onChangeText={setCropCoordsText}
                  />
                  <TouchableOpacity style={{ backgroundColor: '#222', borderWidth: 1, borderColor: '#2196F3', borderRadius: 8, padding: 10, marginBottom: 10, alignItems: 'center' }} onPress={applyCoordsFromText}>
                    <Text style={{ color: '#2196F3', fontWeight: 'bold', fontSize: 12 }}>PROCESAR COORDENADAS</Text>
                  </TouchableOpacity>
                </>
              )}

              {/* Photo OCR button */}
              <TouchableOpacity style={{ backgroundColor: '#222', borderWidth: 1, borderColor: '#9C27B0', borderRadius: 8, padding: 10, marginBottom: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }} onPress={handlePhotoOCR}>
                <MaterialCommunityIcons name="camera-document" size={20} color="#9C27B0" />
                <View>
                  <Text style={{ color: '#9C27B0', fontWeight: 'bold', fontSize: 12 }}>Foto titulo parcelario</Text>
                  <Text style={{ color: '#666', fontSize: 9 }}>OCR automatico con IA</Text>
                </View>
                {ocrProcessing && <ActivityIndicator size="small" color="#9C27B0" />}
              </TouchableOpacity>

              {/* Polygon info */}
              <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: polygonCoords.length >= 3 ? '#4CAF50' : '#333' }}>
                {polygonCoords.length >= 3 ? (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ color: '#4CAF50', fontSize: 11, fontWeight: 'bold' }}>Area: {(calcPolygonArea(polygonCoords) / 10000).toFixed(0)} ha</Text>
                        <Text style={{ color: '#888', fontSize: 10 }}>Vertices: {polygonCoords.length} | {cropAreaMode === 'circle' ? 'Circulo' : cropAreaMode === 'draw' ? 'Manual' : 'Coords'}</Text>
                      </View>
                      <TouchableOpacity style={{ backgroundColor: '#333', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }} onPress={saveCurrentPolygon}>
                        <Text style={{ color: '#FFC107', fontSize: 10, fontWeight: 'bold' }}>+ Guardar</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <Text style={{ color: '#888', fontSize: 10 }}>Sin poligono — selecciona un metodo arriba</Text>
                )}
              </View>

              {/* Multi-polygon list */}
              {cropPolygons.length > 0 && (
                <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 8, marginBottom: 10, borderWidth: 1, borderColor: '#FFC107' }}>
                  <Text style={{ color: '#FFC107', fontSize: 10, fontWeight: 'bold', marginBottom: 4 }}>POLIGONOS GUARDADOS ({cropPolygons.length})</Text>
                  {cropPolygons.map((p, i) => (
                    <View key={p.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 3 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.color }} />
                        <Text style={{ color: '#CCC', fontSize: 10 }}>{p.nombre} ({p.hectareas} ha) — {p.origen}</Text>
                      </View>
                      <TouchableOpacity onPress={() => setCropPolygons(prev => prev.filter(x => x.id !== p.id))}>
                        <Text style={{ color: '#F44336', fontSize: 10 }}>X</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* Tipo de cultivo */}
              <Text style={{ color: '#4CAF50', fontSize: 10, fontWeight: 'bold', marginBottom: 4 }}>CULTIVO</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
                {[{ k: 'maiz_riego', l: 'Maiz Riego' }, { k: 'maiz_temporal', l: 'Maiz Temporal' }].map(c => (
                  <TouchableOpacity key={c.k} style={{ flex: 1, padding: 6, borderRadius: 6, borderWidth: 1, borderColor: cropTipoCultivo === c.k ? '#4CAF50' : '#333', backgroundColor: cropTipoCultivo === c.k ? 'rgba(76,175,80,0.2)' : '#222', alignItems: 'center' }} onPress={() => setCropTipoCultivo(c.k)}>
                    <Text style={{ color: cropTipoCultivo === c.k ? '#4CAF50' : '#888', fontWeight: 'bold', fontSize: 11 }}>{c.l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                {[{ k: 'mango_ataulfo', l: 'Ataulfo' }, { k: 'mango_kent', l: 'Kent' }, { k: 'mango_tommy', l: 'Tommy' }].map(c => (
                  <TouchableOpacity key={c.k} style={{ flex: 1, padding: 6, borderRadius: 6, borderWidth: 1, borderColor: cropTipoCultivo === c.k ? '#FF9800' : '#333', backgroundColor: cropTipoCultivo === c.k ? 'rgba(255,152,0,0.15)' : '#222', alignItems: 'center' }} onPress={() => setCropTipoCultivo(c.k)}>
                    <Text style={{ color: cropTipoCultivo === c.k ? '#FF9800' : '#888', fontWeight: 'bold', fontSize: 11 }}>{c.l}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Dates */}
              <Text style={{ color: '#4CAF50', fontSize: 10, marginBottom: 10, textAlign: 'center' }}>Imagenes: {cropFechaInicio} → {cropFechaFin}</Text>

              {/* Start button */}
              <TouchableOpacity
                style={{ backgroundColor: '#4CAF50', borderRadius: 10, padding: 16, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' }}
                onPress={() => { setShowCropModal(false); startCropAnalysis(); }}
              >
                <MaterialCommunityIcons name="satellite-uplink" size={22} color="#FFF" />
                <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 16, marginLeft: 10 }}>INICIAR ANALISIS SATELITAL</Text>
              </TouchableOpacity>

            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── AGROCROP RESULTS PANEL ─────────────────────────────────────── */}
      {showCropResults && (
        <View style={[styles.resultsPanel, { borderTopColor: '#4CAF50' }]}>
          <View style={[styles.resultsHeader, { borderBottomColor: '#4CAF50' }]}>
            <Text style={[styles.resultsTitle, { color: '#4CAF50' }]}>AgroCrop - Analisis</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {cropGridCells.length > 0 && (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: showCropHeatmap ? 'rgba(76,175,80,0.2)' : '#222', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: showCropHeatmap ? '#4CAF50' : '#555' }}
                  onPress={() => setShowCropHeatmap(!showCropHeatmap)}
                >
                  <MaterialCommunityIcons name="grid" size={14} color={showCropHeatmap ? '#4CAF50' : '#888'} />
                  <Text style={{ color: showCropHeatmap ? '#4CAF50' : '#888', fontSize: 10, fontWeight: 'bold', marginLeft: 4 }}>Mapa Calor</Text>
                </TouchableOpacity>
              )}
              {cropGridLoading && <ActivityIndicator size="small" color="#4CAF50" />}
              {cropData && (
                <TouchableOpacity onPress={shareAgroCropResults} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#25D366', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
                  <MaterialCommunityIcons name="share-variant" size={14} color="#FFF" />
                  <Text style={{ color: '#FFF', fontSize: 10, fontWeight: 'bold', marginLeft: 3 }}>Compartir</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setShowCropConfig(!showCropConfig)}>
                <MaterialCommunityIcons name="cog" size={20} color={showCropConfig ? '#4CAF50' : '#888'} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowCropResults(false)}>
                <MaterialCommunityIcons name="close" size={24} color="#4CAF50" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Inline config */}
          {showCropConfig && (
            <View style={{ backgroundColor: '#1A1A1A', padding: 10, marginBottom: 8, borderRadius: 8, borderWidth: 1, borderColor: '#333' }}>
              <Text style={{ color: '#888', fontSize: 10, marginBottom: 6 }}>Radio: {cropRadioKm}km | Area: ~{Math.round(Math.PI * cropRadioKm * cropRadioKm).toLocaleString()} km2</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                {[10, 20, 40, 60, 80].map(r => (
                  <TouchableOpacity key={r} style={{ flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center', backgroundColor: cropRadioKm === r ? '#4CAF50' : '#222', borderWidth: 1, borderColor: cropRadioKm === r ? '#4CAF50' : '#444' }} onPress={() => setCropRadioKm(r)}>
                    <Text style={{ color: cropRadioKm === r ? '#FFF' : '#AAA', fontWeight: '900', fontSize: 13 }}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity style={{ backgroundColor: '#4CAF50', borderRadius: 8, padding: 10, alignItems: 'center' }} onPress={() => { setShowCropConfig(false); startCropAnalysis(); }}>
                <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 13 }}>RE-ANALIZAR CON {cropRadioKm}km</Text>
              </TouchableOpacity>
            </View>
          )}

          <ScrollView style={{ maxHeight: 450 }} showsVerticalScrollIndicator={false}>
            {/* Progress steps */}
            {cropAnalyzing && (
              <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                <ActivityIndicator size="large" color="#4CAF50" />
                <Text style={{ color: '#4CAF50', fontSize: 14, marginTop: 15, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                  {cropStep}
                </Text>
              </View>
            )}

            {/* Error */}
            {cropError ? (
              <View style={{ backgroundColor: 'rgba(255,60,60,0.1)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <Text style={{ color: '#FF5555', fontSize: 12 }}>{cropError}</Text>
              </View>
            ) : null}

            {/* Results */}
            {cropData && !cropAnalyzing && (
              <>
                {/* Freshness card */}
                <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: (cropData.frescura_dias ?? 99) <= 7 ? '#4CAF50' : (cropData.frescura_dias ?? 99) <= 14 ? '#FFC107' : (cropData.frescura_dias ?? 99) <= 30 ? '#FF9800' : '#F44336', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={{ color: '#FFF', fontSize: 12, fontWeight: 'bold' }}>{cropData.fecha_imagen} <Text style={{ color: '#888', fontWeight: 'normal' }}>(hace {cropData.frescura_dias ?? '?'}d)</Text></Text>
                    <Text style={{ color: '#888', fontSize: 10 }}>Sentinel-2 | {(cropData as any).metodo_composicion ? 'Top-3 recientes' : 'Mediana'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: (cropData.frescura_dias ?? 99) <= 7 ? '#4CAF50' : (cropData.frescura_dias ?? 99) <= 14 ? '#FFC107' : '#FF9800', fontSize: 11, fontWeight: 'bold' }}>{(cropData as any).confianza_temporal || 'Buena'}</Text>
                    <Text style={{ color: '#666', fontSize: 9 }}>{(cropData as any).margen_incertidumbre || '±15%'}</Text>
                  </View>
                </View>

                {/* Tonnage highlight */}
                <View style={{ backgroundColor: 'rgba(76,175,80,0.1)', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#4CAF50', alignItems: 'center' }}>
                  <Text style={{ color: '#888', fontSize: 11, letterSpacing: 1 }}>TONELAJE ESTIMADO</Text>
                  <Text style={{ color: '#4CAF50', fontSize: 42, fontWeight: '900', marginTop: 4 }}>
                    {cropData.tonelaje_estimado.toLocaleString()}
                  </Text>
                  <Text style={{ color: '#AAA', fontSize: 13, marginTop: 2 }}>toneladas</Text>
                  <Text style={{ color: '#666', fontSize: 12, marginTop: 6 }}>
                    Rango: {cropData.tonelaje_minimo.toLocaleString()} - {cropData.tonelaje_maximo.toLocaleString()} ton
                  </Text>
                  {cropData.tipo_cultivo_label && <Text style={{ color: '#888', fontSize: 10, marginTop: 4 }}>{cropData.tipo_cultivo_label}</Text>}
                </View>

                {/* Mango-specific metrics */}
                {cropData.mango && (
                  <View style={{ backgroundColor: 'rgba(255,152,0,0.1)', borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#FF9800' }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ color: '#FF9800', fontSize: 11 }}>Arboles: ~{cropData.mango.arboles_estimados.toLocaleString()}</Text>
                      <Text style={{ color: '#FF9800', fontSize: 11 }}>~{cropData.mango.frutos_por_arbol} frutos/arbol</Text>
                    </View>
                    <Text style={{ color: '#FFC107', fontSize: 13, fontWeight: '900', marginTop: 4 }}>Valor cosecha: ${(cropData.mango.valor_cosecha_mxn / 1e6).toFixed(1)}M MXN</Text>
                  </View>
                )}

                {/* Harvest projection */}
                {(cropData as any).proyeccion && (
                  <View style={{ backgroundColor: '#1A1A1A', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: (cropData as any).proyeccion.confianza === 'Alta' ? '#4CAF50' : (cropData as any).proyeccion.confianza === 'Media' ? '#FFC107' : '#FF9800' }}>
                    <Text style={{ color: '#4CAF50', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 6 }}>PROYECCION DE COSECHA</Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: '#FFF', fontSize: 11 }}>Cosecha: <Text style={{ fontWeight: 'bold' }}>{(cropData as any).proyeccion.fecha_cosecha}</Text></Text>
                      <Text style={{ color: '#888', fontSize: 11 }}>({(cropData as any).proyeccion.dias_a_cosecha}d)</Text>
                    </View>
                    <Text style={{ color: '#4CAF50', fontSize: 20, fontWeight: '900' }}>{(cropData as any).proyeccion.ton_ha} ton/ha</Text>
                    <Text style={{ color: '#888', fontSize: 10 }}>+{(cropData as any).proyeccion.incremento_pct}% vs actual | {(cropData as any).proyeccion.tonelaje_proyectado.toLocaleString()} ton total</Text>
                    <Text style={{ color: '#666', fontSize: 9, marginTop: 2 }}>Rango: {(cropData as any).proyeccion.rango_min.toLocaleString()} - {(cropData as any).proyeccion.rango_max.toLocaleString()} | {(cropData as any).proyeccion.confianza}</Text>
                  </View>
                )}

                {/* Key metrics grid */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {[
                    { label: 'Hectareas activas', value: `${cropData.hectareas_cultivo_activo.toLocaleString()} ha`, color: '#4CAF50' },
                    { label: 'Vigor', value: cropData.clasificacion_vigor, color: cropData.clasificacion_vigor === 'Alto' ? '#4CAF50' : cropData.clasificacion_vigor === 'Medio' ? '#FFC107' : '#FF5722' },
                    { label: 'Area optima', value: `${cropData.porcentaje_area_optima}%`, color: '#2196F3' },
                  ].map((m, i) => (
                    <View key={i} style={{ flex: 1, minWidth: '30%', backgroundColor: '#1A1A1A', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#333' }}>
                      <Text style={{ color: '#888', fontSize: 9, letterSpacing: 0.5 }}>{m.label}</Text>
                      <Text style={{ color: m.color, fontSize: 18, fontWeight: '900', marginTop: 2 }}>{m.value}</Text>
                    </View>
                  ))}
                </View>
                {/* Rendimiento with tooltip */}
                <TouchableOpacity
                  style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#333' }}
                  onPress={() => Alert.alert('Calculo de Rendimiento',
                    `NDVI promedio: ${cropData.ndvi_mean}\n` +
                    `Factor NDVI (progresivo): ${cropData.factor_ndvi}\n` +
                    `Factor NDRE (nitrogeno): ${cropData.factor_ndre}\n` +
                    `Factor etapa fenologica: ${(cropData as any).factor_etapa ?? '?'}\n` +
                    `Base Sinaloa riego: ${(cropData as any).rendimiento_base ?? 9.5} ton/ha\n\n` +
                    `Rendimiento = base × fNDVI × fNDRE × fEtapa`
                  )}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View>
                      <Text style={{ color: '#888', fontSize: 9 }}>Rendimiento/ha <Text style={{ color: '#FFC107' }}>ⓘ</Text></Text>
                      <Text style={{ color: '#FFC107', fontSize: 22, fontWeight: '900', marginTop: 2 }}>{cropData.rendimiento_por_hectarea} ton/ha</Text>
                    </View>
                    <Text style={{ color: '#666', fontSize: 9, textAlign: 'right' }}>NDVI×{cropData.factor_ndvi} NDRE×{cropData.factor_ndre}{'\n'}Etapa×{(cropData as any).factor_etapa ?? '?'}</Text>
                  </View>
                </TouchableOpacity>

                {/* Vegetation indices */}
                <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#333' }}>
                  <Text style={{ color: '#4CAF50', fontSize: 11, fontWeight: 'bold', marginBottom: 8, letterSpacing: 1 }}>INDICES VEGETATIVOS</Text>
                  {[
                    { label: 'NDVI (Vigor)', value: cropData.ndvi_mean, max: 1, color: '#4CAF50' },
                    { label: 'EVI (Biomasa)', value: cropData.evi_mean, max: 0.8, color: '#8BC34A' },
                    { label: 'NDRE (Nitrogeno)', value: cropData.ndre_mean, max: 0.6, color: '#CDDC39' },
                    { label: 'LSWI (Humedad)', value: cropData.lswi_mean, max: 0.5, color: '#03A9F4' },
                  ].map((idx, i) => (
                    <View key={i} style={{ marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                        <Text style={{ color: '#AAA', fontSize: 10 }}>{idx.label}</Text>
                        <Text style={{ color: idx.color, fontSize: 11, fontWeight: 'bold' }}>{idx.value.toFixed(4)}</Text>
                      </View>
                      <View style={{ height: 5, backgroundColor: '#2A2A2A', borderRadius: 3, overflow: 'hidden' }}>
                        <View style={{ height: 5, width: `${Math.min(100, (Math.max(0, idx.value) / idx.max) * 100)}%`, backgroundColor: idx.color, borderRadius: 3 }} />
                      </View>
                    </View>
                  ))}
                </View>

                {/* Metadata + phenology */}
                <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#333' }}>
                  <Text style={{ color: '#FFF', fontSize: 11, marginBottom: 4 }}>Imagen mas reciente: <Text style={{ color: '#4CAF50', fontWeight: 'bold' }}>{cropData.fecha_imagen}</Text></Text>
                  <Text style={{ color: '#FFF', fontSize: 11, marginBottom: 4 }}>Etapa fenologica: <Text style={{ color: '#CDDC39', fontWeight: 'bold' }}>{(() => {
                    const m = parseInt(cropData.fecha_imagen.split('-')[1], 10);
                    if (m >= 10 || m <= 11) return 'Siembra';
                    if (m === 12 || m === 1) return 'Desarrollo vegetativo';
                    if (m === 2 || m === 3) return 'Floracion / Llenado de grano';
                    return 'Madurez / Cosecha';
                  })()}</Text></Text>
                  <Text style={{ color: '#FFF', fontSize: 11, marginBottom: 4 }}>Precision estimada: <Text style={{ fontWeight: 'bold', color: (() => {
                    const m = parseInt(cropData.fecha_imagen.split('-')[1], 10);
                    if (m === 2 || m === 3) return '#4CAF50';
                    if (m === 12 || m === 1) return '#FFC107';
                    return '#FF9800';
                  })() }}>{(() => {
                    const m = parseInt(cropData.fecha_imagen.split('-')[1], 10);
                    if (m === 2 || m === 3) return 'Alta';
                    if (m === 12 || m === 1) return 'Media';
                    return 'Baja';
                  })()}</Text></Text>
                  <Text style={{ color: '#666', fontSize: 9, marginTop: 2 }}>{cropData.imagenes_usadas} escenas | {cropData.fecha_inicio} a {cropData.fecha_fin}</Text>
                  {cropData.confianza_fusion && (
                    <Text style={{ color: '#4CAF50', fontSize: 10, fontWeight: 'bold', marginTop: 4 }}>✅ {cropData.confianza_fusion} | Frescura: {cropData.frescura_dias}d</Text>
                  )}
                </View>

                {/* Satellite sources (collapsible) */}
                {cropData.fuentes_satelitales && (
                  <TouchableOpacity
                    style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#333' }}
                    onPress={() => setShowSatSources(!showSatSources)}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: '#4CAF50', fontSize: 11, fontWeight: 'bold' }}>FUENTES SATELITALES {cropExtended ? '(5)' : '(2)'} {cropExtendedLoading ? '⏳' : ''}</Text>
                      <MaterialCommunityIcons name={showSatSources ? 'chevron-up' : 'chevron-down'} size={18} color="#4CAF50" />
                    </View>
                    {showSatSources && (
                      <View style={{ marginTop: 6 }}>
                        <Text style={{ color: '#CCC', fontSize: 10, marginBottom: 2 }}>🛰️ Sentinel-2: {cropData.fuentes_satelitales.sentinel2?.fecha} ({cropData.fuentes_satelitales.sentinel2?.imagenes} imgs)</Text>
                        <Text style={{ color: '#CCC', fontSize: 10, marginBottom: 2 }}>🛰️ Landsat 8/9: {cropData.fuentes_satelitales.landsat89?.fecha} ({cropData.fuentes_satelitales.landsat89?.imagenes} imgs)</Text>
                        {cropExtended ? (
                          <>
                            <Text style={{ color: '#CCC', fontSize: 10, marginBottom: 2 }}>📡 Sentinel-1 SAR: {cropExtended.sentinel1?.fecha} ({cropExtended.sentinel1?.imagenes} imgs) | RVI: {cropExtended.sentinel1?.rvi}</Text>
                            <Text style={{ color: '#CCC', fontSize: 10, marginBottom: 2 }}>🌍 MODIS: {cropExtended.modis?.fecha} ({cropExtended.modis?.imagenes} imgs) | NDVI: {cropExtended.modis?.ndvi}</Text>
                            <Text style={{ color: '#CCC', fontSize: 10, marginBottom: 2 }}>💧 SMAP: {cropExtended.smap?.fecha} | Humedad: {cropExtended.smap?.humedad_suelo_pct}%</Text>
                          </>
                        ) : cropExtendedLoading ? (
                          <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>📡 Cargando SAR + MODIS + SMAP...</Text>
                        ) : null}
                      </View>
                    )}
                  </TouchableOpacity>
                )}

                {/* Claude analysis */}
                {cropClaudeAnalysis ? (
                  <View style={{ backgroundColor: '#1A1A1A', borderRadius: 8, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#4CAF50' }}>
                    <Text style={{ color: '#4CAF50', fontSize: 12, fontWeight: 'bold', marginBottom: 8, letterSpacing: 1 }}>ANALISIS AGRONOMICO IA</Text>
                    <Text style={{ color: '#DDD', fontSize: 12, lineHeight: 20 }}>{cropClaudeAnalysis}</Text>
                  </View>
                ) : cropAnalyzing ? null : (
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <ActivityIndicator size="small" color="#4CAF50" />
                    <Text style={{ color: '#666', fontSize: 11, marginTop: 5 }}>Cargando analisis IA...</Text>
                  </View>
                )}

                <View style={{ height: 20 }} />
              </>
            )}
          </ScrollView>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, backgroundColor: '#000' },
  
  mapContainer: { flex: 0.70, position: 'relative' },
  consoleContainer: { flex: 0.30, backgroundColor: '#111', borderTopWidth: 2, borderTopColor: '#2d7a2d' },
  consoleContentArea: { flex: 1, padding: 10, justifyContent: 'center', width: '100%' },
  actionBox: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  instructionText: { color: '#FFF', fontSize: 16, fontWeight: 'bold', marginBottom: 10, letterSpacing: 1 },
  cancelDrawBtn: { marginTop: 15, padding: 10, backgroundColor: 'rgba(255, 85, 85, 0.2)', borderRadius: 8, borderWidth: 1, borderColor: '#FF5555' },
  cancelDrawText: { color: '#FF5555', fontSize: 16, fontWeight: 'bold' },
  
  loadingText: { marginTop: 15, color: '#2d7a2d', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  errorText: { color: '#FF5555', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  map: { ...StyleSheet.absoluteFillObject },
  
  numberedMarker: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: '#2d7a2d',
    borderWidth: 2, borderColor: '#000', justifyContent: 'center', alignItems: 'center',
  },
  numberedMarkerText: { color: '#000', fontSize: 12, fontWeight: '900' },

  crosshairContainer: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: 10 },

  zoomControlsContainer: {
    position: 'absolute', right: 10, top: '35%',
    backgroundColor: 'rgba(45, 122, 45, 0.85)',
    borderRadius: 6, borderWidth: 1, borderColor: '#000', overflow: 'hidden',
  },
  zoomBtn: { padding: 10, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.3)' },

  panel: {
    position: 'absolute', backgroundColor: 'rgba(10, 10, 10, 0.75)',
    borderColor: '#2d7a2d', borderWidth: 1, borderRadius: 6,
    padding: 8, elevation: 5,
  },
  topPanel: { top: 40, alignSelf: 'center', width: 'auto', alignItems: 'center' },
  areaPanel: { top: 40, alignSelf: 'center', alignItems: 'center' },
  leftPanel: { bottom: 10, left: 10, alignItems: 'center', width: 70 },
  rightPanel: { bottom: 10, right: 10, alignItems: 'center', width: 70 },
  
  row: { flexDirection: 'row', alignItems: 'center' },
  titleText: { color: '#2d7a2d', fontSize: 12, fontWeight: 'bold' },
  dataTextLarge: { color: '#FFF', fontSize: 16, fontWeight: 'bold', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 2 },
  labelText: { color: '#2d7a2d', fontSize: 9, letterSpacing: 1 },
  
  statsTextHighlight: { color: '#2d7a2d', fontSize: 12, fontWeight: 'bold', marginBottom: 2 },
  statsTextArea: { color: '#2d7a2d', fontSize: 24, fontWeight: '900', letterSpacing: 1 },
  statsTextAreaSm: { color: '#AAA', fontSize: 12, marginTop: 1 },

  locationButton: { position: 'absolute', bottom: 100, right: 10, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 30, padding: 10, borderWidth: 1, borderColor: '#2d7a2d', zIndex: 20 },
  northIndicator: { position: 'absolute', top: 60, right: 10, width: 50, height: 50, backgroundColor: 'rgba(0,0,0,0.8)', borderRadius: 25, borderWidth: 2, borderColor: '#2d7a2d', justifyContent: 'center', alignItems: 'center', zIndex: 20 },
  northArrow: { alignItems: 'center', justifyContent: 'center' },
  northText: { color: '#2d7a2d', fontSize: 10, fontWeight: 'bold', marginTop: -4 },

  resultsPanel: {
    position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '58%',
    backgroundColor: 'rgba(0,0,0,0.97)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 2, borderTopColor: '#2d7a2d', padding: 12, zIndex: 100,
  },
  resultsHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10, borderBottomWidth: 1, borderBottomColor: '#2d7a2d', paddingBottom: 8,
  },
  resultsTitle: { color: '#2d7a2d', fontSize: 16, fontWeight: 'bold' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { width: '100%', backgroundColor: '#111', borderRadius: 12, padding: 20, borderWidth: 2, borderColor: '#2d7a2d' },
  modalTitle: { color: '#2d7a2d', fontSize: 24, fontWeight: '900', marginBottom: 5 },
  modalInput: { backgroundColor: '#222', color: '#FFF', borderRadius: 8, padding: 15, height: 120, textAlignVertical: 'top', fontSize: 18 },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, gap: 10 },
  modalBtnSave: { flex: 1, backgroundColor: '#2d7a2d', padding: 20, borderRadius: 8, alignItems: 'center' },
  modalBtnTextBlack: { color: '#000', fontWeight: 'bold', fontSize: 18 },

  sectionLabelModal: { color: '#2d7a2d', fontSize: 12, fontWeight: 'bold', marginTop: 15, marginBottom: 8, letterSpacing: 1 },
  prefsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, marginTop: 10 },
});


