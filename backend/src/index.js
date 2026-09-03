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
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateExtraction = ajv.compile(extractionSchema);
const validateAnalysis = ajv.compile(analysisSchema);
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
async function ai(messages, model) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 110000));
  try { return await (model.startsWith("google/") ? google(messages, model, controller.signal) : openRouter(messages, model, controller.signal)); }
  catch (error) { if (error.name === "AbortError") throw Object.assign(new Error("AI timeout"), { code: "PROVIDER_TIMEOUT", status: 504 }); throw error; }
  finally { clearTimeout(timer); }
}
async function validAi(messages, model, validate) {
  let text = await ai(messages, model);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const data = parseJson(text); if (validate(data)) return data; throw new Error(ajv.errorsText(validate.errors)); }
    catch (error) { if (attempt) throw Object.assign(new Error("AI вернул неподходящий формат"), { code: "INVALID_AI_JSON", status: 502 }); text = await ai([...messages, { role: "assistant", content: text }, { role: "user", content: `Исправь JSON строго по схеме. Ошибка: ${String(error.message).slice(0, 500)}. Верни только JSON.` }], model); }
  }
}

async function extract(e) {
  const { fields, images } = await parseMultipart(e);
  if (!["target", "competitor"].includes(fields.role)) throw Object.assign(new Error("Некорректная роль"), { code: "BAD_ROLE", status: 400 });
  const content = [{ type: "text", text: `id=${fields.id || crypto.randomUUID()}; role=${fields.role}; универсальный текст пользователя=${fields.comment?.trim() || "ОТСУТСТВУЕТ"}\nНаличие источников: изображений=${images.length}, текста=${Boolean(fields.comment?.trim())}.\nJSON Schema: ${JSON.stringify(extractionSchema)}` }];
  images.forEach(image => content.push({ type: "image_url", image_url: image }));
  return validAi([{ role: "system", content: await projectFile("prompts", "extract-object.md") }, { role: "user", content }], process.env.VISION_MODEL, validateExtraction);
}
async function analyze(e) {
  const body = Buffer.from(e.body || "", e.isBase64Encoded ? "base64" : "utf8");
  if (body.length > 1024 * 1024) throw Object.assign(new Error("JSON больше 1 МБ"), { code: "TOO_LARGE", status: 413 });
  let data; try { data = JSON.parse(body.toString("utf8")); } catch { throw Object.assign(new Error("Некорректный JSON"), { code: "BAD_JSON", status: 400 }); }
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
    if (route.endsWith("/api/health") && method === "GET") return response(200, { ok: true, providerConfigured: Boolean(process.env.PROXYAPI_KEY && process.env.VISION_MODEL && process.env.ANALYSIS_MODEL), analyticsVersion: 2 }, origin);
    if (route.endsWith("/api/extract-object") && method === "POST") return response(200, { ok: true, data: await extract(event) }, origin);
    if (route.endsWith("/api/analyze") && method === "POST") return response(200, { ok: true, data: await analyze(event) }, origin);
    status = 404; return response(404, { ok: false, error: { code: "NOT_FOUND", message: "Маршрут не найден" } }, origin);
  } catch (error) {
    status = error.status || 500; errorType = String(error.code || "INTERNAL");
    return response(status, { ok: false, error: { code: errorType, message: status >= 500 ? "Сервис временно недоступен. Попробуйте ещё раз." : error.message }, requestId }, allowed(origin) ? origin : "");
  } finally {
    console.log(JSON.stringify({ requestId, timestamp: new Date().toISOString(), endpoint: route, latencyMs: Date.now() - start, status, size: Buffer.byteLength(event.body || ""), errorType, providerStatus: typeof errorType === "string" && errorType.startsWith("PROVIDER_") ? errorType : "not_applicable" }));
  }
}
