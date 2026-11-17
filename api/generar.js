// Función del servidor (Vercel). Recibe los apuntes y devuelve el material de estudio.
// Variables de entorno en Vercel:
//   GEMINI_API_KEY  (obligatoria) clave de Google AI Studio
//   GEMINI_MODEL    (opcional) por defecto gemini-3.5-flash
//   ACCESS_CODES    (opcional) códigos separados por comas, ej: "ALEX-001,ALEX-002".
//                   Si la dejas vacía, la app es libre para todos.
//
// Dos modos:
//   modo "estudio" → temas, resumen por tema, flashcards, trampas y plan de estudio
//   modo "quiz"    → preguntas de opción múltiple (por defecto, igual que la versión 1)

const MAX_QUESTIONS = 20;
const TIPOS_ARCHIVO = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// Esquemas que obligan a Gemini a responder siempre con la misma forma
const S = (type, extra = {}) => ({ type, ...extra });
const ESQUEMA_ESTUDIO = S("OBJECT", {
  properties: {
    titulo: S("STRING"),
    temas: S("ARRAY", { items: S("OBJECT", { properties: { id: S("STRING"), nombre: S("STRING") }, required: ["id", "nombre"] }) }),
    resumen: S("ARRAY", { items: S("OBJECT", { properties: { tema: S("STRING"), titulo: S("STRING"), puntos: S("ARRAY", { items: S("STRING") }) }, required: ["tema", "titulo", "puntos"] }) }),
    flashcards: S("ARRAY", { items: S("OBJECT", { properties: { tema: S("STRING"), frente: S("STRING"), reverso: S("STRING") }, required: ["tema", "frente", "reverso"] }) }),
    trampas: S("ARRAY", { items: S("OBJECT", { properties: { tema: S("STRING"), confusion: S("STRING"), clave: S("STRING") }, required: ["tema", "confusion", "clave"] }) }),
    plan: S("ARRAY", { items: S("OBJECT", { properties: { tarea: S("STRING"), minutos: S("INTEGER") }, required: ["tarea", "minutos"] }) })
  },
  required: ["titulo", "temas", "resumen", "flashcards", "trampas", "plan"]
});
const ESQUEMA_QUIZ = S("ARRAY", {
  items: S("OBJECT", {
    properties: { tema: S("STRING"), pregunta: S("STRING"), opciones: S("ARRAY", { items: S("STRING") }), correcta: S("INTEGER"), explicacion: S("STRING") },
    required: ["tema", "pregunta", "opciones", "correcta", "explicacion"]
  })
});

function promptEstudio() {
  return `Eres profesor de medicina y preparas material de repaso para estudiantes de medicina de Latinoamérica, en español.
Con base SOLO en los apuntes del estudiante (texto y/o archivo adjunto), arma un paquete de estudio:
- "titulo": nombre corto de la materia o tema general (máx. 5 palabras).
- "temas": de 3 a 10 subtemas, con id corto (t1, t2, …) y nombre corto.
- "resumen": un bloque por tema, en el mismo orden. "tema" es el id. Cada bloque con 4 a 12 puntos claros y densos, como apuntes de repaso para examen: definición, clínica, diagnóstico, tratamiento, datos y cifras clave. Resalta lo más preguntable con **negritas**.
- "flashcards": de 25 a 50 tarjetas repartidas entre los temas. Frente = pregunta corta o concepto; reverso = respuesta breve y precisa.
- "trampas": de 5 a 12 confusiones típicas de examen ("X vs Y", errores frecuentes) con la clave para no caer.
- "plan": de 4 a 7 pasos para estudiar hoy este material, con minutos estimados.
No inventes datos que contradigan los apuntes. Si algo importante no está en los apuntes, no lo agregues. Si los apuntes no son de medicina, igual arma el paquete sobre su contenido.`;
}

function promptQuiz({ cantidad, tipo, nivel, temas }) {
  const estilo = tipo === "caso" ? "todas como viñetas de caso clínico breves"
    : tipo === "directa" ? "preguntas directas de concepto"
    : "mezcla de casos clínicos breves y preguntas directas";
  const listaTemas = temas.length
    ? `\nUsa SOLO estos temas y pon en "tema" el id que corresponda: ${temas.map(t => `${t.id} = ${t.nombre}`).join("; ")}. Reparte las preguntas entre todos.`
    : `\nEn "tema" pon un subtema corto.`;
  return `Eres profesor de medicina y escribes preguntas de examen para estudiantes de medicina de Latinoamérica, en español.
Con base SOLO en los apuntes del estudiante (texto y/o archivo adjunto), crea ${cantidad} preguntas de opción múltiple, ${estilo}, dificultad ${nivel}.
Reglas: 4 opciones por pregunta, una sola correcta (índice 0 a 3 en "correcta"), distractores plausibles, varía la posición de la respuesta correcta, explicación breve (1-2 oraciones) que diga por qué la correcta lo es. No contradigas los apuntes. No repitas preguntas de la lista "YA HECHAS" si viene.${listaTemas}`;
}

const txt = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

function limpiarEstudio(d) {
  if (!d || typeof d !== "object") return null;
  let temas = (Array.isArray(d.temas) ? d.temas : []).map((t, i) => ({ id: txt(t?.id, 20) || "t" + (i + 1), nombre: txt(t?.nombre, 80) })).filter(t => t.nombre);
  const ids = new Set(temas.map(t => t.id));
  const tema = v => { const k = txt(v, 20); return ids.has(k) ? k : (temas[0]?.id || "t1"); };
  if (!temas.length) temas = [{ id: "t1", nombre: txt(d.titulo, 80) || "General" }];
  const resumen = (Array.isArray(d.resumen) ? d.resumen : []).map(r => ({ tema: tema(r?.tema), titulo: txt(r?.titulo, 120), puntos: (Array.isArray(r?.puntos) ? r.puntos : []).map(p => txt(p)).filter(Boolean) })).filter(r => r.puntos.length);
  const flashcards = (Array.isArray(d.flashcards) ? d.flashcards : []).map(c => ({ tema: tema(c?.tema), frente: txt(c?.frente, 400), reverso: txt(c?.reverso, 800) })).filter(c => c.frente && c.reverso);
  const trampas = (Array.isArray(d.trampas) ? d.trampas : []).map(c => ({ tema: tema(c?.tema), confusion: txt(c?.confusion, 300), clave: txt(c?.clave, 800) })).filter(c => c.confusion && c.clave);
  const plan = (Array.isArray(d.plan) ? d.plan : []).map(p => ({ tarea: txt(p?.tarea, 200), minutos: Math.min(Math.max(parseInt(p?.minutos) || 15, 5), 120) })).filter(p => p.tarea);
  if (!resumen.length && !flashcards.length) return null;
  return { titulo: txt(d.titulo, 80) || temas[0].nombre, temas, resumen, flashcards, trampas, plan };
}

function limpiarQuiz(arr, temas) {
  const ids = new Set(temas.map(t => t.id));
  return (Array.isArray(arr) ? arr : [])
    .filter(q => q && q.pregunta && Array.isArray(q.opciones) && q.opciones.length >= 2
      && Number.isInteger(+q.correcta) && +q.correcta >= 0 && +q.correcta < q.opciones.length)
    .map(q => ({
      tema: ids.size ? (ids.has(String(q.tema)) ? String(q.tema) : temas[0].id) : txt(q.tema, 80),
      pregunta: txt(q.pregunta, 1500), opciones: q.opciones.map(o => txt(o, 400)),
      correcta: +q.correcta, explicacion: txt(q.explicacion, 1000)
    }));
}

function parseJSON(raw) {
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/[\[{][\s\S]*[\]}]/);
    try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Falta configurar GEMINI_API_KEY en el servidor." });

  const { modo = "quiz", texto = "", archivo, mime, n = 10, tipo = "mixto", nivel = "intermedia", codigo = "", temas: temasIn = [], hechas = [] } = req.body || {};

  // Acceso por código (para vender acceso)
  const codes = (process.env.ACCESS_CODES || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (codes.length && !codes.includes(String(codigo).trim().toUpperCase())) {
    return res.status(401).json({ error: "Código de acceso inválido. Pídelo a quien te compartió la app." });
  }

  const textoLimpio = String(texto).slice(0, 60000);
  const tieneArchivo = archivo && TIPOS_ARCHIVO.includes(mime);
  if (textoLimpio.trim().length < 80 && !tieneArchivo) {
    return res.status(400).json({ error: "Pega más apuntes (al menos un párrafo) o sube una foto o PDF." });
  }

  const temas = (Array.isArray(temasIn) ? temasIn : []).slice(0, 12)
    .map(t => ({ id: txt(t?.id, 20), nombre: txt(t?.nombre, 80) })).filter(t => t.id && t.nombre);
  const esEstudio = modo === "estudio";
  const cantidad = Math.min(Math.max(parseInt(n) || 10, 3), MAX_QUESTIONS);
  const nivelOk = ["básica", "intermedia", "alta"].includes(nivel) ? nivel : "intermedia";

  const parts = [{ text: esEstudio ? promptEstudio() : promptQuiz({ cantidad, tipo, nivel: nivelOk, temas }) }];
  if (textoLimpio.trim()) parts.push({ text: "APUNTES:\n" + textoLimpio });
  if (tieneArchivo) parts.push({ inline_data: { mime_type: mime, data: archivo } });
  const ya = (Array.isArray(hechas) ? hechas : []).slice(-60).map(h => txt(h, 160)).filter(Boolean);
  if (!esEstudio && ya.length) parts.push({ text: "YA HECHAS (no las repitas):\n- " + ya.join("\n- ") });

  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: esEstudio ? ESQUEMA_ESTUDIO : ESQUEMA_QUIZ,
          temperature: esEstudio ? 0.4 : 0.7
        }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || "";
      if (r.status === 429) return res.status(429).json({ error: "La app está muy usada ahora mismo. Intenta en un minuto." });
      console.error("Gemini error", r.status, msg);
      return res.status(502).json({ error: "No se pudo generar. Intenta de nuevo." });
    }
    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const parsed = parseJSON(raw);

    if (esEstudio) {
      const estudio = limpiarEstudio(parsed);
      if (!estudio) return res.status(502).json({ error: "La respuesta salió vacía. Intenta de nuevo." });
      return res.status(200).json({ estudio });
    }
    const preguntas = limpiarQuiz(parsed, temas);
    if (!preguntas.length) return res.status(502).json({ error: "La respuesta salió vacía. Intenta de nuevo." });
    return res.status(200).json({ preguntas });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error de conexión. Intenta de nuevo." });
  }
}
