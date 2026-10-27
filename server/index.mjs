/* PI Assist — AI Proxy Server (Node/Express)
   역할: 이미지+프롬프트를 받아 Anthropic API로 중계하고 텍스트만 반환.
   - API 키는 서버 환경변수(ANTHROPIC_API_KEY)에만 존재
   - 이미지는 메모리 통과만 하며 디스크 저장·내용 로깅을 하지 않음
   - 모델/max_tokens는 서버에서 고정 (임의 프롬프트 릴레이 남용 방지: 크기·개수 제한) */
import express from "express";
import cors from "cors";
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors({ origin: process.env.ALLOW_ORIGIN || true }));

const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.AI_MODEL || "claude-sonnet-4-6";
const PORT = process.env.PORT || 8787;

/* 간단한 IP별 rate limit: 분당 30회 */
const hits = new Map();
const WINDOW_MS = 60_000, MAX_REQ = 30;
app.use("/api/", (req, res, next) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_REQ) return res.status(429).json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." });
  arr.push(now); hits.set(ip, arr);
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL, keyLoaded: !!KEY }));

app.post("/api/ai/analyze", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다 (.env 확인)." });
    const { images, prompt } = req.body || {};
    if (!Array.isArray(images) || images.length < 1 || images.length > 3)
      return res.status(400).json({ error: "images는 base64 문자열 1~3개여야 합니다." });
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 20000)
      return res.status(400).json({ error: "prompt 형식 오류" });
    for (const b of images) {
      if (typeof b !== "string" || b.length < 100 || b.length > 4_000_000)
        return res.status(400).json({ error: "이미지 크기가 허용 범위를 벗어났습니다." });
    }
    console.log(`[ai] ${new Date().toISOString()} images=${images.length} promptChars=${prompt.length}`);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    const data = await r.json().catch(() => null);
    console.log("[anthropic]", r.status);
    if (r.ok && data?.usage) {
      const count = key =>
        Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0
          ? data.usage[key] : 0;
      console.log("[ai-usage]", JSON.stringify({
        model: typeof data.model === "string" ? data.model : MODEL,
        input_tokens: count("input_tokens"),
        output_tokens: count("output_tokens"),
        cache_creation_input_tokens: count("cache_creation_input_tokens"),
        cache_read_input_tokens: count("cache_read_input_tokens")
      }));
    }
    if (!r.ok || !data || data.error)
      return res.status(502).json({ error: (data && data.error && data.error.message) || `Anthropic API 오류 (${r.status})` });
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message || "프록시 내부 오류" });
  }
});

/* 프로덕션: dist가 있으면 정적 서빙 + SPA fallback (단일 프로세스 배포) */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) return res.sendFile(path.join(dist, "index.html"));
    next();
  });
}

app.listen(PORT, () => console.log(`PI Assist AI proxy listening on :${PORT} (keyLoaded=${!!KEY}, model=${MODEL})`));
