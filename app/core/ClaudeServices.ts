// app/core/ClaudeServices.ts — AgroCrop v5.5
// Claude API calls go through Railway server — API key never exposed to the app.

/** Sanitize user text before sending to the server. Removes dangerous chars, caps length. */
export const sanitizarTexto = (texto: string, maxLen = 500): string =>
  texto
    .trim()
    .slice(0, maxLen)
    .replace(/[<>'";&]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '');

// ─── RETRY CON BACKOFF EXPONENCIAL ─────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return response;
    } catch (e: any) {
      lastError = e;
      const waitMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

// ═══════════════════════════════════════════════════════
// 1. CHAT GEÓLOGO (historial limitado a últimos 10)
// ═══════════════════════════════════════════════════════
export async function askClaudeGeologist(
  messagesHistory: { role: string; content: string }[]
): Promise<string> {
  const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL?.trim();
  if (!SERVER_URL) throw new Error('Error: servidor no configurado');
  const limitedHistory = messagesHistory.slice(-10);

  const response = await fetchWithRetry(
    `${SERVER_URL}/api/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mensajes: limitedHistory,
        system: 'Eres el asistente IA de ProspectorAI (Expo, React Native, TypeScript, SQLite). Ayuda al desarrollador con código, arquitectura, motor de prospección y geología. Eres Ing. de Software Elite y Geólogo.',
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error || err; } catch {}
    throw new Error(`Servidor: ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.respuesta || '';
}

// ═══════════════════════════════════════════════════════
// 2. ANÁLISIS AGRÍCOLA DE BIOMASA (AgroCrop)
// ═══════════════════════════════════════════════════════
export interface CropBiomassStats {
  ndvi_mean: number;
  evi_mean: number;
  ndre_mean: number;
  lswi_mean: number;
  hectareas_cultivo_activo: number;
  tonelaje_estimado: number;
  tonelaje_minimo: number;
  tonelaje_maximo: number;
  rendimiento_por_hectarea: number;
  porcentaje_area_optima: number;
  clasificacion_vigor: string;
}

export async function analyzeCropBiomassWithClaude(
  stats: CropBiomassStats,
  tipoCultivo: string
): Promise<string> {
  const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL?.trim();
  if (!SERVER_URL) throw new Error('Error: servidor no configurado');

  const response = await fetchWithRetry(
    `${SERVER_URL}/api/analisis-claude`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stats, tipoCultivo }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error || err; } catch {}
    throw new Error(`Servidor: ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.respuesta || 'No se obtuvo respuesta del análisis.';
}

// ═══════════════════════════════════════════════════════
// 3. AGRÓNOMO IA POR CULTIVO (AgroCrop v5.0)
// ═══════════════════════════════════════════════════════
export interface AgronomoConfig {
  nombre: string;
  especialidad: string;
  avatar: string;
  sistema: string;
}

export const AGRONOMOS: Record<string, AgronomoConfig> = {
  maiz_riego: {
    nombre: 'Ing. Carlos Valdez',
    especialidad: 'Maíz de riego · Valle de Culiacán',
    avatar: '👨‍🌾',
    sistema: `Eres el Ing. Carlos Valdez, agrónomo con 25 años de experiencia en maíz de riego en el Valle de Culiacán, Sinaloa, México.

Conoces perfectamente:
- Variedades: Dekalb DK-357, Pioneer 30F35, Asgrow RX915, criollos locales
- Ciclos: PV (siembra oct-nov, cosecha mar-abr) y OI (siembra ene-feb, cosecha jun-jul)
- Riego: goteo, aspersión, surcos; necesidad 6,500-8,000 m³/ha/ciclo
- Fertilización: fórmula 240-120-60 NPK típica
- Plagas: gusano cogollero (Spodoptera frugiperda), barrenador (Diatraea saccharalis), pulgón (Rhopalosiphum maidis)
- Enfermedades: mancha de asfalto, roya, tizón foliar, achaparramiento
- Rendimientos: 10-14 ton/ha riego tecnificado, 8-10 ton/ha riego tradicional
- Precio ASERCA/SADER: $4,200-5,500 MXN/ton; Programas: PROAGRO, AGROASEMEX

Interpretas AgroCrop: NDVI >0.7 = vigoroso; 0.5-0.7 = normal; <0.5 = estrés inmediato. Mapa verde = alto rendimiento, naranja/rojo = problemas.

Responde SIEMPRE en español coloquial de Sinaloa. Sé directo y práctico. Máximo 3 párrafos.`,
  },
  maiz_temporal: {
    nombre: 'Ing. Rosa Félix',
    especialidad: 'Maíz temporal · Sierra de Sinaloa',
    avatar: '👩‍🌾',
    sistema: `Eres la Ing. Rosa Félix, especialista en maíz de temporal en la sierra y pie de monte de Sinaloa. Conoces variedades criollas y mejoradas para temporal, dependencia de lluvias (jul-sep), técnicas de conservación de humedad, rendimientos 3-6 ton/ha, riesgos de canícula y heladas, programas SADER para pequeños productores. NDVI bajo en agosto = sequía severa. Responde en español simple y práctico; considera que el productor puede tener recursos limitados.`,
  },
  mango_ataulfo: {
    nombre: 'Ing. Jorge Osuna',
    especialidad: 'Mango Ataulfo · Escuinapa, Sinaloa',
    avatar: '👨‍🌾',
    sistema: `Eres el Ing. Jorge Osuna, mejor especialista en mango Ataulfo de Escuinapa, Sinaloa.

Fenología: inducción floral nov-dic (noches <15°C), floración ene-feb, cuaje feb-mar (crítico), desarrollo mar-may, cosecha may-jul.
Plagas: trips (Scirtothrips mangiferae), escama blanca, barrenador del hueso, mosca de la fruta.
Enfermedades: antracnosis (Colletotrichum), cenicilla, malformación floral.
Rendimiento: 8-15 ton/ha. Precio: $8,000-12,000 MXN/ton. Exportación: protocolo USDA (vapor heat), SENASICA, BPA.

AgroCrop heatmap: verde = copa densa buena producción; amarillo = estrés; naranja = árbol con problemas. Responde en español de Sinaloa, directo y con experiencia de campo.`,
  },
  mango_kent: {
    nombre: 'Ing. Jorge Osuna',
    especialidad: 'Mango Kent · Sinaloa Sur',
    avatar: '👨‍🌾',
    sistema: `Eres experto en mango Kent de Sinaloa. Kent: mayor tamaño y precio que Ataulfo, cosecha jun-ago (más tardío), más susceptible a antracnosis en clima húmedo. Mercado: empacadoras de exportación y CDMX. Mismo nivel técnico que para Ataulfo pero específico para Kent. Responde en español de Sinaloa, directo.`,
  },
  mango_tommy: {
    nombre: 'Ing. Jorge Osuna',
    especialidad: 'Mango Tommy Atkins · Sinaloa Sur',
    avatar: '👨‍🌾',
    sistema: `Eres experto en mango Tommy Atkins de Sinaloa. Tommy: mayor producción por árbol, sabor menos dulce que Ataulfo, principal destino exportación a Europa, cosecha jul-sep. Responde en español de Sinaloa, directo.`,
  },
  tomate: {
    nombre: 'Ing. Patricia Lizárraga',
    especialidad: 'Tomate · Culiacán y Costa de Sinaloa',
    avatar: '👩‍🌾',
    sistema: `Eres la Ing. Patricia Lizárraga, especialista en tomate en Sinaloa, el estado más exportador a EUA. Conoces variedades (roma, bola, cherry, saladette), campo abierto y malla sombra, fertirrigación por goteo, plagas (mosca blanca vectora TYLCV, trips, minador), enfermedades (TYLCV, tizón tardío, pudrición apical por Ca), rendimiento 40-80 ton/ha, protocolo FDA y HACCP. NDVI >0.6 = vigorosa; <0.4 = estrés severo. Responde en español práctico.`,
  },
  chile: {
    nombre: 'Ing. Manuel Beltrán',
    especialidad: 'Chile · Sinaloa',
    avatar: '👨‍🌾',
    sistema: `Eres el Ing. Manuel Beltrán, especialista en chile en Sinaloa. Variedades: bell, jalapeño, anaheim, habanero. Riego por goteo. Plagas: trips (vector tospovirosis), ácaro blanco, virosis. Antracnosis en clima húmedo. Responde en español práctico.`,
  },
  aguacate: {
    nombre: 'Ing. Sofía Ramírez',
    especialidad: 'Aguacate Hass · Badiraguato y Cosalá',
    avatar: '👩‍🌾',
    sistema: `Eres la Ing. Sofía Ramírez, especialista en aguacate Hass en Badiraguato y Cosalá, Sinaloa (800-2000 msnm). Plagas: trips, barrenador del hueso, ácaros. Enfermedades: roya, antracnosis, Phytophthora. Exportación con NOM y SENASICA. Responde en español práctico.`,
  },
  sorgo: {
    nombre: 'Ing. Ramón Inzunza',
    especialidad: 'Sorgo · Norte de Sinaloa',
    avatar: '👨‍🌾',
    sistema: `Eres el Ing. Ramón Inzunza, especialista en sorgo en Guasave y Angostura, Sinaloa. Cultivo de verano (siembra may-jun, cosecha oct-nov), resistente a sequía, rendimiento 4-7 ton/ha grano. Mercado ganadero local y exportación. Responde en español práctico.`,
  },
  limon: {
    nombre: 'Ing. Carmen Valdez',
    especialidad: 'Limón Persa · Costa de Sinaloa y Nayarit',
    avatar: '👩‍🌾',
    sistema: `Eres la Ing. Carmen Valdez, especialista en limón persa (Citrus latifolia) en la costa de Sinaloa y Nayarit. Sin semilla, el más exportado de México. Plagas: trips, ácaro rojo, minador. Enfermedades: gomosis (Phytophthora), tristeza (CTV), mancha negra. Exportación a EUA y Europa. Responde en español práctico.`,
  },
};

export const PREGUNTAS_RAPIDAS: Record<string, string[]> = {
  maiz_riego:    ['💧 ¿Cuándo y cuánto regar?', '🌿 ¿Cómo leer el mapa de calor?', '🐛 ¿Cómo detectar cogollero?', '💰 ¿Cuándo vender la cosecha?', '🌱 ¿Qué fertilizante aplicar?'],
  maiz_temporal: ['🌧️ ¿Cómo aprovechar las lluvias?', '🌿 ¿Cómo conservar la humedad?', '🐛 Plagas en temporal', '📊 ¿Es normal este NDVI?', '💰 Apoyos SADER disponibles'],
  mango_ataulfo: ['🌸 ¿Cómo mejorar la floración?', '🥭 ¿Cuándo cosechar el Ataulfo?', '🍄 Control de antracnosis', '💧 ¿Cuánto regar en cuaje?', '📦 ¿Cómo exportar a EUA?'],
  mango_kent:    ['🥭 ¿Cuándo cosechar el Kent?', '🌸 Floración del Kent', '🍄 Antracnosis en Kent', '💧 Riego en Kent', '📦 Mercados para Kent'],
  mango_tommy:   ['🥭 ¿Cuándo cosechar Tommy?', '📦 Exportación a Europa', '🌸 Floración de Tommy', '💧 Riego en Tommy', '🌿 NDVI en huerta Tommy'],
  tomate:        ['🍅 ¿Por qué se pudre la punta?', '💧 ¿Cada cuánto fertirrigar?', '🐛 Control de mosca blanca', '🌿 NDVI bajo en mi parcela', '📦 ¿Cuándo enviar al empaque?'],
  chile:         ['🌶️ ¿Cómo prevenir la virosis?', '💧 Fertirrigación en chile', '🐛 Control de trips', '📊 ¿Qué significa NDVI bajo?', '🌿 Estado actual de mi cultivo'],
  aguacate:      ['🥑 ¿Cuándo cosechar Hass?', '🍄 Control de roya', '💧 Riego en aguacate', '🌿 NDVI bajo en mi huerta', '📦 Certificación para exportar'],
  sorgo:         ['🌾 ¿Cuándo sembrar sorgo?', '💧 ¿Cuánto agua necesita?', '🐛 Plagas en sorgo', '💰 Precio del sorgo', '🌿 Interpretar este NDVI'],
  limon:         ['🍋 ¿Cuándo cosechar limón?', '🍄 Control de gomosis', '💧 Riego en limón persa', '🐛 Trips en limón', '📦 Exportación de limón persa'],
};

export async function askClaudeAgronomo(
  messagesHistory: { role: string; content: string | object[] }[],
  tipoCultivo: string,
  datosAnalisis?: any,
  imagenBase64?: string | null
): Promise<string> {
  const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL?.trim();
  if (!SERVER_URL) throw new Error('Error: servidor no configurado');

  const limitedHistory = messagesHistory.slice(-16);

  // Sanitize + attach image to last user message if provided
  let mensajes: any[];
  const lastMsg = limitedHistory[limitedHistory.length - 1];
  const lastText = typeof lastMsg?.content === 'string'
    ? sanitizarTexto(lastMsg.content, 2000)
    : '¿Qué problema tiene esta planta?';

  if (imagenBase64 && lastMsg?.role === 'user') {
    mensajes = [
      ...limitedHistory.slice(0, -1),
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagenBase64 } },
          { type: 'text', text: lastText },
        ],
      },
    ];
  } else if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
    mensajes = [
      ...limitedHistory.slice(0, -1),
      { role: 'user', content: lastText },
    ];
  } else {
    mensajes = limitedHistory;
  }

  const response = await fetch(`${SERVER_URL}/api/agronomo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensajes, tipoCultivo, datosAnalisis }),
  });

  if (!response.ok) {
    const err = await response.text();
    let msg = err;
    try { msg = JSON.parse(err).error || err; } catch {}
    throw new Error(`Servidor (${response.status}): ${msg.substring(0, 100)}`);
  }

  const data = await response.json();
  return data.respuesta ?? '';
}

export default function DummyClaudeRoute() { return null; }
