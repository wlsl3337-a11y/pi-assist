import {createChargedAnalysis} from "./credit-ai-route.mjs";
import {accountRouter} from "./account-routes.mjs";
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

app.use("/api/account", accountRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL, keyLoaded: !!KEY }));

app.post("/api/ai/analyze", (_req,res)=>res.status(426).json({code:'UPDATE_REQUIRED',error:'AI 분석을 이용하려면 앱을 업데이트해주세요. 수동 사정과 기록 열람은 계속 이용할 수 있습니다.'}));
app.post("/api/ai/credited-analyze", createChargedAnalysis());

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) return res.sendFile(path.join(dist, "index.html"));
    next();
  });
}

app.listen(PORT, () => console.log(`PI Assist AI proxy listening on :${PORT} (keyLoaded=${!!KEY}, model=${MODEL})`));
