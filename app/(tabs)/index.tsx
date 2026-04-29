import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Modal, TextInput, ScrollView, Switch, Share, Animated, Dimensions, Linking } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import MapView, { Marker, Polygon, Polyline, Region, MapPressEvent } from 'react-native-maps';
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

// --- Design System Colors ---
const COLORS = {
  verdePrimario: '#1B5E20',
  verdeMedio: '#2E7D32',
  verdeClaro: '#4CAF50',
  verdeSuave: '#E8F5E9',
  verdeNeon: '#00E676',
  amarilloMaiz: '#F9A825',
  amarilloMango: '#FF8F00',
  tierra: '#5D4037',
  cielo: '#E3F2FD',
  blanco: '#FAFAFA',
  negroSuave: '#1C1C1E',
  rojo: '#C62828',
};

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
  const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Map type toggle ---
  const [mapType, setMapType] = useState<'satellite' | 'standard'>('satellite');

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
  const [cropCellSizeM, setCropCellSizeM] = useState(1000);

  // NEW: Photo options state
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);

  // NEW: Saved parcels modal
  const [showParcelasModal, setShowParcelasModal] = useState(false);

  // NEW: Save polygon modal
  const [showSavePolygonModal, setShowSavePolygonModal] = useState(false);
  const [newParcelName, setNewParcelName] = useState('');
  const [newParcelCultivo, setNewParcelCultivo] = useState('');

  // NEW: Persistent saved parcels
  const [savedParcelas, setSavedParcelas] = useState<any[]>([]);

  // NEW: Claude analysis collapsible
  const [showClaudeAnalysis, setShowClaudeAnalysis] = useState(true);

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
  const startCropAnalysis = async (coordsOverride?: Coordinate[], tipoOverride?: string) => {
    setCropError('');
    setCropAnalyzing(true);
    setCropClaudeAnalysis('');
    setCropData(null);
    setCropGridCells([]);
    setCropExtended(null);
    setCropExtendedLoading(false);
    setShowCropResults(true);
    triggerHaptic('medium');

    // Use overrides if provided (from saved parcels), otherwise use current state
    const coordsToUse = coordsOverride || polygonCoords;
    const tipoToUse = tipoOverride || cropTipoCultivo;
    if (tipoOverride) setCropTipoCultivo(tipoOverride);
    if (coordsOverride) setPolygonCoords(coordsOverride);

    try {
      // Build coordinates based on area mode
      let geeCoords: number[][];
      console.log('[AgroCrop] Modo area:', cropAreaMode, '| coords:', coordsToUse.length, '| tipo:', tipoToUse);

      if (coordsToUse.length >= 3) {
        // Use provided/existing polygon coordinates
        geeCoords = coordsToUse.map(c => [c.longitude, c.latitude]);
        geeCoords.push(geeCoords[0]); // close ring
        // Zoom to polygon center
        const lats = coordsToUse.map(c => c.latitude);
        const lngs = coordsToUse.map(c => c.longitude);
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
      const result = await getBiomassAnalysis(geeCoords, cropFechaInicio, cropFechaFin, tipoToUse);
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
      const tipoLabel = result.tipo_cultivo_label || tipoToUse;
      const claudeText = await analyzeCropBiomassWithClaude(biomassStats, tipoLabel);
      setCropClaudeAnalysis(claudeText);
      triggerHaptic('success');
      setCropStep('');

      // Update ultimo_analisis + resultado for matching saved parcel
      try {
        const stored = await AsyncStorage.getItem('mis_parcelas');
        if (stored) {
          const list = JSON.parse(stored);
          const updated = list.map((p: any) => {
            if (p.coordenadas && polygonCoords.length > 0 &&
                Math.abs(p.coordenadas[0]?.latitude - polygonCoords[0]?.latitude) < 0.001) {
              return {
                ...p,
                ultimo_analisis: new Date().toISOString(),
                resultado_analisis: {
                  tonelaje: result.tonelaje_estimado,
                  rendimiento: result.rendimiento_por_hectarea,
                  vigor: result.clasificacion_vigor,
                  proyeccion: result.proyeccion,
                },
              };
            }
            return p;
          });
          await AsyncStorage.setItem('mis_parcelas', JSON.stringify(updated));
          setSavedParcelas(updated);
        }
      } catch {}

      // Step 3: Fetch heatmap grid + extended satellites in parallel (non-blocking)
      setCropGridLoading(true);
      setCropExtendedLoading(true);

      // Grid (awaited)
      try {
        setCropStep('Construyendo mapa de calor...');
        const gridResult = await getBiomassGrid(geeCoords, cropFechaInicio, cropFechaFin);
        setCropGridCells(gridResult.grid);
        if (gridResult.cell_size_m) setCropCellSizeM(gridResult.cell_size_m);
        setShowCropHeatmap(true);
        console.log('[AgroCrop] Grid recibido:', gridResult.grid.length, 'celdas, celda:', gridResult.cell_size_m || '?', 'm');
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
      const areaKm2Share = Math.round(Math.PI * cropRadioKm * cropRadioKm).toLocaleString();
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
📐 Area total: ${areaKm2Share} km2

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

🤖 _Generado con AgroCrop v2.9_
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
    setCropCoordsText('');
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
    setDrawingType('none'); // stop drawing but do NOT clear polygonCoords
    setCropAreaMode('draw');
    console.log('[AgroCrop] Trazado finalizado:', polygonCoords.length, 'vertices');
    if (polygonCoords.length >= 3) {
      AsyncStorage.setItem('lastPolygon', JSON.stringify(polygonCoords));
      setShowSavePolygonModal(true);
    }
  };

  // ── Persistent parcel storage ────────────────────────────────────────────
  const guardarParcela = async (nombre: string, coords: Coordinate[], tipoCultivo: string) => {
    if (!coords || coords.length < 3) {
      console.error('[GUARDAR] Error: coords vacias o < 3:', coords?.length);
      Alert.alert('Error', 'No hay poligono valido para guardar.');
      return null;
    }
    if (!tipoCultivo) {
      Alert.alert('Error', 'Selecciona el tipo de cultivo.');
      return null;
    }
    try {
      console.log('[GUARDAR] Guardando:', nombre, '| coords:', coords.length, '| cultivo:', tipoCultivo);
      const parcelas = await AsyncStorage.getItem('mis_parcelas');
      const lista = parcelas ? JSON.parse(parcelas) : [];
      const nueva = {
        id: Date.now().toString(),
        nombre: nombre?.trim() || 'Mi Parcela',
        coordenadas: coords,
        tipo_cultivo: tipoCultivo,
        hectareas: Math.round(calcPolygonArea(coords) / 10000),
        fecha_creacion: new Date().toISOString(),
        ultimo_analisis: null,
        resultado_analisis: null,
      };
      lista.push(nueva);
      await AsyncStorage.setItem('mis_parcelas', JSON.stringify(lista));
      setSavedParcelas([...lista]);
      console.log('[GUARDAR] OK. Total parcelas:', lista.length);
      return nueva;
    } catch (e: any) {
      console.error('[GUARDAR] Error:', e.message);
      Alert.alert('Error al guardar', 'No se pudo guardar. Intenta de nuevo.');
      return null;
    }
  };

  const cargarParcelas = async () => {
    try {
      const data = await AsyncStorage.getItem('mis_parcelas');
      if (data) {
        const lista = JSON.parse(data);
        setSavedParcelas(lista);
        console.log('[PARCELAS] Cargadas:', lista.length);
      } else {
        setSavedParcelas([]);
        console.log('[PARCELAS] Sin parcelas guardadas');
      }
    } catch (e: any) {
      console.error('[PARCELAS] Error cargando:', e.message);
      setSavedParcelas([]);
    }
  };

  const borrarParcela = async (id: string) => {
    const data = await AsyncStorage.getItem('mis_parcelas');
    const lista = data ? JSON.parse(data) : [];
    const filtered = lista.filter((p: any) => p.id !== id);
    await AsyncStorage.setItem('mis_parcelas', JSON.stringify(filtered));
    setSavedParcelas(filtered);
  };

  // ── OCR: Internal processing function ────────────────────────────────────────
  const procesarFotoTitulo = async (base64: string) => {
    setOcrProcessing(true);
    setShowCropModal(false);
    setShowPhotoOptions(false);
    setCropStep('Procesando titulo parcelario con IA...');
    setShowCropResults(true);
    setCropAnalyzing(true);

    try {
      const ocr = await extractCoordsFromPhoto(base64);
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
        [{ text: 'Analizar', onPress: () => {
          Alert.alert('Tipo de cultivo', 'Selecciona el cultivo de esta parcela', [
            { text: 'Maiz Riego', onPress: () => { setCropTipoCultivo('maiz_riego'); startCropAnalysis(); } },
            { text: 'Mango Ataulfo', onPress: () => { setCropTipoCultivo('mango_ataulfo'); startCropAnalysis(); } },
            { text: 'Otro cultivo', onPress: () => { setShowCropModal(true); } },
          ]);
        }}, { text: 'Ver en mapa' }]
      );
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setOcrProcessing(false);
      setCropAnalyzing(false);
      setCropStep('');
    }
  };

  // ── OCR: Photo from gallery ────────────────────────────────────────
  const handlePhotoOCR = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      await procesarFotoTitulo(result.assets[0].base64);
    } catch (e: any) {
      Alert.alert('Error', e.message);
      setOcrProcessing(false);
      setCropAnalyzing(false);
      setCropStep('');
    }
  };

  // ── OCR: Photo from camera ────────────────────────────────────────
  const handlePhotoCameraOCR = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permisos', 'Se necesitan permisos de camara para tomar fotos.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]?.base64) return;
      await procesarFotoTitulo(result.assets[0].base64);
    } catch (e: any) {
      Alert.alert('Error', e.message);
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
    // Calculate halfDeg from actual cell size in meters (with minimum visibility)
    const halfDeg = Math.max((cropCellSizeM / 1000) / 111.32 / 2, 0.00005);
    console.log('[AgroCrop] Renderizando', cropGridCells.length, 'celdas, celda:', cropCellSizeM, 'm, halfDeg:', halfDeg.toFixed(5));
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
  }, [cropGridCells, cropCellSizeM]);

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
  const zoomMinLabels = cropCellSizeM < 30 ? 0.005 : cropCellSizeM < 100 ? 0.02 : cropCellSizeM < 500 ? 0.1 : 0.3;
  const showGridLabels = currentZoom < zoomMinLabels && visibleGridPolygons.length <= 300;

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
        Alert.alert(
          'GPS Requerido',
          'AgroCrop necesita tu ubicacion para funcionar. Habilita el GPS en Ajustes.',
          [
            { text: 'Abrir Ajustes', onPress: () => Linking.openSettings() },
            { text: 'Reintentar', onPress: () => startWatching() },
          ]
        );
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
        await cargarParcelas();
      } catch (e) {}
    };
    loadSaved();
  }, []);

  const handleRegionChangeComplete = (region: Region) => {
    setMapCenter(region);
    updateGridViewport(region);
  };

  const handleMapPress = (e: MapPressEvent) => {
    if (cropDrawing) {
      const coord = e.nativeEvent.coordinate;
      setPolygonCoords(prev => [...prev, { latitude: coord.latitude, longitude: coord.longitude }]);
      triggerHaptic('light');
    }
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

  // Calc stats (memoized)
  const resolvedPolygonCoords = polygonCoords;
  const areaM2 = useMemo(() => polygonCoords.length > 2 ? calcPolygonArea(polygonCoords) : 0, [polygonCoords]);
  const infoText = polygonCoords.length > 2 ? `${polygonCoords.length} pts` : "";
  const areaHa = (areaM2 / 10000).toFixed(2);
  const areaKm2 = (areaM2 / 1000000).toFixed(4);
  const showStatsBox = areaM2 > 0;

  if (errorMsg) return (
    <View style={styles.center}>
      <Text style={styles.errorText}>{errorMsg}</Text>
    </View>
  );

  if (!location) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={COLORS.verdeClaro} />
      <Text style={styles.loadingText}>Calibrando GPS...</Text>
    </View>
  );

  const { latitude, longitude, altitude } = location.coords;
  const trueHeading = heading ? heading.trueHeading || heading.magHeading : 0;

  return (
    <View style={styles.container}>

      {/* ═══ HEADER (60px) ═══ */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🌿 AgroCrop</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => Alert.alert('Conexion', isConnected ? 'Online (Conectado a Claude)' : 'Offline (Motor Local)')}
            style={styles.headerOnlineIndicator}
          >
            <View style={[styles.onlineDot, { backgroundColor: isConnected ? COLORS.verdeNeon : '#888' }]} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.mapTypeToggle}
            onPress={() => setMapType(mapType === 'satellite' ? 'standard' : 'satellite')}
          >
            <Text style={styles.mapTypeText}>{mapType === 'satellite' ? 'SAT' : 'MAP'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ═══ MAP (flex 0.60) ═══ */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={styles.map}
          mapType={mapType}
          showsUserLocation={false}
          followsUserLocation={false}
          showsCompass={false}
          region={mapCenter || undefined}
          onRegionChange={(region: any) => {
            if (region.heading !== undefined) { setMapRotation(region.heading); }
            if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
            zoomTimeoutRef.current = setTimeout(() => setCurrentZoom(region.latitudeDelta), 200);
          }}
          onRegionChangeComplete={handleRegionChangeComplete}
          onPress={handleMapPress}
        >
          {/* User location marker */}
          {location && (
            <Marker coordinate={{latitude: location.coords.latitude, longitude: location.coords.longitude}} anchor={{x: 0.5, y: 0.5}} zIndex={100} flat>
              <View style={{alignItems: 'center'}}>
                {trueHeading !== null && trueHeading !== undefined && (
                  <View style={{ transform: [{ rotate: `${trueHeading}deg` }], marginBottom: -4, zIndex: -1 }}>
                    <MaterialCommunityIcons name="navigation" size={20} color="rgba(0,122,255,0.8)" />
                  </View>
                )}
                <View style={styles.userLocationDot} />
              </View>
            </Marker>
          )}

          {/* Main polygon */}
          {resolvedPolygonCoords.length > 0 && (
            <Polygon
              coordinates={resolvedPolygonCoords}
              strokeColor={COLORS.verdeNeon}
              fillColor="rgba(0,230,118,0.15)"
              strokeWidth={3}
              zIndex={3}
            />
          )}

          {/* Polyline connecting points during drawing */}
          {cropDrawing && polygonCoords.length >= 2 && (
            <Polyline
              coordinates={polygonCoords}
              strokeColor={COLORS.verdeNeon}
              strokeWidth={3}
              zIndex={4}
            />
          )}
          {/* Dashed preview line from last point back to first (close preview) */}
          {cropDrawing && polygonCoords.length >= 3 && (
            <Polyline
              coordinates={[polygonCoords[polygonCoords.length - 1], polygonCoords[0]]}
              strokeColor={COLORS.verdeNeon}
              strokeWidth={2}
              lineDashPattern={[8, 6]}
              zIndex={4}
            />
          )}

          {/* Numbered vertex markers */}
          {resolvedPolygonCoords.map((coord, i) => (
            <Marker
              key={`p-${i}`}
              coordinate={coord}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={10}
              draggable={cropDrawing}
              onDragEnd={(e) => {
                const newCoords = [...polygonCoords];
                newCoords[i] = e.nativeEvent.coordinate;
                setPolygonCoords(newCoords);
                triggerHaptic('light');
              }}
            >
              <View style={{ backgroundColor: COLORS.verdeMedio, borderRadius: 50, width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFF' }}>
                <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 12 }}>{i + 1}</Text>
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

        {/* CROSSHAIR removed — direct tap to add points */}

        {/* CROP DRAW MODE OVERLAY */}
        {cropDrawing && (
          <>
            <View style={{ position: 'absolute', top: 44, left: 12, right: 12, zIndex: 999, backgroundColor: COLORS.verdeMedio, padding: 12, borderRadius: 12, alignItems: 'center' }}>
              <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 15 }}>📍 Toca el mapa para agregar puntos • Arrastra para ajustar</Text>
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 }}>{polygonCoords.length} {polygonCoords.length === 1 ? 'punto' : 'puntos'} marcados</Text>
            </View>
            <View style={{ position: 'absolute', bottom: 100, left: 16, right: 16, zIndex: 999, flexDirection: 'row', gap: 10 }}>
              {polygonCoords.length > 0 && (
                <TouchableOpacity style={{ flex: 1, backgroundColor: COLORS.negroSuave, padding: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 }} onPress={() => setPolygonCoords(polygonCoords.slice(0, -1))}>
                  <MaterialCommunityIcons name="undo" size={18} color="#FFF" />
                  <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 14 }}>Deshacer</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={{ flex: 1, backgroundColor: '#FFF', padding: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: COLORS.rojo }} onPress={() => { setCropDrawing(false); selectMode('none'); setPolygonCoords([]); }}>
                <Text style={{ color: COLORS.rojo, fontWeight: '700', fontSize: 14 }}>Cancelar</Text>
              </TouchableOpacity>
              {polygonCoords.length >= 3 && (
                <TouchableOpacity style={{ flex: 2, backgroundColor: COLORS.verdeClaro, padding: 14, borderRadius: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 }} onPress={finishCropDraw}>
                  <MaterialCommunityIcons name="check-circle" size={18} color="#FFF" />
                  <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 14 }}>CERRAR POLIGONO</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* VERSION TAG */}
        <View style={styles.versionTag}>
          <Text style={styles.versionTagText}>AgroCrop v2.9</Text>
        </View>

        {/* FLOATING MAP CONTROLS (RIGHT) */}
        <View style={styles.floatingControls}>
          <TouchableOpacity style={styles.floatingBtn} onPress={zoomIn}>
            <MaterialCommunityIcons name="plus" size={22} color={COLORS.verdeMedio} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.floatingBtn} onPress={zoomOut}>
            <MaterialCommunityIcons name="minus" size={22} color={COLORS.verdeMedio} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.floatingBtn} onPress={() => { if (location) { mapRef.current?.animateToRegion({ latitude: location.coords.latitude, longitude: location.coords.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 }, 500); } }}>
            <MaterialCommunityIcons name="crosshairs-gps" size={22} color={COLORS.verdeMedio} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.floatingBtn} onPress={() => { triggerHaptic('heavy'); setShowChatModal(true); }}>
            <View style={[styles.northArrow, { transform: [{ rotate: `${-mapRotation}deg` }] }]}>
              <MaterialCommunityIcons name="arrow-up" size={20} color={COLORS.verdeMedio} />
              <Text style={styles.northText}>N</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* FIELD INDICATORS (bottom-left) */}
        <View style={styles.fieldIndicators}>
          <View style={styles.fieldPill}>
            <Text style={styles.fieldPillLabel}>ALT</Text>
            <Text style={styles.fieldPillValue}>{altitude !== null && altitude !== undefined ? `${altitude.toFixed(0)}m` : '---'}</Text>
          </View>
          <View style={styles.fieldPill}>
            <Text style={styles.fieldPillLabel}>HDG</Text>
            <Text style={styles.fieldPillValue}>{trueHeading !== null && trueHeading !== undefined ? `${Math.round(trueHeading)}°` : '---'}</Text>
          </View>
        </View>

        {/* Heatmap legend */}
        {cropGridCells.length > 0 && (
          <View style={styles.heatLegendContainer}>
            <TouchableOpacity
              style={styles.heatLegendToggle}
              onPress={() => setShowHeatLegend(!showHeatLegend)}
            >
              <Text style={{ fontSize: 14 }}>🌡️</Text>
            </TouchableOpacity>
            {showHeatLegend && (
              <View style={styles.heatLegendBox}>
                {[
                  { color: '#1a5c1a', label: '+10 t/ha' },
                  { color: '#4caf50', label: '8-10' },
                  { color: '#cddc39', label: '6-8' },
                  { color: '#ff9800', label: '4-6' },
                  { color: '#f44336', label: '<4' },
                ].map((item, i) => (
                  <View key={i} style={styles.heatLegendRow}>
                    <View style={[styles.heatLegendDot, { backgroundColor: item.color }]} />
                    <Text style={styles.heatLegendText}>{item.label}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Old crosshair drawing console removed — replaced by direct tap mode */}
      </View>

      {/* ═══ INFO ZONE BAR (only when polygon exists) ═══ */}
      {showStatsBox && (
        <View style={styles.infoZoneBar}>
          <Text style={styles.infoZoneText}>📐 {areaHa} ha  |  Radio: {cropRadioKm}km  |  {infoText}</Text>
        </View>
      )}

      {/* ═══ BOTTOM BAR (80px) ═══ */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={[styles.bottomBtnPrimary, polygonCoords.length >= 3 && { backgroundColor: '#00C853' }]}
          onPress={() => {
            if (polygonCoords.length >= 3) {
              if (!cropTipoCultivo || cropTipoCultivo === 'maiz_riego') {
                Alert.alert('Tipo de cultivo', 'Selecciona el cultivo para analizar', [
                  { text: 'Maiz Riego', onPress: () => startCropAnalysis(polygonCoords, 'maiz_riego') },
                  { text: 'Maiz Temporal', onPress: () => startCropAnalysis(polygonCoords, 'maiz_temporal') },
                  { text: 'Mango Ataulfo', onPress: () => startCropAnalysis(polygonCoords, 'mango_ataulfo') },
                  { text: 'Mas opciones', onPress: () => setShowCropModal(true) },
                ]);
              } else {
                startCropAnalysis(polygonCoords, cropTipoCultivo);
              }
            } else {
              setShowCropModal(true);
            }
          }}
        >
          <Text style={styles.bottomBtnPrimaryText}>{polygonCoords.length >= 3 ? '🚀 INICIAR ANALISIS' : '🌾 ANALIZAR mis cultivos'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.bottomBtnSecondary}
          onPress={async () => { await cargarParcelas(); setShowParcelasModal(true); }}
        >
          <Text style={styles.bottomBtnSecondaryText}>📂 MIS PARCELAS</Text>
        </TouchableOpacity>
      </View>

      {/* ═══ CHAT AGRONOMICO MODAL ═══ */}
      <Modal visible={showChatModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.chatModalContent}>
            <View style={styles.chatHeader}>
              <Text style={styles.chatHeaderTitle}>🌿 Asistente Agronomico IA</Text>
              <TouchableOpacity onPress={() => setShowChatModal(false)}>
                <MaterialCommunityIcons name="close" size={28} color={COLORS.verdeClaro} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.chatScroll}>
              {chatMessages.length === 0 && (
                <Text style={styles.chatEmpty}>Soy tu asistente agronomo. Preguntame sobre cultivos, indices vegetativos, plagas, riego o fenologia.</Text>
              )}
              {chatMessages.slice(-20).map((msg, idx) => (
                <View key={idx} style={[styles.chatBubble, msg.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleAssistant]}>
                  <Text style={[styles.chatBubbleText, msg.role === 'user' ? styles.chatBubbleTextUser : styles.chatBubbleTextAssistant]}>{msg.content}</Text>
                </View>
              ))}
              {isTypingChat && <ActivityIndicator color={COLORS.verdeClaro} style={{alignSelf: 'flex-start', marginTop: 10}} />}
            </ScrollView>
            <View style={styles.chatInputRow}>
              <TextInput
                style={styles.chatInput}
                placeholder="Escribe tu consulta agronomica..."
                placeholderTextColor="#999"
                value={chatInput}
                onChangeText={setChatInput}
              />
              <TouchableOpacity onPress={sendChatMessage} style={styles.chatSendBtn}>
                <MaterialCommunityIcons name="send" size={22} color="#FFF" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ═══ CONFIGURATION MODAL ═══ */}
      <Modal visible={showConfigModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.configModalContent}>
            <View style={styles.configHeader}>
              <Text style={styles.configTitle}>Configuracion</Text>
              <TouchableOpacity onPress={() => setShowConfigModal(false)}>
                <MaterialCommunityIcons name="close" size={28} color={COLORS.verdeMedio} />
              </TouchableOpacity>
            </View>

            <Text style={styles.configLabel}>NOMBRE DE FINCA / PROYECTO</Text>
            <TextInput
              style={styles.configInput}
              value={activeProject}
              onChangeText={setActiveProject}
              placeholder="Ej: Mi Finca Norte"
              placeholderTextColor="#999"
            />

            <View style={styles.configRow}>
              <Text style={styles.configRowLabel}>Claude Vision (IA)</Text>
              <Switch value={useAI} onValueChange={setUseAI} trackColor={{ true: COLORS.verdeClaro, false: '#ccc' }} />
            </View>
            {useAI && <Text style={styles.configSubtext}>Modelo: claude-haiku-4-5-20251001</Text>}

            <View style={styles.configRow}>
              <Text style={styles.configRowLabel}>Vibracion haptica</Text>
              <Switch value={vibrationEnabled} onValueChange={setVibrationEnabled} trackColor={{ true: COLORS.verdeClaro, false: '#ccc' }} />
            </View>

            <TouchableOpacity style={styles.configSaveBtn} onPress={() => setShowConfigModal(false)}>
              <Text style={styles.configSaveBtnText}>Guardar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ═══ PARCELAS GUARDADAS MODAL ═══ */}
      <Modal visible={showParcelasModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.parcelasModalContent}>
            <View style={styles.configHeader}>
              <Text style={styles.configTitle}>Mis Parcelas</Text>
              <TouchableOpacity onPress={() => setShowParcelasModal(false)}>
                <MaterialCommunityIcons name="close" size={28} color={COLORS.verdeMedio} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ flex: 1 }}>
              {savedParcelas.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#999', fontSize: 16 }}>📭 Aun no tienes parcelas guardadas</Text>
                  <TouchableOpacity
                    style={{ marginTop: 16, backgroundColor: COLORS.verdeClaro, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 }}
                    onPress={() => { setShowParcelasModal(false); setCropDrawing(true); selectMode('polygon'); setPolygonCoords([]); }}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 14 }}>Trazar mi primera parcela</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                savedParcelas.map((parcela) => (
                  <View key={parcela.id} style={styles.parcelaCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={[styles.parcelaColorDot, { backgroundColor: COLORS.verdeClaro }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.parcelaName}>{parcela.nombre}</Text>
                        <Text style={styles.parcelaInfo}>{parcela.hectareas} ha  {parcela.tipo_cultivo?.replace('_', ' ')}</Text>
                        {parcela.ultimo_analisis ? (
                          <Text style={{ color: COLORS.verdeClaro, fontSize: 11, marginTop: 2 }}>
                            Analizado: {new Date(parcela.ultimo_analisis).toLocaleDateString()}
                            {parcela.resultado_analisis ? ` - ${parcela.resultado_analisis.tonelaje?.toLocaleString()} ton` : ''}
                          </Text>
                        ) : (
                          <Text style={{ color: '#999', fontSize: 11, marginTop: 2 }}>Sin analisis todavia</Text>
                        )}
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <TouchableOpacity style={[styles.parcelaActionBtn, { backgroundColor: COLORS.verdeSuave, borderColor: COLORS.verdeClaro }]} onPress={() => {
                        setCropAreaMode('draw');
                        setShowParcelasModal(false);
                        startCropAnalysis(parcela.coordenadas, parcela.tipo_cultivo);
                      }}>
                        <Text style={[styles.parcelaActionText, { color: COLORS.verdeMedio }]}>Analizar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.parcelaActionBtn} onPress={() => {
                        setPolygonCoords(parcela.coordenadas);
                        const lats = parcela.coordenadas.map((c: Coordinate) => c.latitude);
                        const lngs = parcela.coordenadas.map((c: Coordinate) => c.longitude);
                        mapRef.current?.animateToRegion({
                          latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
                          longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
                          latitudeDelta: (Math.max(...lats) - Math.min(...lats)) * 1.4,
                          longitudeDelta: (Math.max(...lngs) - Math.min(...lngs)) * 1.4,
                        }, 800);
                        setShowParcelasModal(false);
                      }}>
                        <Text style={styles.parcelaActionText}>Ver en mapa</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.parcelaActionBtn, { borderColor: COLORS.rojo }]} onPress={() => borrarParcela(parcela.id)}>
                        <Text style={[styles.parcelaActionText, { color: COLORS.rojo }]}>Borrar</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ═══ SAVE POLYGON MODAL ═══ */}
      <Modal visible={showSavePolygonModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.parcelasModalContent, { maxHeight: '85%' }]}>
            <ScrollView>
              <Text style={{ fontSize: 20, fontWeight: '900', color: COLORS.verdePrimario, textAlign: 'center', marginTop: 16 }}>POLIGONO CREADO</Text>
              <Text style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: 6 }}>
                {Math.round(calcPolygonArea(polygonCoords) / 10000)} ha  -  {polygonCoords.length} vertices
              </Text>

              <Text style={{ fontWeight: '700', color: COLORS.negroSuave, marginTop: 20, marginLeft: 16 }}>Nombre de la parcela</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: '#DDD', borderRadius: 10, padding: 12, margin: 16, marginTop: 8, fontSize: 15, color: COLORS.negroSuave }}
                placeholder="Mi parcela..."
                placeholderTextColor="#AAA"
                value={newParcelName}
                onChangeText={setNewParcelName}
              />

              <Text style={{ fontWeight: '700', color: COLORS.negroSuave, marginLeft: 16 }}>Tipo de cultivo</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16, paddingTop: 8 }}>
                {['maiz_riego', 'maiz_temporal', 'mango_ataulfo', 'mango_kent', 'mango_tommy', 'tomate', 'chile', 'aguacate', 'sorgo', 'limon'].map(cultivo => (
                  <TouchableOpacity
                    key={cultivo}
                    onPress={() => setNewParcelCultivo(cultivo)}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                      backgroundColor: newParcelCultivo === cultivo ? COLORS.verdeClaro : '#F0F0F0',
                      borderWidth: 1,
                      borderColor: newParcelCultivo === cultivo ? COLORS.verdeMedio : '#DDD',
                    }}
                  >
                    <Text style={{ color: newParcelCultivo === cultivo ? '#FFF' : '#555', fontWeight: '600', fontSize: 13 }}>{cultivo.replace('_', ' ')}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {(newParcelName.length > 0 && newParcelName.length < 3) && (
                <Text style={{ color: COLORS.rojo, fontSize: 12, marginLeft: 16 }}>El nombre debe tener al menos 3 caracteres</Text>
              )}

              <TouchableOpacity
                style={{
                  backgroundColor: (newParcelName.length >= 3 && newParcelCultivo) ? COLORS.verdeClaro : '#CCC',
                  padding: 16, borderRadius: 12, margin: 16, alignItems: 'center',
                }}
                disabled={newParcelName.length < 3 || !newParcelCultivo}
                onPress={async () => {
                  const savedCoords = [...polygonCoords];
                  const result = await guardarParcela(newParcelName, savedCoords, newParcelCultivo);
                  if (result) {
                    setShowSavePolygonModal(false);
                    setNewParcelName('');
                    setNewParcelCultivo('');
                    triggerHaptic('success');
                    Alert.alert('Parcela guardada', `"${result.nombre}" guardada con ${savedCoords.length} vertices.`);
                  }
                }}
              >
                <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 15 }}>GUARDAR PARCELA</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  backgroundColor: (newParcelName.length >= 3 && newParcelCultivo) ? COLORS.amarilloMaiz : '#CCC',
                  padding: 16, borderRadius: 12, marginHorizontal: 16, alignItems: 'center',
                }}
                disabled={newParcelName.length < 3 || !newParcelCultivo}
                onPress={async () => {
                  const savedCoords = [...polygonCoords];
                  const savedCultivo = newParcelCultivo;
                  await guardarParcela(newParcelName, savedCoords, savedCultivo);
                  setCropAreaMode('draw');
                  setShowSavePolygonModal(false);
                  setNewParcelName('');
                  setNewParcelCultivo('');
                  triggerHaptic('success');
                  startCropAnalysis(savedCoords, savedCultivo);
                }}
              >
                <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 15 }}>GUARDAR Y ANALIZAR AHORA</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{ alignItems: 'center', paddingVertical: 16 }}
                onPress={() => {
                  setShowSavePolygonModal(false);
                  setCropDrawing(true);
                  selectMode('polygon');
                }}
              >
                <Text style={{ color: COLORS.verdeMedio, fontWeight: '600', fontSize: 14 }}>← Seguir editando</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ═══ ANALIZAR BOTTOM SHEET MODAL ═══ */}
      <Modal visible={showCropModal} transparent animationType="slide">
        <View style={styles.bottomSheetOverlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowCropModal(false)} />
          <View style={styles.bottomSheetContent}>
            <View style={styles.bottomSheetHandle} />
            <Text style={styles.bottomSheetTitle}>🌾 ¿Donde estan tus cultivos?</Text>

            {/* Option Cards */}
            <TouchableOpacity style={styles.optionCard} onPress={startCropDrawMode}>
              <View style={styles.optionCardIcon}>
                <Text style={{ fontSize: 24 }}>✏️</Text>
              </View>
              <View style={styles.optionCardBody}>
                <Text style={styles.optionCardTitle}>TRAZAR A MANO</Text>
                <Text style={styles.optionCardSubtitle}>Dibuja el contorno tocando el mapa</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color="#999" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.optionCard} onPress={() => { setCropAreaMode('coords'); }}>
              <View style={styles.optionCardIcon}>
                <Text style={{ fontSize: 24 }}>📍</Text>
              </View>
              <View style={styles.optionCardBody}>
                <Text style={styles.optionCardTitle}>INGRESAR COORDENADAS</Text>
                <Text style={styles.optionCardSubtitle}>Escribe o pega las coordenadas GPS</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color="#999" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.optionCard} onPress={() => { setShowCropModal(false); setShowPhotoOptions(true); }}>
              <View style={styles.optionCardIcon}>
                <Text style={{ fontSize: 24 }}>📸</Text>
              </View>
              <View style={styles.optionCardBody}>
                <Text style={styles.optionCardTitle}>FOTO DE TITULO</Text>
                <Text style={styles.optionCardSubtitle}>La IA extrae las coordenadas automatico</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color="#999" />
            </TouchableOpacity>


            {cropAreaMode === 'coords' && (
              <View style={styles.inlineModeSection}>
                <Text style={{ color: COLORS.tierra, fontSize: 13, marginBottom: 8 }}>Ingresa un punto por linea:{'\n'}Formato: latitud, longitud</Text>
                <TextInput
                  style={[styles.coordsInput, { height: 160, backgroundColor: '#F5F5F5', borderColor: '#DDD', borderWidth: 1 }]}
                  multiline
                  placeholder={'Ejemplo:\n24.3994, -107.1714\n24.4100, -107.1500\n24.3800, -107.1200'}
                  placeholderTextColor="#BBB"
                  value={cropCoordsText}
                  onChangeText={setCropCoordsText}
                  keyboardType="numbers-and-punctuation"
                />
                <TouchableOpacity style={[styles.coordsProcessBtn, { height: 50, borderRadius: 12 }]} onPress={applyCoordsFromText}>
                  <Text style={styles.coordsProcessBtnText}>📍 PROCESAR COORDENADAS</Text>
                </TouchableOpacity>

                <Text style={{ color: '#999', fontSize: 12, marginTop: 12, marginBottom: 6 }}>O usa coordenadas de ejemplo:</Text>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <TouchableOpacity style={{ backgroundColor: COLORS.verdeSuave, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.verdeClaro }} onPress={() => {
                    setCropCoordsText('24.3994, -107.1714\n24.4500, -107.1714\n24.4500, -107.1200\n24.3994, -107.1200');
                  }}>
                    <Text style={{ color: COLORS.verdeMedio, fontWeight: '600', fontSize: 13 }}>Oso Viejo, Sin.</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={{ backgroundColor: COLORS.verdeSuave, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.verdeClaro }} onPress={() => {
                    setCropCoordsText('22.8500, -105.8000\n22.8500, -105.7500\n22.8100, -105.7500\n22.8100, -105.8000');
                  }}>
                    <Text style={{ color: COLORS.verdeMedio, fontWeight: '600', fontSize: 13 }}>Escuinapa, Sin.</Text>
                  </TouchableOpacity>
                </View>

                {polygonCoords.length >= 3 && (
                  <TouchableOpacity
                    style={[styles.bigGreenBtn, { marginTop: 16 }]}
                    onPress={() => { setShowCropModal(false); startCropAnalysis(); }}
                  >
                    <Text style={styles.bigGreenBtnText}>🌾 INICIAR ANALISIS</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Polygon info */}
            {polygonCoords.length >= 3 && (
              <View style={styles.polygonInfoCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View>
                    <Text style={styles.polygonInfoArea}>Area: {(calcPolygonArea(polygonCoords) / 10000).toFixed(0)} ha</Text>
                    <Text style={styles.polygonInfoMeta}>Vertices: {polygonCoords.length} | {cropAreaMode === 'circle' ? 'Circulo' : cropAreaMode === 'draw' ? 'Manual' : 'Coords'}</Text>
                  </View>
                  <TouchableOpacity style={styles.savePolyBtn} onPress={saveCurrentPolygon}>
                    <Text style={styles.savePolyBtnText}>+ Guardar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Settings gear */}
            <TouchableOpacity style={styles.settingsRow} onPress={() => { setShowCropModal(false); setShowConfigModal(true); }}>
              <MaterialCommunityIcons name="cog" size={18} color="#999" />
              <Text style={styles.settingsRowText}>Ajustes</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ═══ PHOTO OPTIONS MODAL ═══ */}
      <Modal visible={showPhotoOptions} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.photoOptionsContent}>
            <Text style={styles.photoOptionsTitle}>📸 Foto de titulo parcelario</Text>
            <Text style={styles.photoOptionsSubtitle}>La IA extraera las coordenadas automaticamente</Text>

            <TouchableOpacity style={styles.photoOptionBtn} onPress={handlePhotoCameraOCR}>
              <Text style={{ fontSize: 28 }}>📷</Text>
              <View style={{ marginLeft: 16, flex: 1 }}>
                <Text style={styles.photoOptionBtnTitle}>TOMAR FOTO con la camara</Text>
                <Text style={styles.photoOptionBtnSub}>Apunta al titulo de propiedad</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.photoOptionBtn} onPress={handlePhotoOCR}>
              <Text style={{ fontSize: 28 }}>🖼️</Text>
              <View style={{ marginLeft: 16, flex: 1 }}>
                <Text style={styles.photoOptionBtnTitle}>ELEGIR FOTO de tu galeria</Text>
                <Text style={styles.photoOptionBtnSub}>Selecciona una imagen existente</Text>
              </View>
            </TouchableOpacity>

            {ocrProcessing && (
              <View style={{ alignItems: 'center', marginTop: 16 }}>
                <ActivityIndicator size="large" color={COLORS.verdeClaro} />
                <Text style={{ color: COLORS.verdeClaro, marginTop: 8, fontSize: 13 }}>Procesando con IA...</Text>
              </View>
            )}

            <TouchableOpacity style={styles.photoOptionCancel} onPress={() => setShowPhotoOptions(false)}>
              <Text style={styles.photoOptionCancelText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ═══ RESULTS PANEL ═══ */}
      {showCropResults && (
        <View style={styles.resultsPanel}>
          {/* Sticky header */}
          <View style={styles.resultsHeader}>
            <Text style={styles.resultsTitle}>🌾 Resultados</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {cropGridCells.length > 0 && (
                <TouchableOpacity
                  style={[styles.resultsHeaderBtn, showCropHeatmap && styles.resultsHeaderBtnActive]}
                  onPress={() => setShowCropHeatmap(!showCropHeatmap)}
                >
                  <MaterialCommunityIcons name="grid" size={14} color={showCropHeatmap ? COLORS.verdeClaro : '#888'} />
                  <Text style={[styles.resultsHeaderBtnText, showCropHeatmap && { color: COLORS.verdeClaro }]}>Mapa Calor</Text>
                </TouchableOpacity>
              )}
              {cropGridLoading && <ActivityIndicator size="small" color={COLORS.verdeClaro} />}
              {cropData && (
                <TouchableOpacity onPress={shareAgroCropResults} style={styles.shareBtn}>
                  <MaterialCommunityIcons name="share-variant" size={14} color="#FFF" />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setShowCropResults(false)}>
                <MaterialCommunityIcons name="close" size={24} color={COLORS.verdeMedio} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {/* Progress steps */}
            {cropAnalyzing && (
              <View style={styles.progressContainer}>
                <Text style={{ fontSize: 48, textAlign: 'center' }}>🛰️</Text>
                <Text style={styles.progressStep}>{cropStep}</Text>
                <Text style={styles.progressHint}>Esto puede tardar 30-60s</Text>
                <ActivityIndicator size="large" color={COLORS.verdeClaro} style={{ marginTop: 16 }} />
              </View>
            )}

            {/* Error */}
            {cropError ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorCardText}>{cropError}</Text>
              </View>
            ) : null}

            {/* Results */}
            {cropData && !cropAnalyzing && (
              <>
                {/* Freshness card */}
                <View style={[styles.freshnessCard, { borderColor: (cropData.frescura_dias ?? 99) <= 7 ? COLORS.verdeClaro : (cropData.frescura_dias ?? 99) <= 14 ? COLORS.amarilloMaiz : (cropData.frescura_dias ?? 99) <= 30 ? COLORS.amarilloMango : COLORS.rojo }]}>
                  <View>
                    <Text style={styles.freshnessDate}>{cropData.fecha_imagen} <Text style={styles.freshnessAgo}>(hace {cropData.frescura_dias ?? '?'}d)</Text></Text>
                    <Text style={styles.freshnessSource}>Sentinel-2 | {(cropData as any).metodo_composicion ? 'Top-3 recientes' : 'Mediana'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.freshnessConf, { color: (cropData.frescura_dias ?? 99) <= 7 ? COLORS.verdeClaro : (cropData.frescura_dias ?? 99) <= 14 ? COLORS.amarilloMaiz : COLORS.amarilloMango }]}>{(cropData as any).confianza_temporal || 'Buena'}</Text>
                    <Text style={styles.freshnessMargin}>{(cropData as any).margen_incertidumbre || '±15%'}</Text>
                  </View>
                </View>

                {/* Production card */}
                <View style={styles.productionCard}>
                  <Text style={styles.productionLabel}>TONELAJE ESTIMADO</Text>
                  <Text style={styles.productionValue}>
                    {cropData.tonelaje_estimado.toLocaleString()}
                  </Text>
                  <Text style={styles.productionUnit}>toneladas</Text>
                  <Text style={styles.productionRange}>
                    Rango: {cropData.tonelaje_minimo.toLocaleString()} - {cropData.tonelaje_maximo.toLocaleString()} ton
                  </Text>
                  {cropData.tipo_cultivo_label && <Text style={styles.productionType}>{cropData.tipo_cultivo_label}</Text>}
                </View>

                {/* Mango-specific metrics */}
                {cropData.mango && (
                  <View style={styles.mangoCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={styles.mangoMetric}>Arboles: ~{cropData.mango.arboles_estimados.toLocaleString()}</Text>
                      <Text style={styles.mangoMetric}>~{cropData.mango.frutos_por_arbol} frutos/arbol</Text>
                    </View>
                    <Text style={styles.mangoValue}>Valor cosecha: ${(cropData.mango.valor_cosecha_mxn / 1e6).toFixed(1)}M MXN</Text>
                  </View>
                )}

                {/* Harvest projection */}
                {(cropData as any).proyeccion && (
                  <View style={[styles.projectionCard, { borderColor: (cropData as any).proyeccion.confianza === 'Alta' ? COLORS.verdeClaro : (cropData as any).proyeccion.confianza === 'Media' ? COLORS.amarilloMaiz : COLORS.amarilloMango }]}>
                    <Text style={styles.projectionLabel}>PROYECCION DE COSECHA</Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={styles.projectionDate}>Cosecha: <Text style={{ fontWeight: '700' }}>{(cropData as any).proyeccion.fecha_cosecha}</Text></Text>
                      <Text style={styles.projectionDays}>({(cropData as any).proyeccion.dias_a_cosecha}d)</Text>
                    </View>
                    <Text style={styles.projectionTonHa}>{(cropData as any).proyeccion.ton_ha} ton/ha</Text>
                    <Text style={styles.projectionInc}>+{(cropData as any).proyeccion.incremento_pct}% vs actual | {(cropData as any).proyeccion.tonelaje_proyectado.toLocaleString()} ton total</Text>
                    <Text style={styles.projectionRange}>Rango: {(cropData as any).proyeccion.rango_min.toLocaleString()} - {(cropData as any).proyeccion.rango_max.toLocaleString()} | {(cropData as any).proyeccion.confianza}</Text>
                  </View>
                )}

                {/* Key metrics */}
                <View style={styles.metricsRow}>
                  {[
                    { label: 'Hectareas', value: `${cropData.hectareas_cultivo_activo.toLocaleString()}`, color: COLORS.verdeClaro },
                    { label: 'Vigor', value: cropData.clasificacion_vigor, color: cropData.clasificacion_vigor === 'Alto' ? COLORS.verdeClaro : cropData.clasificacion_vigor === 'Medio' ? COLORS.amarilloMaiz : COLORS.rojo },
                    { label: 'Optima', value: `${cropData.porcentaje_area_optima}%`, color: COLORS.verdeClaro },
                  ].map((m, i) => (
                    <View key={i} style={styles.metricCard}>
                      <Text style={styles.metricLabel}>{m.label}</Text>
                      <Text style={[styles.metricValue, { color: m.color }]}>{m.value}</Text>
                    </View>
                  ))}
                </View>

                {/* Rendimiento */}
                <TouchableOpacity
                  style={styles.rendimientoCard}
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
                      <Text style={styles.rendimientoLabel}>Rendimiento/ha <Text style={{ color: COLORS.amarilloMaiz }}>ⓘ</Text></Text>
                      <Text style={styles.rendimientoValue}>{cropData.rendimiento_por_hectarea} ton/ha</Text>
                    </View>
                    <Text style={styles.rendimientoFactors}>NDVI×{cropData.factor_ndvi} NDRE×{cropData.factor_ndre}{'\n'}Etapa×{(cropData as any).factor_etapa ?? '?'}</Text>
                  </View>
                </TouchableOpacity>

                {/* Vegetation indices */}
                <View style={styles.indicesCard}>
                  <Text style={styles.indicesTitle}>INDICES VEGETATIVOS</Text>
                  {[
                    { label: 'Vigor (NDVI)', value: cropData.ndvi_mean, max: 1, color: COLORS.verdeClaro },
                    { label: 'Biomasa (EVI)', value: cropData.evi_mean, max: 0.8, color: '#8BC34A' },
                    { label: 'Nitrogeno (NDRE)', value: cropData.ndre_mean, max: 0.6, color: COLORS.amarilloMaiz },
                    { label: 'Humedad (LSWI)', value: cropData.lswi_mean, max: 0.5, color: '#03A9F4' },
                  ].map((idx, i) => (
                    <View key={i} style={{ marginBottom: 10 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                        <Text style={styles.indexLabel}>{idx.label}</Text>
                        <Text style={[styles.indexValue, { color: idx.color }]}>{idx.value.toFixed(4)}</Text>
                      </View>
                      <View style={styles.indexBarBg}>
                        <View style={[styles.indexBarFill, { width: `${Math.min(100, (Math.max(0, idx.value) / idx.max) * 100)}%`, backgroundColor: idx.color }]} />
                      </View>
                    </View>
                  ))}
                </View>

                {/* Satellite sources (collapsible) */}
                {cropData.fuentes_satelitales && (
                  <TouchableOpacity
                    style={styles.satSourcesCard}
                    onPress={() => setShowSatSources(!showSatSources)}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={styles.satSourcesTitle}>FUENTES SATELITALES {cropExtended ? '(5)' : '(2)'} {cropExtendedLoading ? '⏳' : ''}</Text>
                      <MaterialCommunityIcons name={showSatSources ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.verdeClaro} />
                    </View>
                    {showSatSources && (
                      <View style={{ marginTop: 8 }}>
                        <Text style={styles.satSourceLine}>🛰️ Sentinel-2: {cropData.fuentes_satelitales.sentinel2?.fecha} ({cropData.fuentes_satelitales.sentinel2?.imagenes} imgs)</Text>
                        <Text style={styles.satSourceLine}>🛰️ Landsat 8/9: {cropData.fuentes_satelitales.landsat89?.fecha} ({cropData.fuentes_satelitales.landsat89?.imagenes} imgs)</Text>
                        {cropExtended ? (
                          <>
                            <Text style={styles.satSourceLine}>📡 Sentinel-1 SAR: {cropExtended.sentinel1?.fecha} ({cropExtended.sentinel1?.imagenes} imgs) | RVI: {cropExtended.sentinel1?.rvi}</Text>
                            <Text style={styles.satSourceLine}>🌍 MODIS: {cropExtended.modis?.fecha} ({cropExtended.modis?.imagenes} imgs) | NDVI: {cropExtended.modis?.ndvi}</Text>
                            <Text style={styles.satSourceLine}>💧 SMAP: {cropExtended.smap?.fecha} | Humedad: {cropExtended.smap?.humedad_suelo_pct}%</Text>
                          </>
                        ) : cropExtendedLoading ? (
                          <Text style={styles.satSourceLineLoading}>📡 Cargando SAR + MODIS + SMAP...</Text>
                        ) : null}
                      </View>
                    )}
                  </TouchableOpacity>
                )}

                {/* Claude analysis (collapsible) */}
                {cropClaudeAnalysis ? (
                  <TouchableOpacity style={styles.claudeCard} onPress={() => setShowClaudeAnalysis(!showClaudeAnalysis)}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={styles.claudeTitle}>ANALISIS AGRONOMICO IA</Text>
                      <MaterialCommunityIcons name={showClaudeAnalysis ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.verdeClaro} />
                    </View>
                    {showClaudeAnalysis && (
                      <Text style={styles.claudeText}>{cropClaudeAnalysis}</Text>
                    )}
                  </TouchableOpacity>
                ) : cropAnalyzing ? null : (
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <ActivityIndicator size="small" color={COLORS.verdeClaro} />
                    <Text style={{ color: '#999', fontSize: 12, marginTop: 5 }}>Cargando analisis IA...</Text>
                  </View>
                )}

                {/* Grid precision info */}
                {cropGridCells.length > 0 && (
                  <View style={{ backgroundColor: '#F5F5F5', borderRadius: 10, padding: 10, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 16 }}>{cropCellSizeM <= 30 ? '🎯' : '🗺️'}</Text>
                    <View>
                      <Text style={{ color: '#333', fontSize: 12, fontWeight: '600' }}>
                        {cropCellSizeM}m x {cropCellSizeM}m — {cropCellSizeM <= 30 ? 'Alta precision' : cropCellSizeM <= 100 ? 'Precision media' : 'Vista regional'}
                      </Text>
                      <Text style={{ color: '#888', fontSize: 11 }}>
                        {cropGridCells.length} zonas analizadas
                      </Text>
                    </View>
                  </View>
                )}

                {/* Action buttons at bottom */}
                <View style={styles.resultsActions}>
                  <TouchableOpacity style={styles.resultsActionShare} onPress={shareAgroCropResults}>
                    <MaterialCommunityIcons name="whatsapp" size={18} color="#FFF" />
                    <Text style={styles.resultsActionShareText}>Compartir</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.resultsActionSave} onPress={saveCurrentPolygon}>
                    <MaterialCommunityIcons name="content-save" size={18} color={COLORS.verdeMedio} />
                    <Text style={styles.resultsActionSaveText}>Guardar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.resultsActionNew} onPress={() => { setShowCropResults(false); setShowCropModal(true); }}>
                    <MaterialCommunityIcons name="plus" size={18} color={COLORS.verdeMedio} />
                    <Text style={styles.resultsActionNewText}>Nuevo</Text>
                  </TouchableOpacity>
                </View>

                <View style={{ height: 30 }} />
              </>
            )}
          </ScrollView>
        </View>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: COLORS.blanco, justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1, backgroundColor: COLORS.negroSuave },
  loadingText: { marginTop: 15, color: COLORS.verdeMedio, fontSize: 14, fontWeight: '600' },
  errorText: { color: COLORS.rojo, fontSize: 14, fontWeight: '600' },

  // Header
  header: {
    height: 60,
    backgroundColor: COLORS.verdePrimario,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 10 : 0,
  },
  headerTitle: { color: '#FFF', fontSize: 20, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerOnlineIndicator: { padding: 4 },
  onlineDot: { width: 10, height: 10, borderRadius: 5 },
  mapTypeToggle: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  mapTypeText: { color: '#FFF', fontSize: 12, fontWeight: '700' },

  // Map
  mapContainer: { flex: 1, position: 'relative' },
  map: { ...StyleSheet.absoluteFillObject },

  // User location
  userLocationDot: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: '#007AFF', borderWidth: 2, borderColor: '#FFF',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 3, elevation: 5,
  },

  // Vertex markers
  vertexMarker: {
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: 'rgba(0,230,118,0.3)',
    justifyContent: 'center', alignItems: 'center',
  },
  vertexMarkerInner: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLORS.verdeNeon,
  },

  // Crosshair
  crosshairContainer: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', zIndex: 10 },

  // Crop draw overlay
  cropDrawBanner: {
    position: 'absolute', top: 10, left: 10, right: 10, zIndex: 999,
    backgroundColor: COLORS.verdeMedio, padding: 12, borderRadius: 12, alignItems: 'center',
  },
  cropDrawBannerTitle: { color: '#FFF', fontWeight: '700', fontSize: 14 },
  cropDrawBannerSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 2 },
  cropDrawButtons: {
    position: 'absolute', bottom: 16, left: 16, right: 16, zIndex: 999, flexDirection: 'row', gap: 8,
  },
  cropDrawUndo: { flex: 1, backgroundColor: COLORS.negroSuave, padding: 14, borderRadius: 12, alignItems: 'center' },
  cropDrawUndoText: { color: '#FFF', fontWeight: '600', fontSize: 13 },
  cropDrawCancel: { flex: 1, backgroundColor: COLORS.rojo, padding: 14, borderRadius: 12, alignItems: 'center' },
  cropDrawCancelText: { color: '#FFF', fontWeight: '600', fontSize: 13 },
  cropDrawFinish: { flex: 2, backgroundColor: COLORS.verdeClaro, padding: 14, borderRadius: 12, alignItems: 'center' },
  cropDrawFinishText: { color: '#FFF', fontWeight: '700', fontSize: 14 },

  // Version tag
  versionTag: {
    position: 'absolute', top: 10, left: 10,
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, zIndex: 50,
  },
  versionTagText: { color: COLORS.verdeNeon, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  // Floating controls
  floatingControls: {
    position: 'absolute', right: 12, top: '25%', zIndex: 20, gap: 8,
  },
  floatingBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4,
  },
  northArrow: { alignItems: 'center', justifyContent: 'center' },
  northText: { color: COLORS.verdeMedio, fontSize: 8, fontWeight: '700', marginTop: -4 },

  // Field indicators
  fieldIndicators: {
    position: 'absolute', bottom: 12, left: 12, flexDirection: 'row', gap: 8, zIndex: 20,
  },
  fieldPill: {
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  fieldPillLabel: { color: '#999', fontSize: 10, fontWeight: '600' },
  fieldPillValue: { color: '#FFF', fontSize: 12, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  // Heatmap legend
  heatLegendContainer: { position: 'absolute', top: 50, right: 12, zIndex: 999, alignItems: 'flex-end' },
  heatLegendToggle: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  heatLegendBox: { backgroundColor: 'rgba(0,0,0,0.7)', padding: 8, borderRadius: 8 },
  heatLegendRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  heatLegendDot: { width: 10, height: 10, borderRadius: 2, marginRight: 6 },
  heatLegendText: { color: '#DDD', fontSize: 10 },

  // Drawing console
  drawingConsole: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 30,
    backgroundColor: COLORS.blanco, padding: 16, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 8,
  },
  drawingConsoleTitle: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '700', textAlign: 'center', marginBottom: 10 },
  drawingConsoleRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  drawingMarkBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 12, backgroundColor: COLORS.verdeMedio,
  },
  drawingMarkBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13, marginLeft: 8 },
  drawingFinishBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    height: 48, borderRadius: 12, backgroundColor: COLORS.verdeClaro,
  },
  drawingFinishBtnText: { color: '#FFF', fontWeight: '700', fontSize: 13, marginLeft: 8 },
  drawingSecBtn: {
    flex: 1, height: 40, borderRadius: 10, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#F5F5F5', borderWidth: 1, borderColor: '#DDD',
  },
  drawingSecBtnText: { color: '#666', fontSize: 11, fontWeight: '600' },

  // Info zone bar
  infoZoneBar: {
    backgroundColor: 'rgba(28,28,30,0.9)', borderTopWidth: 2, borderTopColor: COLORS.verdeNeon,
    paddingVertical: 8, paddingHorizontal: 16, alignItems: 'center',
  },
  infoZoneText: { color: '#FFF', fontSize: 13, fontWeight: '600' },

  // Bottom bar
  bottomBar: {
    height: 80, backgroundColor: '#FFF', flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 8,
  },
  bottomBtnPrimary: {
    flex: 1, height: 56, borderRadius: 16, backgroundColor: COLORS.verdeMedio,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: COLORS.verdePrimario, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
  bottomBtnPrimaryText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  bottomBtnSecondary: {
    flex: 0.7, height: 56, borderRadius: 16, backgroundColor: '#FFF',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: COLORS.verdeMedio,
  },
  bottomBtnSecondaryText: { color: COLORS.verdeMedio, fontSize: 13, fontWeight: '700' },

  // Modal overlay
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },

  // Chat modal
  chatModalContent: {
    backgroundColor: '#FFF', borderRadius: 20, padding: 20, width: '100%', height: '80%',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15, borderBottomWidth: 1, borderBottomColor: COLORS.verdeSuave, paddingBottom: 12 },
  chatHeaderTitle: { fontSize: 18, fontWeight: '700', color: COLORS.verdeMedio },
  chatScroll: { flex: 1, marginBottom: 15 },
  chatEmpty: { color: '#999', textAlign: 'center', marginTop: 30, fontSize: 14, lineHeight: 22 },
  chatBubble: { padding: 12, borderRadius: 16, maxWidth: '80%', marginBottom: 10 },
  chatBubbleUser: { alignSelf: 'flex-end', backgroundColor: COLORS.verdeSuave },
  chatBubbleAssistant: { alignSelf: 'flex-start', backgroundColor: '#F5F5F5' },
  chatBubbleText: { fontSize: 14, lineHeight: 20 },
  chatBubbleTextUser: { color: COLORS.verdePrimario },
  chatBubbleTextAssistant: { color: '#333' },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chatInput: {
    flex: 1, padding: 12, borderRadius: 12, borderWidth: 1,
    backgroundColor: '#F9F9F9', color: '#333', borderColor: '#E0E0E0', fontSize: 14,
  },
  chatSendBtn: { backgroundColor: COLORS.verdeMedio, padding: 12, borderRadius: 12 },

  // Config modal
  configModalContent: {
    width: '100%', backgroundColor: '#FFF', borderRadius: 20, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  configHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  configTitle: { color: COLORS.verdePrimario, fontSize: 22, fontWeight: '700' },
  configLabel: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '700', marginTop: 16, marginBottom: 8, letterSpacing: 0.5 },
  configInput: {
    backgroundColor: '#F5F5F5', color: '#333', borderRadius: 12, padding: 14, fontSize: 16, fontWeight: '600',
    borderWidth: 1, borderColor: '#E0E0E0',
  },
  configRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 20 },
  configRowLabel: { color: '#333', fontSize: 15, fontWeight: '600' },
  configSubtext: { color: '#999', fontSize: 11, marginTop: 4 },
  configSaveBtn: {
    backgroundColor: COLORS.verdeMedio, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 30,
  },
  configSaveBtnText: { color: '#FFF', fontWeight: '700', fontSize: 16 },

  // Parcelas modal
  parcelasModalContent: {
    width: '100%', maxHeight: '80%', backgroundColor: '#FFF', borderRadius: 20, padding: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  parcelaCard: {
    backgroundColor: '#F9F9F9', borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#E8E8E8',
  },
  parcelaColorDot: { width: 14, height: 14, borderRadius: 7 },
  parcelaName: { color: '#333', fontSize: 15, fontWeight: '600' },
  parcelaInfo: { color: '#999', fontSize: 12, marginTop: 2 },
  parcelaActionBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: COLORS.verdeMedio,
  },
  parcelaActionText: { color: COLORS.verdeMedio, fontSize: 11, fontWeight: '600' },

  // Bottom sheet
  bottomSheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  bottomSheetContent: {
    backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 20, maxHeight: '85%',
  },
  bottomSheetHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: '#DDD',
    alignSelf: 'center', marginBottom: 16,
  },
  bottomSheetTitle: { fontSize: 20, fontWeight: '700', color: COLORS.verdePrimario, marginBottom: 16 },

  // Option cards
  optionCard: {
    flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 14,
    backgroundColor: '#F9F9F9', marginBottom: 10, borderWidth: 1, borderColor: '#EEEEEE',
    minHeight: 72,
  },
  optionCardIcon: { width: 40, alignItems: 'center' },
  optionCardBody: { flex: 1, marginLeft: 12 },
  optionCardTitle: { fontSize: 14, fontWeight: '700', color: COLORS.verdeMedio },
  optionCardSubtitle: { fontSize: 12, color: '#999', marginTop: 2 },

  // Inline mode sections
  inlineModeSection: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#EEE' },
  inlineLabel: { color: '#666', fontSize: 12, fontWeight: '600', marginBottom: 10 },
  radiusChips: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  radiusChip: {
    flex: 1, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#F5F5F5', borderWidth: 1, borderColor: '#E0E0E0',
  },
  radiusChipActive: { backgroundColor: COLORS.verdeSuave, borderColor: COLORS.verdeClaro },
  radiusChipText: { fontSize: 14, fontWeight: '700', color: '#666' },
  radiusChipTextActive: { color: COLORS.verdeMedio },
  inlineAreaCalc: { color: '#999', fontSize: 12, marginBottom: 16, textAlign: 'center' },

  locationPresetBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
    backgroundColor: COLORS.verdeSuave, borderWidth: 1, borderColor: COLORS.verdeClaro,
  },
  locationPresetText: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '600' },

  bigGreenBtn: {
    backgroundColor: COLORS.verdeMedio, borderRadius: 16, padding: 18,
    alignItems: 'center', marginTop: 20,
    shadowColor: COLORS.verdePrimario, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6,
  },
  bigGreenBtnText: { color: '#FFF', fontWeight: '700', fontSize: 16 },

  coordsInput: {
    backgroundColor: '#F5F5F5', color: '#333', borderRadius: 12, padding: 14, fontSize: 13,
    borderWidth: 1, borderColor: '#E0E0E0', height: 100, textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 10,
  },
  coordsProcessBtn: {
    backgroundColor: COLORS.verdeSuave, borderRadius: 12, padding: 14, alignItems: 'center',
    borderWidth: 1, borderColor: COLORS.verdeClaro,
  },
  coordsProcessBtnText: { color: COLORS.verdeMedio, fontWeight: '700', fontSize: 13 },

  polygonInfoCard: {
    backgroundColor: COLORS.verdeSuave, borderRadius: 12, padding: 14, marginTop: 12,
    borderWidth: 1, borderColor: COLORS.verdeClaro,
  },
  polygonInfoArea: { color: COLORS.verdeMedio, fontSize: 14, fontWeight: '700' },
  polygonInfoMeta: { color: '#999', fontSize: 11, marginTop: 2 },
  savePolyBtn: { backgroundColor: COLORS.verdeMedio, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  savePolyBtnText: { color: '#FFF', fontSize: 12, fontWeight: '600' },

  settingsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: '#EEE', justifyContent: 'center',
  },
  settingsRowText: { color: '#999', fontSize: 13 },

  // Photo options modal
  photoOptionsContent: {
    width: '100%', backgroundColor: '#FFF', borderRadius: 20, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
  },
  photoOptionsTitle: { fontSize: 20, fontWeight: '700', color: COLORS.verdePrimario, marginBottom: 6 },
  photoOptionsSubtitle: { fontSize: 13, color: '#999', marginBottom: 20 },
  photoOptionBtn: {
    flexDirection: 'row', alignItems: 'center', padding: 18, borderRadius: 14,
    backgroundColor: '#F9F9F9', marginBottom: 12, borderWidth: 1, borderColor: '#EEE',
    minHeight: 72,
  },
  photoOptionBtnTitle: { fontSize: 15, fontWeight: '700', color: COLORS.verdeMedio },
  photoOptionBtnSub: { fontSize: 12, color: '#999', marginTop: 2 },
  photoOptionCancel: { marginTop: 8, padding: 14, alignItems: 'center' },
  photoOptionCancelText: { color: '#999', fontSize: 14, fontWeight: '600' },

  // Results panel
  resultsPanel: {
    position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '65%',
    backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 16, zIndex: 100,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 10,
  },
  resultsHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12, borderBottomWidth: 1, borderBottomColor: '#EEE', paddingBottom: 10,
  },
  resultsTitle: { color: COLORS.verdePrimario, fontSize: 18, fontWeight: '700' },
  resultsHeaderBtn: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#E0E0E0',
  },
  resultsHeaderBtnActive: { backgroundColor: COLORS.verdeSuave, borderColor: COLORS.verdeClaro },
  resultsHeaderBtnText: { color: '#888', fontSize: 11, fontWeight: '600', marginLeft: 4 },
  shareBtn: {
    backgroundColor: '#25D366', borderRadius: 8, padding: 8,
  },

  // Progress
  progressContainer: { alignItems: 'center', paddingVertical: 40 },
  progressStep: { color: COLORS.verdeMedio, fontSize: 14, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  progressHint: { color: '#999', fontSize: 12, marginTop: 8 },

  // Error
  errorCard: { backgroundColor: '#FFF5F5', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#FFCDD2' },
  errorCardText: { color: COLORS.rojo, fontSize: 13 },

  // Freshness
  freshnessCard: {
    backgroundColor: '#F9F9F9', borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 2, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  freshnessDate: { color: '#333', fontSize: 13, fontWeight: '600' },
  freshnessAgo: { color: '#999', fontWeight: '400' },
  freshnessSource: { color: '#999', fontSize: 11, marginTop: 2 },
  freshnessConf: { fontSize: 12, fontWeight: '700' },
  freshnessMargin: { color: '#999', fontSize: 10, marginTop: 1 },

  // Production
  productionCard: {
    backgroundColor: COLORS.verdeSuave, borderRadius: 16, padding: 20, marginBottom: 12,
    borderWidth: 2, borderColor: COLORS.verdeClaro, alignItems: 'center',
  },
  productionLabel: { color: '#666', fontSize: 11, letterSpacing: 1, fontWeight: '600' },
  productionValue: { color: COLORS.verdePrimario, fontSize: 42, fontWeight: '800', marginTop: 4 },
  productionUnit: { color: '#999', fontSize: 14, marginTop: 2 },
  productionRange: { color: '#666', fontSize: 12, marginTop: 8 },
  productionType: { color: '#999', fontSize: 11, marginTop: 4 },

  // Mango
  mangoCard: {
    backgroundColor: '#FFF8E1', borderRadius: 12, padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.amarilloMango,
  },
  mangoMetric: { color: COLORS.amarilloMango, fontSize: 12, fontWeight: '600' },
  mangoValue: { color: COLORS.amarilloMango, fontSize: 15, fontWeight: '800', marginTop: 6 },

  // Projection
  projectionCard: {
    backgroundColor: '#F9F9F9', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 2,
  },
  projectionLabel: { color: COLORS.verdeMedio, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  projectionDate: { color: '#333', fontSize: 12 },
  projectionDays: { color: '#999', fontSize: 12 },
  projectionTonHa: { color: COLORS.verdeMedio, fontSize: 22, fontWeight: '800' },
  projectionInc: { color: '#666', fontSize: 11, marginTop: 2 },
  projectionRange: { color: '#999', fontSize: 10, marginTop: 4 },

  // Metrics row
  metricsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  metricCard: {
    flex: 1, backgroundColor: '#F9F9F9', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#EEE', alignItems: 'center',
  },
  metricLabel: { color: '#999', fontSize: 10, fontWeight: '600' },
  metricValue: { fontSize: 18, fontWeight: '800', marginTop: 4 },

  // Rendimiento
  rendimientoCard: {
    backgroundColor: '#FFFDE7', borderRadius: 12, padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.amarilloMaiz,
  },
  rendimientoLabel: { color: '#666', fontSize: 10 },
  rendimientoValue: { color: COLORS.amarilloMaiz, fontSize: 24, fontWeight: '800', marginTop: 4 },
  rendimientoFactors: { color: '#999', fontSize: 10, textAlign: 'right' },

  // Indices
  indicesCard: {
    backgroundColor: '#F9F9F9', borderRadius: 12, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#EEE',
  },
  indicesTitle: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '700', marginBottom: 12, letterSpacing: 0.5 },
  indexLabel: { color: '#666', fontSize: 12 },
  indexValue: { fontSize: 12, fontWeight: '700' },
  indexBarBg: { height: 6, backgroundColor: '#E8E8E8', borderRadius: 3, overflow: 'hidden' },
  indexBarFill: { height: 6, borderRadius: 3 },

  // Satellite sources
  satSourcesCard: {
    backgroundColor: '#F9F9F9', borderRadius: 12, padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: '#EEE',
  },
  satSourcesTitle: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '700' },
  satSourceLine: { color: '#555', fontSize: 11, marginBottom: 4, lineHeight: 18 },
  satSourceLineLoading: { color: '#999', fontSize: 11, marginTop: 4 },

  // Claude analysis
  claudeCard: {
    backgroundColor: COLORS.verdeSuave, borderRadius: 14, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: COLORS.verdeClaro,
  },
  claudeTitle: { color: COLORS.verdeMedio, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  claudeText: { color: '#333', fontSize: 13, lineHeight: 22, marginTop: 10 },

  // Results actions
  resultsActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  resultsActionShare: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#25D366', borderRadius: 12, padding: 14, gap: 6,
  },
  resultsActionShareText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  resultsActionSave: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFF', borderRadius: 12, padding: 14, gap: 6,
    borderWidth: 2, borderColor: COLORS.verdeMedio,
  },
  resultsActionSaveText: { color: COLORS.verdeMedio, fontWeight: '700', fontSize: 13 },
  resultsActionNew: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFF', borderRadius: 12, padding: 14, gap: 6,
    borderWidth: 2, borderColor: COLORS.verdeMedio,
  },
  resultsActionNewText: { color: COLORS.verdeMedio, fontWeight: '700', fontSize: 13 },
});
