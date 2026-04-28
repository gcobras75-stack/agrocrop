import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ActivityIndicator, Platform, TouchableOpacity, Alert, Modal, TextInput, ScrollView, Switch, Share, Animated, Dimensions } from 'react-native';
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

  // NEW: Photo options state
  const [showPhotoOptions, setShowPhotoOptions] = useState(false);

  // NEW: Saved parcels modal
  const [showParcelasModal, setShowParcelasModal] = useState(false);

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

🤖 _Generado con AgroCrop v2.0_
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
    infoText = `${resolvedPolygonCoords.length} pts`;
  }

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
          onRegionChange={(region: any) => { if (region.heading !== undefined) { setMapRotation(region.heading); } setCurrentZoom(region.latitudeDelta); }}
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

          {/* Vertex markers */}
          {resolvedPolygonCoords.map((coord, i) => (
            <Marker key={`p-${i}`} coordinate={coord} anchor={{ x: 0.5, y: 0.5 }}>
              <View style={styles.vertexMarker}>
                <View style={styles.vertexMarkerInner} />
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

        {/* CROSSHAIR for drawing mode */}
        {drawingType === 'polygon' && (
          <View style={styles.crosshairContainer} pointerEvents="none">
            <MaterialCommunityIcons name="crosshairs" size={50} color={COLORS.verdeNeon} />
          </View>
        )}

        {/* CROP DRAW MODE OVERLAY */}
        {cropDrawing && (
          <>
            <View style={styles.cropDrawBanner}>
              <Text style={styles.cropDrawBannerTitle}>TRAZANDO POLIGONO</Text>
              <Text style={styles.cropDrawBannerSubtitle}>Toca "Marcar Punto" para agregar vertices ({polygonCoords.length} vertices)</Text>
            </View>
            <View style={styles.cropDrawButtons}>
              {polygonCoords.length > 0 && (
                <TouchableOpacity style={styles.cropDrawUndo} onPress={() => setPolygonCoords(polygonCoords.slice(0, -1))}>
                  <Text style={styles.cropDrawUndoText}>Deshacer</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.cropDrawCancel} onPress={() => { setCropDrawing(false); selectMode('none'); setPolygonCoords([]); }}>
                <Text style={styles.cropDrawCancelText}>Cancelar</Text>
              </TouchableOpacity>
              {polygonCoords.length >= 3 && (
                <TouchableOpacity style={styles.cropDrawFinish} onPress={finishCropDraw}>
                  <Text style={styles.cropDrawFinishText}>FINALIZAR ({polygonCoords.length}v)</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        {/* VERSION TAG */}
        <View style={styles.versionTag}>
          <Text style={styles.versionTagText}>AgroCrop v2.0</Text>
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

        {/* Drawing mode bottom console */}
        {drawingType === 'polygon' && !cropDrawing && (
          <View style={styles.drawingConsole}>
            <Text style={styles.drawingConsoleTitle}>TRAZANDO ({polygonCoords.length} VERTICES)</Text>
            <View style={styles.drawingConsoleRow}>
              <TouchableOpacity style={styles.drawingMarkBtn} onPress={addPointFromCrosshair}>
                <MaterialCommunityIcons name="target" size={18} color="#FFF" />
                <Text style={styles.drawingMarkBtnText}>MARCAR ({polygonCoords.length})</Text>
              </TouchableOpacity>
              {polygonCoords.length >= 3 && (
                <TouchableOpacity style={styles.drawingFinishBtn} onPress={() => finishDrawing()}>
                  <MaterialCommunityIcons name="check" size={18} color="#FFF" />
                  <Text style={styles.drawingFinishBtnText}>FINALIZAR</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.drawingConsoleRow}>
              <TouchableOpacity style={styles.drawingSecBtn} onPress={() => setPolygonCoords([])}>
                <Text style={styles.drawingSecBtnText}>LIMPIAR</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.drawingSecBtn} onPress={() => selectMode('none')}>
                <Text style={styles.drawingSecBtnText}>SALIR</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
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
          style={styles.bottomBtnPrimary}
          onPress={() => setShowCropModal(true)}
        >
          <Text style={styles.bottomBtnPrimaryText}>🌾 ANALIZAR mis cultivos</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.bottomBtnSecondary}
          onPress={() => setShowParcelasModal(true)}
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
              {chatMessages.map((msg, idx) => (
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
              {cropPolygons.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#999', fontSize: 14 }}>No tienes parcelas guardadas</Text>
                  <Text style={{ color: '#666', fontSize: 12, marginTop: 8 }}>Analiza un area para guardar tu primera parcela</Text>
                </View>
              ) : (
                cropPolygons.map((p, i) => (
                  <View key={p.id} style={styles.parcelaCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={[styles.parcelaColorDot, { backgroundColor: p.color }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.parcelaName}>{p.nombre}</Text>
                        <Text style={styles.parcelaInfo}>{p.hectareas} ha - {p.origen}</Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={styles.parcelaActionBtn} onPress={() => {
                        setPolygonCoords(p.coords);
                        setCropAreaMode(p.origen === 'manual' ? 'draw' : 'coords');
                        const lats = p.coords.map(c => c.latitude);
                        const lngs = p.coords.map(c => c.longitude);
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
                      <TouchableOpacity style={styles.parcelaActionBtn} onPress={() => {
                        setPolygonCoords(p.coords);
                        setCropAreaMode(p.origen === 'manual' ? 'draw' : 'coords');
                        setShowParcelasModal(false);
                        startCropAnalysis();
                      }}>
                        <Text style={styles.parcelaActionText}>Analizar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.parcelaActionBtn, { borderColor: COLORS.rojo }]} onPress={() => setCropPolygons(prev => prev.filter(x => x.id !== p.id))}>
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

      {/* ═══ ANALIZAR BOTTOM SHEET MODAL ═══ */}
      <Modal visible={showCropModal} transparent animationType="slide">
        <View style={styles.bottomSheetOverlay}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setShowCropModal(false)} />
          <View style={styles.bottomSheetContent}>
            <View style={styles.bottomSheetHandle} />
            <Text style={styles.bottomSheetTitle}>🌾 ¿Donde estan tus cultivos?</Text>

            {/* Option Cards */}
            <TouchableOpacity style={styles.optionCard} onPress={() => { setCropAreaMode('circle'); }}>
              <View style={styles.optionCardIcon}>
                <Text style={{ fontSize: 24 }}>🟡</Text>
              </View>
              <View style={styles.optionCardBody}>
                <Text style={styles.optionCardTitle}>AREA CIRCULAR</Text>
                <Text style={styles.optionCardSubtitle}>Dibuja un circulo alrededor de tu zona</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={24} color="#999" />
            </TouchableOpacity>

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

            {/* Inline content based on mode */}
            {cropAreaMode === 'circle' && (
              <View style={styles.inlineModeSection}>
                <Text style={styles.inlineLabel}>Radio del area (km)</Text>
                <View style={styles.radiusChips}>
                  {[10, 20, 40, 60, 80].map(r => (
                    <TouchableOpacity key={r} style={[styles.radiusChip, cropRadioKm === r && styles.radiusChipActive]} onPress={() => setCropRadioKm(r)}>
                      <Text style={[styles.radiusChipText, cropRadioKm === r && styles.radiusChipTextActive]}>{r} km</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.inlineAreaCalc}>Area: ~{Math.round(Math.PI * cropRadioKm * cropRadioKm).toLocaleString()} km²</Text>

                <Text style={styles.inlineLabel}>Ubicaciones predefinidas</Text>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <TouchableOpacity style={styles.locationPresetBtn} onPress={() => loadOsoViejoPolygon(cropRadioKm)}>
                    <Text style={styles.locationPresetText}>Oso Viejo (Maiz)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.locationPresetBtn} onPress={() => {
                    const circle = generateCirclePolygon(22.8317, -105.7791, 10, 32);
                    setPolygonCoords(circle.map(([lng, lat]) => ({ latitude: lat, longitude: lng })));
                    setCropTipoCultivo('mango_ataulfo');
                    setCropAreaMode('circle');
                    mapRef.current?.animateToRegion({ latitude: 22.8317, longitude: -105.7791, latitudeDelta: 0.3, longitudeDelta: 0.3 }, 800);
                    triggerHaptic('light');
                  }}>
                    <Text style={styles.locationPresetText}>Escuinapa (Mango)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.locationPresetBtn} onPress={() => {
                    const circle = generateCirclePolygon(22.9939, -105.8533, 15, 32);
                    setPolygonCoords(circle.map(([lng, lat]) => ({ latitude: lat, longitude: lng })));
                    setCropTipoCultivo('mango_ataulfo');
                    setCropAreaMode('circle');
                    mapRef.current?.animateToRegion({ latitude: 22.9939, longitude: -105.8533, latitudeDelta: 0.4, longitudeDelta: 0.4 }, 800);
                    triggerHaptic('light');
                  }}>
                    <Text style={styles.locationPresetText}>Rosario (Mango)</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.bigGreenBtn}
                  onPress={() => { setShowCropModal(false); startCropAnalysis(); }}
                >
                  <Text style={styles.bigGreenBtnText}>🌾 INICIAR ANALISIS</Text>
                </TouchableOpacity>
              </View>
            )}

            {cropAreaMode === 'coords' && (
              <View style={styles.inlineModeSection}>
                <TextInput
                  style={styles.coordsInput}
                  multiline
                  placeholder={'24.3994, -107.1714\n24.4100, -107.1500\n24.3800, -107.1200'}
                  placeholderTextColor="#999"
                  value={cropCoordsText}
                  onChangeText={setCropCoordsText}
                />
                <TouchableOpacity style={styles.coordsProcessBtn} onPress={applyCoordsFromText}>
                  <Text style={styles.coordsProcessBtnText}>PROCESAR COORDENADAS</Text>
                </TouchableOpacity>
                {polygonCoords.length >= 3 && (
                  <TouchableOpacity
                    style={styles.bigGreenBtn}
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
  mapContainer: { flex: 0.60, position: 'relative' },
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
