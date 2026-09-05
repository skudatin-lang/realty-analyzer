import Busboy from "busboy";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
async function projectFile(folder, name) {
  for (const candidate of [path.resolve(here, `../../${folder}`, name), path.resolve(here, `../${folder}`, name)]) {
    try { return await readFile(candidate, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error(`Не найден файл ${folder}/${name}`);
}

const extractionSchema = JSON.parse(await projectFile("schemas", "extraction.schema.json"));
const analysisSchema = JSON.parse(await projectFile("schemas", "analysis.schema.json"));
const initialAnalysisSchema = JSON.parse(await projectFile("schemas", "initial-analysis.schema.json"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateExtraction = ajv.compile(extractionSchema);
const validateAnalysis = ajv.compile(analysisSchema);
const validateInitialAnalysis = ajv.compile(initialAnalysisSchema);
const limits = new Map();

const headers = origin => ({
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin",
  ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type"
});
function allowed(origin) { if (!origin) return true; return (process.env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean).includes(origin); }
function response(statusCode, body, origin) { return { statusCode, headers: headers(origin), body: JSON.stringify(body) }; }
function routeOf(e) { return e.path || e.url || e.requestContext?.http?.path || "/"; }
function rate(ip) { const now = Date.now(), key = ip || "unknown", x = limits.get(key) || { start: now, count: 0 }; if (now - x.start > 60000) { x.start = now; x.count = 0; } x.count++; limits.set(key, x); return x.count <= Number(process.env.RATE_LIMIT_PER_MINUTE || 20); }
function parseJson(text) { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
function providerError(status, body = "") { console.log(JSON.stringify({ type: "provider_error", status, body: String(body).slice(0, 800) })); return Object.assign(new Error("AI provider unavailable"), { code: `PROVIDER_${status}`, status: status === 429 ? 429 : 502 }); }

async function parseMultipart(e) {
  const type = e.headers?.["content-type"] || e.headers?.["Content-Type"] || "";
  if (!type.startsWith("multipart/form-data")) throw Object.assign(new Error("Ожидается multipart/form-data"), { code: "BAD_MIME", status: 415 });
  const body = Buffer.from(e.body || "", e.isBase64Encoded ? "base64" : "utf8");
  if (body.length > 12 * 1024 * 1024) throw Object.assign(new Error("Запрос больше 12 МБ"), { code: "TOO_LARGE", status: 413 });
  return new Promise((resolve, reject) => {
    const fields = {}, images = []; let failed;
    const bb = Busboy({ headers: { "content-type": type }, limits: { files: 2, fileSize: 8 * 1024 * 1024, fields: 8, fieldSize: 200000 } });
    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (name, stream, info) => {
      if (name !== "images" || !["image/png", "image/jpeg", "image/webp"].includes(info.mimeType)) { failed = Object.assign(new Error("Неподдерживаемый формат изображения"), { code: "BAD_MIME", status: 415 }); stream.resume(); return; }
      const chunks = [];
      stream.on("limit", () => { failed = Object.assign(new Error("Изображение больше 8 МБ"), { code: "TOO_LARGE", status: 413 }); });
      stream.on("data", d => chunks.push(d));
      stream.on("end", () => images.push({ mimeType: info.mimeType, base64: Buffer.concat(chunks).toString("base64") }));
    });
    bb.on("error", reject);
    bb.on("finish", () => failed ? reject(failed) : (!images.length && !fields.comment?.trim()) ? reject(Object.assign(new Error("Добавьте изображение или текст"), { code: "NO_SOURCE", status: 400 })) : resolve({ fields, images }));
    bb.end(body);
  });
}

function openRouterText(raw) {
  const text = raw?.choices?.[0]?.message?.content;
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(x => x.text || "").join("");
  throw providerError(502, "Пустой ответ OpenRouter");
}
async function openRouter(messages, model, signal) {
  const base = (process.env.AI_BASE_URL || "https://api.proxyapi.ru/openrouter/v1").replace(/\/$/, "");
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${process.env.PROXYAPI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, temperature: 0.1, response_format: { type: "json_object" } }), signal });
  if (!r.ok) throw providerError(r.status, await r.text());
  return openRouterText(await r.json());
}
async function google(messages, model, signal) {
  const system = messages.filter(x => x.role === "system").map(x => typeof x.content === "string" ? x.content : "").join("\n");
  const parts = [];
  for (const message of messages.filter(x => x.role !== "system")) {
    if (typeof message.content === "string") parts.push({ text: message.content });
    else for (const item of message.content) item.type === "image_url" ? parts.push({ inline_data: { mime_type: item.image_url.mimeType, data: item.image_url.base64 } }) : parts.push({ text: item.text || "" });
  }
  const base = (process.env.GOOGLE_BASE_URL || "https://api.proxyapi.ru/google/v1beta").replace(/\/$/, "");
  const shortModel = model.replace(/^google\//, "");
  const r = await fetch(`${base}/models/${encodeURIComponent(shortModel)}:generateContent`, { method: "POST", headers: { Authorization: `Bearer ${process.env.PROXYAPI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }), signal });
  if (!r.ok) throw providerError(r.status, await r.text());
  const raw = await r.json();
  const text = raw?.candidates?.[0]?.content?.parts?.map(x => x.text || "").join("");
  if (!text) throw providerError(502, "Пустой ответ Google");
  return text;
}
async function ai(messages, model, deadline) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) break;
    const attemptTimeout = Math.min(Number(process.env.AI_ATTEMPT_TIMEOUT_MS || 45000), remaining - 2000);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), attemptTimeout);
    try { return await (model.startsWith("google/") ? google(messages, model, controller.signal) : openRouter(messages, model, controller.signal)); }
    catch (error) {
      if (error.name !== "AbortError") throw error;
      lastError = error;
      console.log(JSON.stringify({ type: "provider_timeout_retry", model, attempt, attemptTimeout }));
    } finally { clearTimeout(timer); }
  }
  throw Object.assign(lastError || new Error("AI timeout"), { code: "PROVIDER_TIMEOUT", status: 504 });
}
async function validAi(messages, model, validate, normalize = value => value) {
  const deadline = Date.now() + Number(process.env.AI_TIMEOUT_MS || 110000);
  let text = await ai(messages, model, deadline);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const data = normalize(parseJson(text)); if (validate(data)) return data; throw new Error(ajv.errorsText(validate.errors)); }
    catch (error) { if (attempt) { console.log(JSON.stringify({ type: "invalid_ai_json", errors: String(error.message).slice(0, 1000) })); throw Object.assign(new Error("AI вернул неподходящий формат"), { code: "INVALID_AI_JSON", status: 502 }); } text = await ai([...messages, { role: "assistant", content: text }, { role: "user", content: `Исправь JSON строго по схеме. Ошибка: ${String(error.message).slice(0, 500)}. Верни только JSON.` }], model, deadline); }
  }
}

const extractionCategories = ["property", "building", "location", "condition", "contents", "legal", "transaction"];
const evidenceSources = new Set(["ИЗОБРАЖЕНИЕ", "ТЕКСТ", "ОБА ИСТОЧНИКА", "РАСЧЁТ"]);
const evidenceStatuses = new Set(["ФАКТ", "ЗАЯВЛЕНО ПРОДАВЦОМ", "НЕИЗВЕСТНО", "НУЖНО ПРОВЕРИТЬ"]);
const photoStatuses = new Set(["ФАКТ", "ГИПОТЕЗА", "НУЖНО ПРОВЕРИТЬ"]);
function primitive(value) { return ["string", "number", "boolean"].includes(typeof value) ? value : null; }
function evidenceItem(item, fallbackSource, fallbackStatus) {
  const sourceObject = item && typeof item === "object" && !Array.isArray(item) ? item : { value: primitive(item) };
  const value = primitive(sourceObject.value);
  return {
    field: String(sourceObject.field || sourceObject.name || "Сведения об объекте"), value,
    source: evidenceSources.has(sourceObject.source) ? sourceObject.source : fallbackSource,
    note: String(sourceObject.note || sourceObject.comment || "Требует сопоставления с исходным материалом"),
    status: evidenceStatuses.has(sourceObject.status) ? sourceObject.status : fallbackStatus,
    source_text: String(sourceObject.source_text || sourceObject.evidence || sourceObject.quote || value || "")
  };
}
function evidenceList(value, source, status) { return Array.isArray(value) ? value.map(item => evidenceItem(item, source, status)) : []; }
function photoItem(item) {
  const sourceObject = item && typeof item === "object" && !Array.isArray(item) ? item : { observation: String(item || "") };
  return { observation: String(sourceObject.observation || sourceObject.text || ""), interpretation: String(sourceObject.interpretation || sourceObject.effect || "Требует интерпретации"), status: photoStatuses.has(sourceObject.status) ? sourceObject.status : "ГИПОТЕЗА" };
}
export function normalizeExtractionShape(raw, meta) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fallbackSource = meta.hasImages && meta.hasText ? "ОБА ИСТОЧНИКА" : meta.hasImages ? "ИЗОБРАЖЕНИЕ" : "ТЕКСТ";
  const result = { id: meta.id, role: meta.role, address: typeof source.address === "string" ? source.address : null, price: typeof source.price === "number" && source.price >= 0 ? source.price : null, area: typeof source.area === "number" && source.area >= 0 ? source.area : null, rooms: ["string", "number"].includes(typeof source.rooms) ? source.rooms : null };
  if (typeof source.price_per_m2_claimed === "number" && source.price_per_m2_claimed >= 0) result.price_per_m2_claimed = source.price_per_m2_claimed;
  for (const name of extractionCategories) result[name] = evidenceList(source[name], fallbackSource, "ФАКТ");
  result.observations = evidenceList(source.observations, fallbackSource, "ФАКТ");
  result.seller_claims = evidenceList(source.seller_claims, "ТЕКСТ", "ЗАЯВЛЕНО ПРОДАВЦОМ");
  result.needs_verification = evidenceList(source.needs_verification, fallbackSource, "НУЖНО ПРОВЕРИТЬ");
  result.contradictions = Array.isArray(source.contradictions) ? source.contradictions.map(item => ({ field: String(item?.field || "Расхождение источников"), image_value: primitive(item?.image_value), text_value: primitive(item?.text_value), resolution: ["СПРОСИТЬ ПО ТЕЛЕФОНУ", "ПРОВЕРИТЬ НА ПРОСМОТРЕ", "ПРОВЕРИТЬ ДОКУМЕНТЫ"].includes(item?.resolution) ? item.resolution : "СПРОСИТЬ ПО ТЕЛЕФОНУ" })) : [];
  result.missing_important_fields = Array.isArray(source.missing_important_fields) ? source.missing_important_fields.map(String) : [];
  const photos = source.photo_analysis && typeof source.photo_analysis === "object" ? source.photo_analysis : {};
  result.photo_analysis = { has_images: meta.hasImages, observations: (Array.isArray(photos.observations) ? photos.observations : []).map(photoItem), presentation_strengths: (Array.isArray(photos.presentation_strengths) ? photos.presentation_strengths : []).map(photoItem), presentation_weaknesses: (Array.isArray(photos.presentation_weaknesses) ? photos.presentation_weaknesses : []).map(photoItem), text_photo_gaps: (Array.isArray(photos.text_photo_gaps) ? photos.text_photo_gaps : []).map(photoItem) };
  return result;
}

const initialStatuses = new Set(["ФАКТ", "РАСЧЁТ", "ГИПОТЕЗА", "НЕИЗВЕСТНО", "НУЖНО ПРОВЕРИТЬ", "ПРОТИВОРЕЧИЕ"]);
function normalizeInitialStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (initialStatuses.has(status)) return status;
  if (["ЗАЯВЛЕНО ПРОДАВЦОМ", "ЗАЯВЛЕНО", "УКАЗАНО В ОБЪЯВЛЕНИИ", "УТВЕРЖДЕНИЕ ПРОДАВЦА"].includes(status)) return "ФАКТ";
  if (["ИНТЕРПРЕТАЦИЯ", "ПРЕДПОЛОЖЕНИЕ", "ВЕРОЯТНО"].includes(status)) return "ГИПОТЕЗА";
  if (["ТРЕБУЕТ УТОЧНЕНИЯ", "ПРОВЕРИТЬ", "НЕ ПОДТВЕРЖДЕНО"].includes(status)) return "НУЖНО ПРОВЕРИТЬ";
  if (["Н/Д", "НЕТ ДАННЫХ", "НЕДОСТАТОЧНО ДАННЫХ"].includes(status)) return "НЕИЗВЕСТНО";
  return value;
}
export function normalizeInitialAnalysisShape(raw) {
  if (Array.isArray(raw)) return raw.map(normalizeInitialAnalysisShape);
  if (!raw || typeof raw !== "object") return raw;
  const result = {};
  for (const [key, value] of Object.entries(raw)) result[key] = key === "status" ? normalizeInitialStatus(value) : normalizeInitialAnalysisShape(value);
  return result;
}

function normalizeExtraction(data) {
  const legalDate = /(дкп|приватизац|наслед|дарени|регистрац|переход.*прав|ипотек)/i;
  const directHouseYear = /(год.*(построй|строительств)|дом.*(постро|сдан)|построен.*дом)/i;
  const rejected = [];
  data.building = (data.building || []).filter(item => {
    const isYear = /(year_built|год.*(дом|построй)|год постройки)/i.test(item.field || "");
    const evidence = `${item.source_text || ""} ${item.note || ""}`;
    if (isYear && legalDate.test(evidence) && !directHouseYear.test(evidence)) { rejected.push(item); return false; }
    return true;
  });
  if (rejected.length) {
    data.missing_important_fields = [...new Set([...(data.missing_important_fields || []), "год постройки"] )];
    data.needs_verification = [...(data.needs_verification || []), { field: "Год постройки", value: null, source: "ТЕКСТ", note: "Юридическая дата не подтверждает год дома", status: "НУЖНО ПРОВЕРИТЬ", source_text: rejected.map(x => x.source_text).filter(Boolean).join("; ") }];
  }
  return data;
}

async function extract(e) {
  const { fields, images } = await parseMultipart(e);
  if (!["target", "competitor"].includes(fields.role)) throw Object.assign(new Error("Некорректная роль"), { code: "BAD_ROLE", status: 400 });
  const content = [{ type: "text", text: `id=${fields.id || crypto.randomUUID()}; role=${fields.role}; универсальный текст пользователя=${fields.comment?.trim() || "ОТСУТСТВУЕТ"}\nНаличие источников: изображений=${images.length}, текста=${Boolean(fields.comment?.trim())}.\nJSON Schema: ${JSON.stringify(extractionSchema)}` }];
  images.forEach(image => content.push({ type: "image_url", image_url: image }));
  const id = fields.id || crypto.randomUUID();
  return normalizeExtraction(await validAi([{ role: "system", content: await projectFile("prompts", "extract-object.md") }, { role: "user", content }], process.env.VISION_MODEL, validateExtraction, value => normalizeExtractionShape(value, { id, role: fields.role, hasImages: images.length > 0, hasText: Boolean(fields.comment?.trim()) })));
}
async function analyzeInitial(e) {
  const body = Buffer.from(e.body || "", e.isBase64Encoded ? "base64" : "utf8");
  if (body.length > 1024 * 1024) throw Object.assign(new Error("JSON больше 1 МБ"), { code: "TOO_LARGE", status: 413 });
  let data; try { data = JSON.parse(body.toString("utf8")); } catch { throw Object.assign(new Error("Некорректный JSON"), { code: "BAD_JSON", status: 400 }); }
  if (!data.target) throw Object.assign(new Error("Нужен один целевой объект"), { code: "BAD_INPUT", status: 400 });
  const names = ["initial-analysis.md", "photo-audit.md", "call-preparation.md"];
  const modules = await Promise.all(names.map(name => projectFile("prompts", name)));
  return validAi([{ role: "system", content: `${modules.join("\n\n---\n\n")}\n\nСхема ответа: ${JSON.stringify(initialAnalysisSchema)}` }, { role: "user", content: JSON.stringify({ target: data.target, deterministic: data.calculations || {} }) }], process.env.ANALYSIS_MODEL, validateInitialAnalysis, normalizeInitialAnalysisShape);
}
async function analyze(e) {
  const body = Buffer.from(e.body || "", e.isBase64Encoded ? "base64" : "utf8");
  if (body.length > 1024 * 1024) throw Object.assign(new Error("JSON больше 1 МБ"), { code: "TOO_LARGE", status: 413 });
  let data; try { data = JSON.parse(body.toString("utf8")); } catch { throw Object.assign(new Error("Некорректный JSON"), { code: "BAD_JSON", status: 400 }); }
  if (data.mode === "initial") {
    if (!data.target) throw Object.assign(new Error("Нужен один целевой объект"), { code: "BAD_INPUT", status: 400 });
    const names = ["initial-analysis.md", "photo-audit.md", "call-preparation.md"];
    const modules = await Promise.all(names.map(name => projectFile("prompts", name)));
    return validAi([{ role: "system", content: `${modules.join("\n\n---\n\n")}\n\nСхема ответа: ${JSON.stringify(initialAnalysisSchema)}` }, { role: "user", content: JSON.stringify({ target: data.target, deterministic: data.calculations || {} }) }], process.env.ANALYSIS_MODEL, validateInitialAnalysis, normalizeInitialAnalysisShape);
  }
  if (!data.target || !Array.isArray(data.competitors) || !data.competitors.length) throw Object.assign(new Error("Нужны цель и конкурент"), { code: "BAD_INPUT", status: 400 });
  const names = ["analysis-methodology.md", "buyer-value.md", "seller-questions.md", "inspection.md", "storytelling.md", "report-format.md"];
  const modules = await Promise.all(names.map(name => projectFile("prompts", name)));
  return validAi([{ role: "system", content: `${modules.join("\n\n---\n\n")}\n\nСхема ответа: ${JSON.stringify(analysisSchema)}` }, { role: "user", content: JSON.stringify(data) }], process.env.ANALYSIS_MODEL, validateAnalysis);
}

export async function handler(event) {
  const start = Date.now(), requestId = event.requestContext?.requestId || crypto.randomUUID(), route = routeOf(event), method = event.httpMethod || event.requestContext?.http?.method || "GET", origin = event.headers?.origin || event.headers?.Origin || "";
  let status = 200, errorType = null;
  try {
    if (!allowed(origin)) throw Object.assign(new Error("Origin не разрешён"), { code: "CORS", status: 403 });
    if (method === "OPTIONS") return { statusCode: 204, headers: headers(origin), body: "" };
    if (!rate(event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp)) throw Object.assign(new Error("Слишком много запросов"), { code: "RATE_LIMIT", status: 429 });
    if (route.endsWith("/api/health") && method === "GET") return response(200, { ok: true, providerConfigured: Boolean(process.env.PROXYAPI_KEY && process.env.VISION_MODEL && process.env.ANALYSIS_MODEL), analyticsVersion: 3 }, origin);
    if (route.endsWith("/api/extract-object") && method === "POST") return response(200, { ok: true, data: await extract(event) }, origin);
    if (route.endsWith("/api/analyze-listing") && method === "POST") return response(200, { ok: true, data: await analyzeInitial(event) }, origin);
    if (route.endsWith("/api/analyze") && method === "POST") return response(200, { ok: true, data: await analyze(event) }, origin);
    status = 404; return response(404, { ok: false, error: { code: "NOT_FOUND", message: "Маршрут не найден" } }, origin);
  } catch (error) {
    status = error.status || 500; errorType = String(error.code || "INTERNAL");
    return response(status, { ok: false, error: { code: errorType, message: status >= 500 ? "Сервис временно недоступен. Попробуйте ещё раз." : error.message }, requestId }, allowed(origin) ? origin : "");
  } finally {
    console.log(JSON.stringify({ requestId, timestamp: new Date().toISOString(), endpoint: route, latencyMs: Date.now() - start, status, size: Buffer.byteLength(event.body || ""), errorType, providerStatus: typeof errorType === "string" && errorType.startsWith("PROVIDER_") ? errorType : "not_applicable" }));
  }
}
