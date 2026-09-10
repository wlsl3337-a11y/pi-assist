import React, { useState, useEffect, useRef } from "react";
import {
  Camera, Upload, ClipboardList, FolderOpen, Info, ChevronLeft,
  AlertTriangle, Sparkles, Trash2, RefreshCw, Ruler, Activity, Check,
  ArrowLeftRight, X, ChevronRight
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

/* ================================================================== */
/* Storage Adapter — Android 전환 시 유일한 교체 지점                   */
/*                                                                    */
/* 계약(StorageAdapter interface):                                     */
/*   getItem(key)        -> Promise<string|null>  (없거나 읽기 실패 시 null) */
/*   setItem(key, value) -> Promise<any>          (실패 시 throw 허용)  */
/*   removeItem(key)     -> Promise<any>                               */
/*   listKeys(prefix)    -> Promise<string[]>                          */
/*                                                                    */
/* 데이터 키(변경 금지): pi:index:v1 = 인덱스 JSON                      */
/*                       pi:a:{id}   = 사정 레코드 JSON(사진 base64 포함) */
/*                                                                    */
/* Capacitor/SQLite 전환 시: 아래 artifactStorageAdapter 대신 동일 계약의 */
/* sqliteStorageAdapter를 구현해 `storage` 할당만 바꾸면 됩니다.        */
/* 앱의 다른 어떤 코드도 window.storage를 직접 호출하지 않습니다.        */
/* ================================================================== */

const artifactStorageAdapter = {
  async getItem(key) {
    try { const r = await window.storage.get(key); return r && r.value != null ? r.value : null; }
    catch (e) { return null; }
  },
  async setItem(key, value) { return window.storage.set(key, value); },
  async removeItem(key) { return window.storage.delete(key); },
  async listKeys(prefix) {
    const l = await window.storage.list(prefix);
    return ((l && l.keys) || []).map((k) => (typeof k === "string" ? k : k && k.key)).filter(Boolean);
  },
};

const memoryStorageAdapter = (() => {
  const mem = {};
  return {
    async getItem(key) { return key in mem ? mem[key] : null; },
    async setItem(key, value) { mem[key] = value; },
    async removeItem(key) { delete mem[key]; },
    async listKeys(prefix) { return Object.keys(mem).filter((k) => k.startsWith(prefix)); },
  };
})();

/* IndexedDB 어댑터 — Vite/브라우저 독립 실행용 (의존성 없음) */
const idbStorageAdapter = (() => {
  const DB = "pi-assist", STORE = "kv";
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    async getItem(key) {
      try { const v = await tx("readonly", (st) => st.get(key)); return v == null ? null : v; }
      catch (e) { return null; }
    },
    async setItem(key, value) { return tx("readwrite", (st) => st.put(value, key)); },
    async removeItem(key) { return tx("readwrite", (st) => st.delete(key)); },
    async listKeys(prefix) {
      try { const keys = await tx("readonly", (st) => st.getAllKeys()); return (keys || []).filter((k) => typeof k === "string" && k.startsWith(prefix)); }
      catch (e) { return []; }
    },
  };
})();

const storage = (() => {
  /* 샌드박스 iframe에서는 window.storage/indexedDB 접근 자체가 예외를 던질 수 있어
     모든 감지를 try/catch로 감싼다. 아티팩트(window.storage 존재) → artifactStorageAdapter,
     독립 브라우저 → idbStorageAdapter, 둘 다 불가 → memoryStorageAdapter. */
  try { if (typeof window !== "undefined" && window.storage) return artifactStorageAdapter; } catch (e) {}
  try { if (typeof indexedDB !== "undefined" && indexedDB != null) return idbStorageAdapter; } catch (e) {}
  return memoryStorageAdapter;
})();

const IDX_KEY = "pi:index:v1";
const A_KEY = (id) => "pi:a:" + id;
const emptyIndex = () => ({ patients: {}, wounds: {}, assess: {} });

async function loadIndex() {
  try { const raw = await storage.getItem(IDX_KEY); return raw ? JSON.parse(raw) : emptyIndex(); }
  catch (e) { return emptyIndex(); }
}
async function saveIndex(idx) { await storage.setItem(IDX_KEY, JSON.stringify(idx)); }
async function saveFull(a) { await storage.setItem(A_KEY(a.id), JSON.stringify(a)); }
async function loadFull(id) {
  try { const raw = await storage.getItem(A_KEY(id)); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}


/* ------------------------------------------------------------------ */
/* 상수                                                                */
/* ------------------------------------------------------------------ */
const DISCLAIMER = "AI 분석 결과는 간호사의 욕창 사정을 보조하기 위한 참고 정보이며, 최종적인 임상 판단은 의료진이 시행해야 합니다.";

const LOCATIONS = ["Sacrum", "Coccyx", "Buttock", "Hip", "Trochanter", "Ischium", "Heel", "Ankle", "Elbow", "Occiput", "Scapula", "Back", "Ear", "Other"];

const STAGES = [
  { code: "1", label: "Stage 1", desc: "비창백성 홍반, 피부 온전" },
  { code: "2", label: "Stage 2", desc: "부분층 손상, 진피 노출" },
  { code: "3", label: "Stage 3", desc: "전층 손상, 피하지방 노출" },
  { code: "4", label: "Stage 4", desc: "근막·근육·건·뼈 노출" },
  { code: "U", label: "Unstageable", desc: "괴사조직으로 깊이 확인 불가" },
  { code: "DTPI", label: "DTPI", desc: "심부조직 압력손상 의심" },
  { code: "ND", label: "미정", desc: "추가 임상 확인 필요" },
  { code: "NONE", label: "욕창 아님", desc: "Blanchable erythema(반응성 충혈)" },
  { code: "IAD", label: "IAD 의심", desc: "실금관련피부염 — 습기 손상" },
];
const stageLabel = (code) => (STAGES.find((s) => s.code === code) || {}).label || "미정";

const STAGE_CRITERIA = {
  "1": {
    crit: [
      "온전한 피부에 국소적 비창백성 홍반(non-blanching erythema) — 눌러도 계속 붉음",
      "주로 뼈 돌출부에 형성",
      "어두운 피부톤에서는 blanching 확인이 어려워 주위 피부색과의 차이로 판단",
    ],
    diff: "표피가 벗겨져 있으면 2단계, 붉은 발적이 아닌 보라·갈색 심부 변색이면 DTPI를 고려.",
  },
  "2": {
    crit: [
      "부분층 피부 손상(표피 및 부분적 진피) 또는 장액성 수포",
      "상처 기저부는 붉거나 핑크빛",
      "부육질(slough)·괴사조직 없음",
    ],
    diff: "지방조직이 보이거나 slough가 있으면 3단계 이상. 실금 부위 짓무름은 IAD와 감별 필요.",
  },
  "3": {
    crit: [
      "전층 피부 손상 — 피하지방 관찰 가능",
      "뼈·건·근육은 노출되지 않음",
      "부육질, 에피볼(말려 닫힌 상처 가장자리), 잠식·터널 동반 가능",
      "깊이는 해부학적 위치에 따라 다양",
    ],
    diff: "뼈·인대·근육이 보이면 4단계, 괴사조직으로 기저부가 보이지 않으면 Unstageable.",
  },
  "4": {
    crit: [
      "전층 피부·조직 손상 — 뼈, 인대, 건, 근육이 노출됨",
      "괴사조직·에피볼·잠식·터널 동반 가능",
      "깊이는 해부학적 위치에 따라 다양",
    ],
    diff: "노출된 심부 구조(뼈·인대·근육)의 확인이 3단계와의 핵심 감별점.",
  },
  "U": {
    crit: [
      "상처 기저부가 부육질·가피(괴사조직)로 덮여 손상 깊이를 확인할 수 없는 전층 손상",
      "괴사조직 제거 후 실제 단계(대개 3~4단계) 분류 가능",
    ],
    diff: "기저부가 일부라도 관찰되어 깊이 판단이 가능하면 3 또는 4단계로 분류.",
  },
  "DTPI": {
    crit: [
      "국소 부위의 보라색·갈색(maroon) 변색 — 피부는 온전하거나 손상되어 있을 수 있음",
      "혈액이 찬 수포 관찰 가능",
      "통증 동반 가능, 진행이 빠르며 치료 중에도 심부층 손상 가능",
    ],
    diff: "1단계의 붉은 발적과 달리 짙은 심부 변색이 특징.",
  },
  "ND": {
    crit: ["현재 소견으로는 단계 판정 근거가 불충분"],
    diff: "WOCN(상처전문간호사)·담당의 재사정으로 단계를 확정.",
  },
  "NONE": {
    crit: [
      "발적 부위를 압박하면 하얗게 변함(blanchable erythema)",
      "반응성 충혈 — 압박 원인 제거 후 대개 소실",
    ],
    diff: "눌러도 계속 붉으면(non-blanching) 1단계 욕창. 발적이 지속·악화되면 재사정.",
  },
  "IAD": {
    crit: [
      "요실금·변실금 등 습기 노출과 관련된 표재성 피부 손상",
      "둔부·회음부·피부 주름에 미만성, 경계 불분명, 짓무름·광택",
      "괴사조직 없음, 뼈 돌출부에 국한되지 않음",
    ],
    diff: "뼈 돌출부 위 경계 명확한 국소 병변이면 욕창. 두 병변은 병존할 수 있음.",
  },
};

function StageCriteria({ code }) {
  const c = STAGE_CRITERIA[code];
  if (!c) return null;
  return (
    <div className="rounded-xl bg-slate-100 p-3">
      <div className="text-xs font-bold text-slate-700 mb-1">{stageLabel(code)} — 판정 기준</div>
      <div className="text-xs text-slate-600 leading-relaxed space-y-0.5">
        {c.crit.map((p, i) => <p key={i}>· {p}</p>)}
      </div>
      <p className="text-xs text-slate-600 mt-1.5"><b>감별</b> — {c.diff}</p>
    </div>
  );
}

function StageFlow() {
  const rows = [
    { c: "① 피부 온전 + 발적·변색", r: "짙은 보라·갈색 변색/혈성 수포 → DTPI 고려 · 그 외 홍반 → Blanching 확인(하얗게 변함: 욕창 아님 · 변하지 않음: Stage 1). 사진만으로 blanching 판정 불가" },
    { c: "② 표피만 손상 + slough·eschar·지방·granulation 없음", r: "Stage 2 (하나라도 보이면 2단계 아님 · 둔부·회음부 짓무름은 IAD 감별)" },
    { c: "③ 전층 의심 → 기저부 확인이 최우선", r: "괴사조직으로 덮여 깊이 확인 불가 → Unstageable. 깊어 보인다는 이유로 3·4 판정 금지" },
    { c: "④ 기저부 관찰 가능", r: "근막·근육·건·뼈 노출 확인 → Stage 4 · 피하지방까지 → Stage 3 (심부 배제가 불확실하면 임상 확인 필요)" },
    { c: "⑤ 판단 근거 불충분", r: "보이지 않음 ≠ 없음 → 미정, WOCN·담당의 재사정" },
  ];
  return (
    <div className="rounded-xl bg-slate-100 p-3 space-y-2">
      <div className="text-xs font-bold text-slate-700">단계 판정 흐름 (NPIAP/EPUAP 국제 기준 · Staging Engine v2)</div>
      {rows.map((x, i) => (
        <div key={i} className="text-xs leading-relaxed">
          <span className="font-bold text-slate-700">{x.c}</span>
          <span className="text-slate-600"> → {x.r}</span>
        </div>
      ))}
    </div>
  );
}

const EXU_AMT = ["None", "Scant", "Small", "Moderate", "Large"];
const EXU_TYPE = ["Serous", "Serosanguineous", "Sanguineous", "Purulent"];
const PERIWOUND = ["Intact", "Erythema", "Maceration", "Excoriation", "Induration", "Edema"];
const ODOR = ["None", "Mild", "Moderate", "Strong"];
const WB_KEYS = [
  { k: "granulation", l: "Granulation" },
  { k: "slough", l: "Slough" },
  { k: "eschar", l: "Eschar" },
  { k: "necrotic", l: "Necrotic tissue" },
  { k: "dermis", l: "Exposed dermis" },
  { k: "other", l: "Other" },
];
const WB_LEGACY = { epithelial: "Epithelial(구)" };
const wbLabel = (k) => ((WB_KEYS.find((w) => w.k === k) || {}).l || WB_LEGACY[k] || k).split(" ")[0];

const OVERRIDE_REASONS = [
  ["clinical", "임상 사정 소견이 사진 소견과 다름"],
  ["depth", "상처 깊이를 사진으로 판단할 수 없음"],
  ["obscured", "Slough/Eschar가 깊이를 가림"],
  ["blanching", "Blanching 확인 결과로 판단 변경"],
  ["other", "기타 (직접 입력)"],
];

const CLIN_GROUPS = {
  "1": { title: "Stage 1 확인 — Blanching", items: [
    ["blanching", "Blanching", [["nonblanch", "Non-blanchable"], ["blanch", "Blanchable"], ["na", "판단 불가"]]],
  ] },
  DTPI: { title: "DTPI 임상 확인", items: [
    ["blanching", "Blanching", [["nonblanch", "Non-blanchable"], ["blanch", "Blanchable"], ["na", "판단 불가"]]],
    ["pain", "통증/압통", [["present", "있음"], ["absent", "없음"], ["na", "판단 불가"]]],
    ["temp", "온도 (주변 대비)", [["warmer", "따뜻함"], ["cooler", "차가움"], ["none", "차이 없음"], ["na", "판단 불가"]]],
    ["firm", "경도", [["firm", "단단함(경결)"], ["boggy", "물렁함(boggy)"], ["none", "차이 없음"], ["na", "판단 불가"]]],
    ["color", "색 변화 진행"],
    ["blister", "혈성 수포"],
  ] },
  "2": { title: "Stage 2 확인", items: [
    ["partial", "부분층 손상 양상"],
    ["sloughEschar", "Slough/Eschar 관찰"],
    ["fat", "지방 조직 노출"],
    ["deep", "심부 조직 노출"],
  ] },
  "3": { title: "Stage 3/4 확인", items: [
    ["fat", "지방 조직 확인"],
    ["sloughEschar", "Slough/Eschar 관찰"],
    ["deep", "심부 구조(근막·근육·건·뼈) 노출"],
    ["depthDone", "깊이를 임상적으로 측정함"],
  ] },
};
CLIN_GROUPS["4"] = CLIN_GROUPS["3"];
CLIN_GROUPS.U = CLIN_GROUPS["3"];
function woundBedText(wb) {
  if (!wb) return "—";
  if (Array.isArray(wb.types)) {
    if (!wb.types.length) return "—";
    return wb.types.map((t) => wbLabel(t) + (wb.predominant === t && wb.types.length > 1 ? " (주)" : "")).join(", ");
  }
  const list = WB_KEYS.filter((w) => (wb[w.k] || 0) > 0).map((w) => `${wbLabel(w.k)} ${wb[w.k]}%`);
  return list.length ? list.join(", ") : "—";
}
const INF_TOGGLES = [
  { k: "warmth", l: "국소 열감" },
  { k: "pain", l: "통증 증가" },
  { k: "purulent", l: "화농성 배액" },
  { k: "fever", l: "발열" },
];

const BRADEN_ITEMS = [
  { k: "sensory", l: "감각인지", opts: ["완전히 제한됨", "매우 제한됨", "약간 제한됨", "손상 없음"] },
  { k: "moisture", l: "습기", opts: ["지속적으로 습함", "습함", "때때로 습함", "거의 습하지 않음"] },
  { k: "activity", l: "활동", opts: ["침상 안정", "의자에 앉을 수 있음", "때때로 보행", "자주 보행"] },
  { k: "mobility", l: "기동력", opts: ["완전히 부동", "매우 제한됨", "약간 제한됨", "제한 없음"] },
  { k: "nutrition", l: "영양", opts: ["매우 불량", "부족함", "적절함", "우수함"] },
  { k: "friction", l: "마찰과 전단력", opts: ["문제 있음", "잠재적 문제", "문제 없음"] },
];
const emptyBraden = () => ({ sensory: null, moisture: null, activity: null, mobility: null, nutrition: null, friction: null });
const bradenTotal = (v) => {
  const vals = BRADEN_ITEMS.map((it) => v && v[it.k]);
  return vals.every((x) => x != null) ? vals.reduce((a, b) => a + b, 0) : null;
};
const bradenRisk = (total) => total == null ? null : (total <= 18 ? { label: "욕창 고위험 (18점 이하)", high: true } : { label: "욕창 저위험 (18점 초과)", high: false });
const bradenBand = (t) => t == null ? null : t <= 9 ? "최고위험(9점 이하)" : t <= 12 ? "고위험(10–12점)" : t <= 14 ? "중등도 위험(13–14점)" : t <= 18 ? "경도 위험(15–18점)" : "위험 낮음(19점 이상)";

const fmt1 = (n) => Math.round(n * 10) / 10;
const CIRC = ["①", "②", "③", "④", "⑤"];
const dateShort = (iso) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`; };
const dateFull = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const dateToInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ------------------------------------------------------------------ */
/* 이미지 처리                                                          */
/* ------------------------------------------------------------------ */
function fileToResizedDataUrl(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일 읽기 실패"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: c.toDataURL("image/jpeg", quality), w, h });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error("이미지 디코딩 실패"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function checkImageQuality(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = 160;
      const scale = s / Math.max(img.width, img.height);
      const c = document.createElement("canvas");
      c.width = Math.max(2, Math.round(img.width * scale));
      c.height = Math.max(2, Math.round(img.height * scale));
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const gray = new Float32Array(c.width * c.height);
      let sum = 0;
      for (let i = 0; i < gray.length; i++) {
        const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        gray[i] = y; sum += y;
      }
      const mean = sum / gray.length;
      let ls = 0, ls2 = 0, n = 0;
      for (let y = 1; y < c.height - 1; y++) for (let x = 1; x < c.width - 1; x++) {
        const i = y * c.width + x;
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - c.width] - gray[i + c.width];
        ls += v; ls2 += v * v; n++;
      }
      const lapVar = n ? ls2 / n - (ls / n) ** 2 : 0;
      const issues = [];
      if (mean < 45) issues.push("사진이 너무 어둡습니다. 조명을 확보해 다시 촬영을 권장합니다.");
      if (mean > 215) issues.push("사진이 과노출되었습니다. 다시 촬영을 권장합니다.");
      if (lapVar < 30) issues.push("초점이 흐릴 수 있습니다. 확인 후 필요 시 재촬영하세요.");
      resolve({ issues });
    };
    img.onerror = () => resolve({ issues: [] });
    img.src = dataUrl;
  });
}

function annotateTargets(photo, points) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const r = Math.max(24, Math.round(Math.max(c.width, c.height) * 0.07));
        const lw = Math.max(4, Math.round(r * 0.18));
        (points || []).forEach((pt, i) => {
          const x = pt.x * c.width, y = pt.y * c.height;
          ctx.lineWidth = lw;
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.beginPath(); ctx.arc(x, y, r + lw, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = "#00B8D9";
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
          if (points.length > 1) {
            const bx = x + r * 0.95, by = y - r * 0.95, br = Math.max(13, Math.round(r * 0.45));
            ctx.fillStyle = "#00B8D9"; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
            ctx.lineWidth = Math.max(2, Math.round(br * 0.15)); ctx.strokeStyle = "white"; ctx.stroke();
            ctx.fillStyle = "white"; ctx.font = `bold ${Math.round(br * 1.2)}px sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(String(i + 1), bx, by);
          }
        });
        resolve(c.toDataURL("image/jpeg", 0.8));
      } catch (e) { resolve(photo.dataUrl); }
    };
    img.onerror = () => resolve(photo.dataUrl);
    img.src = photo.dataUrl;
  });
}

/* ------------------------------------------------------------------ */
/* AI 분석 (Claude vision) — 향후 전용 모델 API로 교체 가능한 단일 지점 */
/* ------------------------------------------------------------------ */
function parseAiJson(raw) {
  let t = (raw || "").replace(/```json|```/g, "").trim();
  const f = t.indexOf("{");
  if (f < 0) throw new Error("응답에 JSON이 없습니다");
  t = t.slice(f);
  const attempt = (str) => JSON.parse(str.replace(/,\s*([}\]])/g, "$1"));
  const l = t.lastIndexOf("}");
  if (l >= 0) {
    try { return attempt(t.slice(0, l + 1)); } catch (e) {}
  }
  const closeFrom = (str) => {
    let inStr = false, esc = false;
    const stack = [];
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{" || c === "[") stack.push(c);
        else if (c === "}" || c === "]") stack.pop();
      }
    }
    let out = str;
    if (inStr) out += '"';
    out = out.replace(/[,\s]+$/, "");
    out = out.replace(/"[^"]*"\s*:\s*$/, "");
    out = out.replace(/[,\s]+$/, "");
    while (stack.length) { const b = stack.pop(); out += b === "{" ? "}" : "]"; }
    return out;
  };
  let cut = t;
  for (let k = 0; k < 40; k++) {
    try { return attempt(closeFrom(cut)); } catch (e) {}
    const m = Math.max(cut.lastIndexOf(","), cut.lastIndexOf("{"), cut.lastIndexOf("["));
    if (m <= 0) break;
    cut = cut.slice(0, m);
  }
  throw new Error("AI 응답 파싱 실패 — 다시 시도해주세요");
}

/* ================== AI 호출 계층 (프록시/직접 자동 분기) ==================
   아티팩트 환경(window.storage 존재): Anthropic 직접 호출 — 환경이 인증 처리, 키 없음
   독립 실행(Vite/Capacitor): /api/ai/analyze 프록시 경유 — API 키는 서버 환경변수에만 존재
   프록시 주소는 VITE_AI_PROXY_BASE로 재정의 가능(기본: 같은 origin) */
/* ESM 전용 메타 구문(import 메타)은 비-ESM 파서에서 SyntaxError를 유발하므로 사용하지 않는다.
   Vite: vite.config의 define이 __AI_PROXY_BASE__를 빌드타임 상수로 주입(.env의 VITE_AI_PROXY_BASE).
   Capacitor 등: 빌드 없이 globalThis.AI_PROXY_BASE로 런타임 재정의 가능. 기본값 "" = 같은 origin. */
const AI_PROXY_BASE = "https://pi-assist.onrender.com";

async function callClaude(dataUrls, promptText) {
console.log("AI CALL START", AI_PROXY_BASE);
  const parts = (dataUrls || []).map((u) =>
    typeof u === "string" && u.includes(",") ? u.split(",")[1] : u
  );

  const res = await fetch(AI_PROXY_BASE + "/api/ai/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      images: parts,
      prompt: promptText,
    }),
  });

  let data = null;
  try {
    data = await res.json();
  } catch (e) {}

  if (!res.ok || !data || data.error) {
    throw new Error(
      (data && data.error) || ("AI 프록시 오류 (" + res.status + ")")
    );
  }

  return data.text || "";
}

function buildAnalysisPrompt(ctx) {
  const sizeStr = ctx.lengthCm ? `, 측정 길이=${ctx.lengthCm}cm, 폭=${ctx.widthCm}cm` : "";
  const depthStr = ctx.depthCm ? `, 깊이=${ctx.depthCm}cm` : "";
  return `당신은 병원 간호사의 욕창(pressure injury) 사정을 보조하는 임상 의사결정 지원 도구입니다. 첨부된 상처 사진을 NPIAP 분류 기준으로 분석하여 구조화된 '사정 초안'을 JSON으로만 출력하세요.

컨텍스트: 부위=${ctx.location || "미상"}${sizeStr}${depthStr}
${ctx.multiTarget ? "\n대상 지정: 이 사진에는 병변이 여러 개 있습니다. 흰색 테두리의 청록색 원으로 표시된 병변 하나만 분석 대상입니다. 원 밖의 병변은 stage 판정·keyFindings·woundBed에 포함하지 말고, 필요하면 존재만 cautions에 한 줄로 언급하세요. 컨텍스트의 측정값도 표시된 병변의 값입니다." + (ctx.zoomHint ? " 두 번째 이미지는 표시된 병변만 확대한 것으로, 확대 이미지 중앙의 병변이 분석 대상입니다." : "") + "\n" : ""}
${ctx.followUpCompare ? "\n경과 비교: 첫 번째 이미지는 이전 사정 사진이고 마지막 이미지는 현재 사정 사진입니다. 현재 사진의 stage는 현재 사진 기준으로 판정하고, healing은 두 사진에서 실제로 보이는 변화만 비교하세요.\n" : ""}
핵심 원칙:
A) 최종 판단은 의료진이 합니다. 이 출력은 "Suggested Stage" 참고 초안이며, 진단을 확정하는 표현을 쓰지 마세요.
B) 사진에서 확인할 수 없는 것을 추측하지 마세요. "보이지 않음"과 "존재하지 않음"을 엄격히 구분하세요 — 구조물이 사진에서 보이지 않는다는 이유만으로 그 손상이 없다고 단정하지 마세요. 판단 근거가 불충분하면 suggestedStage="미정".
C) 숫자 confidence를 만들지 마세요. uncertainty는 "낮음"/"중간"/"높음"만 사용하고, 불확실하면 "높음"으로 설정하세요.
D) 사진만으로 감염을 진단하지 마세요.
E) 사진만으로 상처의 실제 크기(cm)를 추정하지 마세요. 크기는 컨텍스트로 제공된 측정값만 사용하며, rationale·keyFindings에 cm 추정치를 쓰지 마세요.

단계 판정 로직 — 반드시 아래 순서와 우선순위를 따르세요:
1) Photo Quality Check를 먼저 수행하세요. photoQuality.status는 "PASS"(상처 전체와 edge가 보이고 초점·조명 적절, 심한 반사·노출 문제 없음), "CAUTION"(일부 반사, 부분적 과노출/저노출, 상처 일부 불명확 — 분석은 가능하나 신뢰도 제한), "FAIL"(상처 전체 확인 불가, 심한 blur, 심한 과노출/저노출, edge가 거의 안 보임, 드레싱·물질로 가려짐) 중 하나. FAIL이거나 상처 사진이 아니면 canAssess=false로 하고 stage를 제안하지 마세요(이유는 photoQuality.issues에). CAUTION이면 분석을 진행하되 품질 제한을 cautions에 명시하세요.
2) 피부가 intact하고 국소 발적·변색만 있는 경우:
   - 짙은 적색·자주색·흑갈색(maroon) 변색이 지속되거나 혈성 수포가 보이면 → suggestedStage="DTPI", cautions에 "DTPI 고려 — 사진만으로 확정할 수 없음" 포함.
   - 그 외의 홍반이면 → blanching 여부는 사진으로 판단할 수 없으므로 suggestedStage="미정", blanchingCheckNeeded=true, rationale에 "1단계 욕창과 반응성 충혈(blanchable erythema)의 감별을 위해 blanching 확인이 필요합니다"를 포함하세요. "1"을 직접 제안하지 마세요.
3) 부분층 손상(표피 소실·진피 노출), 기저부가 pink/red, 얕은 상처이며 slough·eschar·지방 노출·granulation·심부조직이 전혀 보이지 않으면 → suggestedStage="2". slough/eschar/지방/심부조직이 하나라도 보이면 절대 "2"로 제안하지 마세요. 습기 손상·IAD·외상성 상처 가능성이 있으면 "2"로 단정하지 말고 해당 감별을 cautions에 명시하세요.
4) 전층(full-thickness) 손상이 의심되면 다음 우선순위를 따르세요:
   ① wound bed가 slough/eschar로 일부 또는 대부분 덮여 실제 손상 깊이·범위를 확인할 수 없으면 → suggestedStage="Unstageable", cautions에 "Unstageable 가능성 — slough/eschar로 인해 실제 조직 손상 깊이를 확인하기 어렵습니다" 포함. 상처가 깊어 보인다는 이유로 "3"/"4"를 제안하지 마세요.
   ② 기저부가 관찰 가능하고 근막·근육·건·인대·연골·뼈의 노출이 확인되면 → suggestedStage="4". 상처가 크거나 깊어 보인다는 이유만으로 "4"를 제안하지 마세요.
   ③ 기저부가 관찰 가능하고 피하지방까지 확인되며 심부 구조 노출이 확인되지 않으면 → suggestedStage="3". 단, 해상도·각도·깊이 때문에 심부 구조 침범을 확실히 배제할 수 없으면 cautions에 "사진만으로 deeper tissue involvement를 확실하게 배제하기 어렵습니다"를 포함하고, 불확실성이 크면 "미정"으로 하세요.
   ④ ①~③ 중 어느 쪽인지 불명확하면 → suggestedStage="미정".
5) blanchable로 보이는 홍반만 있거나 욕창을 뒷받침하는 소견이 부족하면 → "미정"으로 하세요. 사진만으로 욕창이 아니라고 확정하지 마세요.

추가 규칙:
6) 천골·둔부·회음부의 표재성 병변에서 미만성 홍반, 불분명한 경계, 짓무름·maceration 등 습기 손상 특징이 보이면 iadCheckNeeded=true, cautions에 "IAD(실금관련피부염) 감별이 필요합니다"를 포함하세요. 실금·습기 노출 병력은 사진 밖 정보이므로 사진만으로 IAD를 확진하지 마세요. 그 외에는 false.
7) woundBed에는 사진에서 확인되는 조직 유형만 나열하고(granulation/slough/eschar/necrotic/dermis/other) 가장 우세한 조직 하나를 predominant로 지정하세요. 상피화(epithelialization)는 wound bed 조직이 아니라 edge 항목으로만 보고하세요: 상처 가장자리 상피화가 보이면 edge="present", 없으면 "absent", 판단 불가면 null. 비율(%)은 추정하지 마세요. 평가 불가하면 null.
8) exudate/periwound는 판단 가능한 것만 제안하고 불가하면 null/빈 배열. periwound 값은 다음에서만: "Intact","Erythema","Maceration","Excoriation","Induration","Edema".
9) keyFindings에는 단계 판단에 사용한 사진 소견을 3~4개의 짧은 구(각 20자 이내)로 나열하세요. 관찰되지 않은 것은 "미확인"으로 표기하고(예: "근육·뼈 노출 미확인"), 불확실한 소견은 끝에 "(불확실)"을 붙이세요. "미확인"은 "없음"을 의미하지 않습니다.
10) differentials에는 인접 분류를 배제했거나 판단을 보류한 이유를 최대 2개까지 {"stage","reason"} 형태로 쓰세요. reason은 25자 이내 한 구절로(예: "근육·뼈 노출 미확인, 배제 불가").
11) rationale는 2~3문장으로 간결하게, 다음을 포함하세요: ①관찰된 주요 특징 ②해당 stage를 고려한 이유 ③인접 stage와의 감별 근거 ④필요한 임상 확인. 예: "전층 피부 및 조직 손상이 의심되며 피하지방 노출 소견이 관찰됩니다. 사진상 근육, 건, 연골 또는 뼈의 노출은 확인되지 않아 Stage 3가 제안됩니다. 다만 사진만으로 deeper tissue involvement를 완전히 배제할 수 없어 임상적 확인이 필요합니다."
12) 경과 비교 사진이 제공된 경우 healing을 평가하세요. 이전→현재 순서로 비교하고, Stage가 낮아졌다는 이유만으로 호전이라고 판단하지 마세요. 사진만으로 상처 면적을 정량 계산하지 말고 눈에 보이는 변화만 사용하세요. 호전 근거는 상피화 진행, 건강한 granulation 증가, slough/eschar 감소, 상처 경계 수축 등을 우선합니다. 악화 의심 근거는 병변 확대, 새로운 괴사·검은색 변화, slough/eschar 증가, 새로운 수포·심부조직 노출 의심 등입니다. 촬영 거리·각도·조명 차이가 크면 healing="판단 불가"로 하세요.
13) healing.status는 "호전"|"변화 없음"|"악화 의심"|"판단 불가" 중 하나만 사용하세요. healing.evidence는 실제 비교 근거를 최대 3개까지 짧게 쓰세요. 경과 비교 사진이 없으면 healing=null로 하세요.
12) rationale, cautions, issues, keyFindings, differentials는 한국어로. 마크다운·설명문 없이, 줄바꿈이나 들여쓰기가 전혀 없는 압축된 JSON 객체 한 줄만 출력하세요. 응답이 길어져 잘리지 않도록 모든 항목을 간결하게 유지하세요.

스키마:
{"canAssess":boolean,"photoQuality":{"status":"PASS"|"CAUTION"|"FAIL","adequate":boolean,"issues":string[]},"suggestedStage":"1"|"2"|"3"|"4"|"Unstageable"|"DTPI"|"미정","blanchingCheckNeeded":boolean,"iadCheckNeeded":boolean,"uncertainty":"낮음"|"중간"|"높음","rationale":string,"cautions":string[],"woundBed":{"present":("granulation"|"slough"|"eschar"|"necrotic"|"dermis"|"other")[],"predominant":"granulation"|"slough"|"eschar"|"necrotic"|"dermis"|"other"|null}|null,"exudate":{"amount":"None"|"Scant"|"Small"|"Moderate"|"Large"|null,"type":"Serous"|"Serosanguineous"|"Sanguineous"|"Purulent"|null},"periwound":string[],"edge":"present"|"absent"|null,"keyFindings":string[],"differentials":[{"stage":"1"|"2"|"3"|"4"|"Unstageable"|"DTPI","reason":string}],"healing":{"status":"호전"|"변화 없음"|"악화 의심"|"판단 불가","evidence":string[]} | null}`;
}

async function analyzeWoundImage(dataUrl, ctx) {
  const urls = Array.isArray(dataUrl) ? dataUrl : [dataUrl];
  const text = await callClaude(urls, buildAnalysisPrompt(ctx));
  return parseAiJson(text);
}

function cropAround(photo, pt) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const box = Math.max(260, Math.round(Math.max(img.width, img.height) * 0.45));
        const size = Math.min(box, Math.min(img.width, img.height));
        let x0 = Math.round(pt.x * img.width - size / 2);
        let y0 = Math.round(pt.y * img.height - size / 2);
        x0 = Math.min(Math.max(0, x0), img.width - size);
        y0 = Math.min(Math.max(0, y0), img.height - size);
        const c = document.createElement("canvas"); c.width = size; c.height = size;
        c.getContext("2d").drawImage(img, x0, y0, size, size, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch (e) { resolve(photo.dataUrl); }
    };
    img.onerror = () => resolve(photo.dataUrl);
    img.src = photo.dataUrl;
  });
}

async function runPool(items, limit, fn) {
  const ret = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; ret[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return ret;
}

function buildMeasurePrompt(ctx) {
  if (ctx.multiCount >= 2) {
    return `사진에는 번호(1~${ctx.multiCount})가 매겨진 청록색 원으로 ${ctx.multiCount}개의 병변이 표시되어 있습니다. 각 번호의 병변마다 크기 측정 축 좌표를 추정하세요.

규칙:
1) 좌표는 이미지 좌상단(0,0)~우하단(1,1) 기준 비율(소수)로 표기하세요.
2) 각 병변의 length: 상처 경계 기준 최대 직경 축의 양 끝점 2개, width: length와 수직 방향의 최대 폭 양 끝점 2개.
3) 자·마커·스티커·표시용 원·정상 피부는 상처가 아닙니다. 조직 손상의 경계를 기준으로 하세요(주변 발적 제외). 사진에 자(ruler)·마커 등 크기 기준(scale)이 보이는지 scaleVisible로 함께 보고하세요.
4) 특정 병변의 경계가 불명확하면 그 병변은 wounds 배열에서 생략하고 note에 이유를 쓰세요. 억지로 추정하지 마세요.
5) JSON만 출력: {"found":boolean,"scaleVisible":boolean,"wounds":[{"index":number,"length":[{"x":number,"y":number},{"x":number,"y":number}],"width":[{"x":number,"y":number},{"x":number,"y":number}]}],"note":string}`;
  }
  return `사진 속 욕창(pressure injury)의 크기 측정을 위한 축 좌표를 추정하세요.${ctx.multiTarget ? " 이 사진에는 병변이 여러 개 있으며, 흰 테두리의 청록색 원으로 표시된 병변만 대상입니다." : ""}

규칙:
1) 좌표는 이미지 좌상단(0,0)~우하단(1,1) 기준 비율(소수)로 표기하세요.
2) length: 상처 경계 기준 최대 직경 축의 양 끝점 2개 (머리-발끝 방향을 우선하되 상처의 실제 최장축).
3) width: length 축과 수직 방향의 최대 폭 양 끝점 2개.
4) 자·마커·스티커·표시용 원·정상 피부는 상처가 아닙니다. 조직 손상의 경계를 기준으로 하세요(주변 발적 제외). 사진에 자(ruler)·마커 등 크기 기준(scale)이 보이는지 scaleVisible로 함께 보고하세요.
5) 상처 경계가 불명확하거나 대상 병변을 특정할 수 없으면 found=false로 하고 note에 이유를 쓰세요. 억지로 추정하지 마세요.
6) JSON만 출력: {"found":boolean,"scaleVisible":boolean,"length":[{"x":number,"y":number},{"x":number,"y":number}]|null,"width":[{"x":number,"y":number},{"x":number,"y":number}]|null,"note":string}`;
}

async function aiMeasureAxes(dataUrl, ctx) {
  const text = await callClaude([dataUrl], buildMeasurePrompt(ctx));
  return parseAiJson(text);
}

function buildBatchPrompt(ctx) {
  return `당신은 간호사의 욕창 사정을 보조하는 임상 의사결정 지원 도구입니다. 사진에는 번호(1~${ctx.count})가 매겨진 청록색 원으로 ${ctx.count}개의 병변이 표시되어 있습니다. 각 번호의 병변을 NPIAP 기준으로 개별 분석해 JSON만 출력하세요.

컨텍스트: ${ctx.items}

원칙(요약): 최종 판단은 의료진이 하며 이 출력은 Suggested Stage 참고 초안입니다. 사진에서 확인할 수 없는 것은 추측하지 마세요("보이지 않음"≠"없음") — 근거가 부족하면 "미정". intact 피부의 홍반은 blanching을 사진으로 판단할 수 없으므로 "미정"+blanchingCheckNeeded=true로 하고 "1"을 직접 제안하지 마세요. 짙은 자주·흑갈색 변색 또는 혈성 수포는 "DTPI". slough/eschar/지방/심부조직이 하나라도 보이면 "2" 금지. 전층 의심 시 우선순위: 기저부가 slough/eschar로 덮여 깊이 확인 불가→"Unstageable"(깊어 보여도 3·4 금지) → 근막·근육·건·뼈 노출 확인→"4" → 피하지방까지→"3"(심부 배제가 불확실하면 caution) → 불명확→"미정". 둔부·회음부의 미만성 짓무름은 iadCheckNeeded=true. 사진만으로 감염 진단 금지, 숫자 confidence 금지, 불확실하면 uncertainty="높음". 서로 다른 번호의 병변 소견을 섞지 마세요.

각 병변은 매우 간결하게: rationale 1~2문장, cautions 최대 2개. 모든 문자열은 한국어(항목명 제외). 마크다운 없이 JSON 객체 하나만.

출력 스키마: {"canAssess":boolean,"photoQuality":{"adequate":boolean,"issues":string[]},"wounds":[{"index":number,"suggestedStage":"1"|"2"|"3"|"4"|"Unstageable"|"DTPI"|"미정","rationale":string,"cautions":string[],"woundBed":{"present":("granulation"|"slough"|"eschar"|"necrotic"|"epithelial")[],"predominant":string|null}|null,"exudate":{"amount":"None"|"Scant"|"Small"|"Moderate"|"Large"|null,"type":"Serous"|"Serosanguineous"|"Sanguineous"|"Purulent"|null},"periwound":string[],"uncertainty":"낮음"|"중간"|"높음","blanchingCheckNeeded":boolean,"iadCheckNeeded":boolean}]}`;
}

async function analyzeBatchImage(dataUrl, ctx) {
  const text = await callClaude([dataUrl], buildBatchPrompt(ctx));
  return parseAiJson(text);
}

const mapAiStage = (s) => {
  if (s === "Unstageable") return "U";
  if (s === "DTPI") return "DTPI";
  if (["1", "2", "3", "4"].includes(s)) return s;
  return "ND";
};

/* ------------------------------------------------------------------ */
/* 권고 및 간호기록 생성 (rule-based)                                   */
/* ------------------------------------------------------------------ */
function infectionFlag(final) {
  const inf = final.infection || {};
  return !!(inf.warmth || inf.pain || inf.purulent || inf.fever || ["Moderate", "Strong"].includes(inf.odor));
}

function iadVerdictFrom(check) {
  if (!check) return null;
  const keys = ["moisture", "diffuse", "unclear", "necrosis"];
  if (!keys.every((k) => check[k] != null)) return null;
  const score = (check.moisture ? 1 : 0) + (check.diffuse ? 1 : 0) + (check.unclear ? 1 : 0) + (check.necrosis ? 0 : 1);
  return score >= 3 ? "IAD 가능성이 높습니다" : score <= 1 ? "욕창(압력 손상) 가능성이 높습니다" : "감별이 어렵습니다 — 혼합 병변 가능, WOCN 의뢰 고려";
}
function clinChecksText(fin) {
  const cc = (fin && fin.clinChecks) || {};
  const L = {
    blanching: { nonblanch: "Non-blanchable", blanch: "Blanchable", na: "Blanching?" },
    pain: { present: "통증+", absent: "통증-", na: "통증?" },
    temp: { warmer: "온도↑", cooler: "온도↓", none: "온도=", na: "온도?" },
    firm: { firm: "경결", boggy: "Boggy", none: "경도=", na: "경도?" },
    color: { yes: "색변화+", no: "색변화-", na: "색변화?" },
    blister: { yes: "혈성수포+", no: "혈성수포-", na: "혈성수포?" },
    partial: { yes: "부분층+", no: "부분층-", na: "부분층?" },
    sloughEschar: { yes: "Slough/Eschar+", no: "Slough/Eschar-", na: "Slough/Eschar?" },
    fat: { yes: "지방노출+", no: "지방노출-", na: "지방?" },
    deep: { yes: "심부노출+", no: "심부노출-", na: "심부?" },
    depthDone: { yes: "깊이측정+", no: "깊이측정-", na: "깊이?" },
  };
  return Object.entries(cc).filter(([, v]) => v).map(([k, v]) => (L[k] && L[k][v]) || `${k}:${v}`).join(" · ");
}

function iadVerdictShortFrom(check) {
  const v = iadVerdictFrom(check);
  return v == null ? null : v.startsWith("IAD") ? "IAD 우세" : v.startsWith("욕창") ? "욕창 우세" : "감별 불명확";
}

function buildRecommendations(final, location, opts = {}) {
  const heelish = (location || "").toLowerCase().includes("heel");
  const g = (t, items) => ({ t, items });
  const S = final.stage;
  const out = [];
  const stageCore = {
    NONE: ["압력 원인 제거 후 30분~1시간 내 피부 재확인", "예방 중재 지속, 발적 재발·지속 시 재사정"],
    "1": ["해당 부위 압력 완전 제거, 마찰·전단 보호", "매 근무조 피부 재평가, 악화 시 보고"],
    "2": ["생리식염수 등으로 부드럽게 세척", "습윤 창상 치유 환경 유지 (삼출물 양에 맞는 드레싱 분류 선택)"],
    "3": ["사강(dead space) 관리 고려, 괴사조직은 debridement 필요성 전문가 평가", "상처전문간호사(WOCN)·담당의 의뢰"],
    "4": ["노출된 심부 구조 건조 방지·보호, 골수염 등 심부 감염 가능성 담당의 평가 필수", "외과적 치료 필요성 협의, WOCN·담당의 의뢰"],
    U: [
      "괴사조직으로 기저부가 가려져 단계 확정 불가 — debridement 시행 여부와 방법은 환자의 관류 상태, 전반적 상태, 감염 여부, 치료 목표 및 기관/전문가 판단에 따라 결정",
      "발뒤꿈치(heel) 또는 허혈성 사지(ischemic limb)의 stable eschar — 건조하고, 단단히 부착되어 있으며, intact하고, 주변 홍반이나 fluctuation이 없는 경우 — 는 임의로 제거하지 않고 임상 상태를 평가하며 관찰 (NPIAP)",
      "상처전문간호사(WOCN)·담당의 의뢰, 기저부 확인이 가능해지면 재분류",
    ],
    DTPI: ["압력·전단 완전 제거, 병변 경계 표시·사진 기록", "매 근무조 재사정(급속 진행 가능), WOCN·담당의 조기 보고"],
    IAD: ["실금 원인 평가·관리, 순한 세정(문지르지 않기)과 피부 보호제 적용", "욕창 예방 병행, 호전 없으면 WOCN 의뢰"],
    ND: ["근무조 내 전문가(WOCN·담당의) 재사정 요청", "확인 전까지 예방 중재 전면 적용, 문서화로 변화 추적"],
  };
  if (stageCore[S]) out.push(g(`${stageLabel(S)} — 핵심 조치`, stageCore[S]));
  out.push(g("Pressure management", [
    "압력 재분배 및 지지면 적합성 확인",
    "환자 상태에 따른 개별화된 체위변경",
    heelish ? "발뒤꿈치 완전 부양(heel offloading)" : "발뒤꿈치 부양 등 뼈 돌출부 압력 최소화",
  ]));
  out.push(g("Skin & wound monitoring", [
    "크기·깊이 변화 추적 (F/U 사정으로 기록)",
    "색상 변화, 수포, 피부 파괴 진행 관찰",
    "통증 및 감각 변화 관찰",
  ]));
  out.push(g("Moisture & skin protection", [
    "습윤·오염(실금 포함) 관리",
    "주위 피부 상태 관찰 및 보호",
  ]));
  out.push(g("Nutrition", [
    "영양·수분 상태 확인, 필요 시 영양평가·영양팀 협의",
  ]));
  out.push(g("Escalation — 다음 변화 시 담당의·상처전문간호사 평가 고려", [
    "병변 확대 또는 색상 변화",
    "수포 발생, 통증 증가",
    "심부 조직 침범(deeper tissue involvement) 의심",
    "감염 의심 임상 변화 (발적 확산·열감·화농성 삼출물·발열)",
  ]));
  if (["1", "2"].includes(S)) out.push(g("경과 관찰", ["적절한 관리에도 2주 내 호전 없으면 재사정 및 WOCN 의뢰"]));
  return out;
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={"px-3 py-2 rounded-full border text-sm font-medium transition-colors " +
        (active ? "text-white border-transparent" : "bg-white text-slate-700 border-slate-300")}
      style={active ? { backgroundColor: "#0369A1" } : {}}>
      {children}
    </button>
  );
}

function Card({ children, className }) {
  return <div className={"bg-white rounded-2xl border border-slate-200 shadow-sm p-4 " + (className || "")}>{children}</div>;
}

function SectionTitle({ children }) {
  return <div className="text-sm font-bold text-slate-900 mb-2">{children}</div>;
}

function PrimaryBtn({ onClick, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-3 rounded-xl text-white text-base font-semibold disabled:opacity-40"
      style={{ backgroundColor: "#0369A1" }}>
      {children}
    </button>
  );
}

function GhostBtn({ onClick, children }) {
  return (
    <button onClick={onClick}
      className="w-full py-3 rounded-xl border border-slate-300 bg-white text-slate-700 text-base font-semibold">
      {children}
    </button>
  );
}

function StageBadge({ code }) {
  return (
    <span className="inline-block px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-900 text-xs font-bold">
      {stageLabel(code)}
    </span>
  );
}

function CheckRow({ done, label, hint, onClick }) {
  return (
    <button onClick={onClick} className="w-full flex items-start gap-2 text-left px-3 py-2.5 rounded-xl border border-slate-300 bg-white">
      <span className={"mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 " + (done ? "text-white border-transparent" : "border-slate-400 bg-white")} style={done ? { backgroundColor: "#047857" } : {}}>
        {done ? <Check size={12} /> : null}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-xs text-slate-500 mt-0.5">{hint}</span>}
      </span>
    </button>
  );
}

function PhotoQualityLine({ pq }) {
  if (!pq) return null;
  const issues = pq.issues || [];
  const st = pq.status || (pq.adequate === false || issues.length ? "CAUTION" : "PASS");
  if (st === "FAIL") return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 leading-relaxed">
      ⚠ Photo Quality: FAIL — 사진 품질이 충분하지 않습니다. 신뢰할 수 있는 욕창 사정을 위해 다시 촬영해주세요.{issues.length ? " (" + issues.join(" · ") + ")" : ""}
    </div>
  );
  if (st === "CAUTION") return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 leading-relaxed">
      ⚠ Photo Quality: CAUTION — 사진 품질에 일부 제한이 있습니다. 분석 결과 해석에 주의가 필요합니다.{issues.length ? " (" + issues.join(" · ") + ")" : ""}
    </div>
  );
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700">
      ✓ Photo Quality: PASS — 판독에 적합한 사진입니다.
    </div>
  );
}

function TriRow({ label, value, onChange, opts }) {
  const list = opts || [["yes", "있음"], ["no", "없음"], ["na", "판단 불가"]];
  const selColor = (v) => v === "na" || v === "none" ? "#475569" : v === "no" || v === "absent" ? "#047857" : "#B45309";
  return (
    <div className="px-3 py-2 rounded-xl border border-slate-300 bg-white">
      <div className="text-sm font-medium text-slate-800 mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map(([v, l]) => (
          <button key={v} onClick={() => onChange(value === v ? null : v)}
            className={"flex-1 py-1.5 px-1 rounded-lg border text-xs font-semibold " + (value === v ? "text-white" : "border-slate-300 bg-white text-slate-600")}
            style={value === v ? { backgroundColor: selColor(v), borderColor: "transparent", minWidth: 64 } : { minWidth: 64 }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

/* SizingPanel — 수동 실측 입력이 기본. 추후 ruler 자동 인식 결과를
   setSize({ lengthCm, widthCm, method: "auto-ruler" }) 형태로 주입하는 확장 지점. */
function SizingPanel({ size, setSize, areaCm2, onTouched, aiUsed }) {
  return (
    <Card>
      <SectionTitle>📏 Wound Measurement</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-xs text-slate-500 mb-1">Length (cm)</div>
          <input type="number" inputMode="decimal" step="0.1" value={size.lengthCm} onChange={(e) => { if (onTouched) onTouched(); setSize({ ...size, lengthCm: e.target.value }); }} className="w-full px-2 py-3 rounded-xl border border-slate-300 text-base text-center" />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Width (cm)</div>
          <input type="number" inputMode="decimal" step="0.1" value={size.widthCm} onChange={(e) => { if (onTouched) onTouched(); setSize({ ...size, widthCm: e.target.value }); }} className="w-full px-2 py-3 rounded-xl border border-slate-300 text-base text-center" />
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-1">Depth (cm)</div>
          <input type="number" inputMode="decimal" step="0.1" value={size.depthCm} onChange={(e) => setSize({ ...size, depthCm: e.target.value })} className="w-full px-2 py-3 rounded-xl border border-slate-300 text-base text-center" />
        </div>
      </div>
      <div className="flex items-center justify-between mt-3 text-sm">
        <span className="text-slate-600">Area (L×W)</span>
        <span className="font-bold text-slate-900">{areaCm2 != null ? `${areaCm2} cm²` : "—"}</span>
      </div>
      <div className="text-xs text-slate-500 mt-2 leading-relaxed">
        <p>· Length = wound의 가장 긴 축</p>
        <p>· Width = Length에 수직인 가장 넓은 축</p>
        <p>· Depth = 가장 깊은 지점의 임상 실측값 — 사진으로 추정하지 않습니다</p>
      </div>
      <div className="mt-3 space-y-2">
        <input value={size.undermining} onChange={(e) => setSize({ ...size, undermining: e.target.value })}
          placeholder="잠식(undermining) — 예: 12-2시 방향 2cm" className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm" />
        <input value={size.tunneling} onChange={(e) => setSize({ ...size, tunneling: e.target.value })}
          placeholder="터널(tunneling) — 예: 1시 방향 3cm" className="w-full px-3 py-2.5 rounded-xl border border-slate-300 text-sm" />
      </div>
      <p className="text-xs text-slate-500 mt-2">기록 표현: 길이 × 너비 × 깊이(cm). 잠식·터널은 시계 방향과 cm로 기록합니다. 측정값 출처: {size.method === "calibrated" ? (aiUsed ? "Ruler-assisted (마커 보정 · AI 제안 확인 후 사용)" : "Ruler-assisted (마커 보정)") : "실측값 직접 입력"}</p>
    </Card>
  );
}

function TargetRings({ points }) {
  if (!points || !points.length) return null;
  return (
    <>
      {points.map((p, i) => (
        <div key={"r" + i} className="absolute rounded-full pointer-events-none"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 46, height: 46, transform: "translate(-50%,-50%)", border: "3px solid #00B8D9", boxShadow: "0 0 0 2px rgba(255,255,255,0.95), inset 0 0 0 2px rgba(255,255,255,0.95)" }} />
      ))}
      {points.length > 1 && points.map((p, i) => (
        <div key={"n" + i} className="absolute pointer-events-none flex items-center justify-center text-white font-bold rounded-full"
          style={{ left: `calc(${p.x * 100}% + 21px)`, top: `calc(${p.y * 100}% - 21px)`, width: 20, height: 20, transform: "translate(-50%,-50%)", backgroundColor: "#00B8D9", fontSize: 11, boxShadow: "0 0 0 1.5px white" }}>{i + 1}</div>
      ))}
    </>
  );
}
function TargetRing({ point }) { return <TargetRings points={point ? [point] : []} />; }

function DisclaimerBox() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 leading-relaxed">
      {DISCLAIMER}
    </div>
  );
}

function BradenForm({ value, onChange }) {
  return (
    <div className="space-y-2">
      {BRADEN_ITEMS.map((it) => (
        <div key={it.k} className="flex items-center gap-2">
          <span className="flex-1 text-sm text-slate-700">{it.l}</span>
          <select value={value[it.k] == null ? "" : value[it.k]}
            onChange={(e) => onChange({ ...value, [it.k]: e.target.value === "" ? null : Number(e.target.value) })}
            className="px-2 py-2 rounded-lg border border-slate-300 bg-white text-sm" style={{ maxWidth: 190 }}>
            <option value="">선택</option>
            {it.opts.map((o, i) => <option key={i} value={i + 1}>{i + 1} · {o}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 측정 도구: 마커 캘리브레이션 기반 탭 측정                             */
/* ------------------------------------------------------------------ */
const MEASURE_STEPS = [
  { key: "calib", color: "#2563EB", guide: "① 사진 속 마커(자)의 양 끝 두 점을 탭하세요" },
  { key: "length", color: "#16A34A", guide: "② 길이: 머리(12시)→발끝(6시) 방향 최대 길이의 양 끝을 탭하세요" },
  { key: "width", color: "#EA580C", guide: "③ 너비: 길이와 직각(3시–9시) 방향 최대폭의 양 끝을 탭하세요" },
];

function MeasureTool({ photo, onLive, onCalib, initCalib, initMarkerCm, targets, aiMeasure, onAiApplied, onHumanMeasure }) {
  const nW = Math.max(1, (targets && targets.length) || 1);
  const emptyW = () => Array.from({ length: nW }, () => ({ length: [], width: [] }));
  const [markerCm, setMarkerCm] = useState(initMarkerCm || "1.0");
  const [calib, setCalib] = useState(Array.isArray(initCalib) && initCalib.length === 2 ? initCalib : []);
  const [wpts, setWpts] = useState(emptyW);
  const downRef = useRef(null);
  const boxRef = useRef(null);
  const dragRef = useRef(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState("");

  let cur = null;
  if (calib.length < 2) cur = { type: "calib" };
  else {
    for (let i = 0; i < nW && !cur; i++) {
      if (wpts[i] && wpts[i].length.length < 2) cur = { type: "length", wi: i };
      else if (wpts[i] && wpts[i].width.length < 2) cur = { type: "width", wi: i };
    }
  }

  const distPx = (pair) => Math.hypot((pair[0].x - pair[1].x) * photo.w, (pair[0].y - pair[1].y) * photo.h);
  const mk = parseFloat(markerCm);
  const pxPerCm = calib.length === 2 && mk > 0 ? distPx(calib) / mk : null;
  const vals = wpts.map((w) => ({
    lengthCm: pxPerCm && w.length.length === 2 ? fmt1(distPx(w.length) / pxPerCm) : null,
    widthCm: pxPerCm && w.width.length === 2 ? fmt1(distPx(w.width) / pxPerCm) : null,
  }));

  const valsSig = JSON.stringify(vals);
  useEffect(() => {
    if (vals.some((v) => v.lengthCm != null || v.widthCm != null)) onLive({ wounds: vals });
  }, [valsSig]);

  const calibSig = calib.length === 2 && mk > 0 ? JSON.stringify(calib) + "|" + markerCm : null;
  useEffect(() => {
    if (calibSig && onCalib) onCalib({ calib, markerCm });
  }, [calibSig]);

  const snapPerpTo = (L, anchor, p) => {
    const lx = (L[1].x - L[0].x) * photo.w, ly = (L[1].y - L[0].y) * photo.h;
    const llen = Math.hypot(lx, ly);
    if (!llen) return p;
    const ux = -ly / llen, uy = lx / llen;
    const ax = anchor.x * photo.w, ay = anchor.y * photo.h;
    const vx = p.x * photo.w - ax, vy = p.y * photo.h - ay;
    const t = vx * ux + vy * uy;
    return { x: Math.min(1, Math.max(0, (ax + t * ux) / photo.w)), y: Math.min(1, Math.max(0, (ay + t * uy) / photo.h)) };
  };

  const posFromEvent = (e) => {
    const rect = boxRef.current ? boxRef.current.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  };
  const startDrag = (e, kind, wi, axis, pi) => {
    e.stopPropagation(); e.preventDefault();
    dragRef.current = { kind, wi, axis, pi };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  };
  const moveDrag = (e) => {
    if (!dragRef.current) return;
    const p = posFromEvent(e);
    const d = dragRef.current;
    if (d.kind === "calib") { setCalib((c) => c.map((q, i) => (i === d.pi ? p : q))); return; }
    setWpts((ws) => {
      const n = ws.map((w) => ({ length: [...w.length], width: [...w.width] }));
      if (!n[d.wi] || n[d.wi][d.axis].length <= d.pi) return ws;
      n[d.wi][d.axis][d.pi] = p;
      if (n[d.wi].length.length === 2 && n[d.wi].width.length === 2) {
        n[d.wi].width = [n[d.wi].width[0], snapPerpTo(n[d.wi].length, n[d.wi].width[0], n[d.wi].width[1])];
      }
      return n;
    });
  };
  const endDrag = (e) => { e.stopPropagation(); dragRef.current = null; };

  const handleTap = (e) => {
    if (!cur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    let p = { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    if (cur.type === "calib") { setCalib((c) => [...c, p]); return; }
    if (onHumanMeasure) onHumanMeasure();
    setWpts((ws) => {
      const n = ws.map((w) => ({ length: [...w.length], width: [...w.width] }));
      if (cur.type === "width" && n[cur.wi].width.length === 1 && n[cur.wi].length.length === 2) {
        p = snapPerpTo(n[cur.wi].length, n[cur.wi].width[0], p);
      }
      n[cur.wi][cur.type].push(p);
      return n;
    });
  };
  const undo = () => {
    if (onHumanMeasure) onHumanMeasure();
    for (let i = nW - 1; i >= 0; i--) {
      if (wpts[i].width.length > 0) { setWpts((ws) => ws.map((w, j) => j === i ? { ...w, width: w.width.slice(0, -1) } : w)); return; }
      if (wpts[i].length.length > 0) { setWpts((ws) => ws.map((w, j) => j === i ? { ...w, length: w.length.slice(0, -1) } : w)); return; }
    }
    if (calib.length > 0) setCalib((c) => c.slice(0, -1));
  };
  const reset = () => { setCalib([]); setWpts(emptyW()); setAiNote(""); if (onHumanMeasure) onHumanMeasure(); };

  const runAiMeasure = async () => {
    if (!aiMeasure || pxPerCm == null) return;
    setAiBusy(true); setAiNote("");
    try {
      const r = await aiMeasure();
      const clamp = (p) => ({ x: Math.min(1, Math.max(0, Number(p.x) || 0)), y: Math.min(1, Math.max(0, Number(p.y) || 0)) });
      if (r && r.scaleVisible === false) {
        setAiNote("Scale(자·마커)을 인식할 수 없습니다 — 실측값을 입력해주세요. 상단에서 Manual 모드로 전환하거나, 마커가 사진에 나오도록 다시 촬영하세요.");
        setAiBusy(false);
        return;
      }
      let arr = null;
      if (r && Array.isArray(r.wounds)) arr = r.wounds;
      else if (r && r.found && Array.isArray(r.length) && Array.isArray(r.width)) arr = [{ index: 1, length: r.length, width: r.width }];
      let applied = 0;
      if (arr && arr.length) {
        setWpts((ws) => {
          const n = ws.map((w) => ({ length: [...w.length], width: [...w.width] }));
          arr.forEach((it) => {
            const i = (Number(it.index) || 1) - 1;
            if (i < 0 || i >= nW) return;
            if (Array.isArray(it.length) && it.length.length === 2 && Array.isArray(it.width) && it.width.length === 2) {
              const L = it.length.map(clamp);
              let W = it.width.map(clamp);
              W = [W[0], snapPerpTo(L, W[0], W[1])];
              n[i] = { length: L, width: W };
              applied++;
            }
          });
          return n;
        });
      }
      if (applied > 0 && onAiApplied) onAiApplied();
      if (applied > 0 || (arr && arr.length)) {
        setAiNote((nW > 1 ? "AI가 상처별 측정선을 제안했습니다" : "AI가 제안한 측정선입니다") + " — 각 선이 상처 축과 일치하는지 확인하고, 어긋난 끝점은 손가락으로 끌어서 조정하세요. 확인이 끝나면 아래 [측정값 확인 완료]를 눌러 확정하세요." + (r && r.note ? " (" + r.note + ")" : ""));
      } else {
        setAiNote("AI가 상처 경계를 확신하지 못했습니다" + (r && r.note ? " — " + r.note : "") + ". 직접 탭해서 측정하거나 실측값을 입력해주세요.");
      }
    } catch (e) {
      setAiNote("AI 측정에 실패했습니다. 직접 탭해서 측정하거나 실측값을 입력해주세요.");
    }
    setAiBusy(false);
  };

  const mid = (pair) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const guideText = !cur ? "측정 완료 — 아래 입력란에 자동 반영되었습니다. 점을 끌어 옮기면 즉시 다시 계산됩니다."
    : cur.type === "calib" ? MEASURE_STEPS[0].guide
    : cur.type === "length" ? `${nW > 1 ? `상처 ${CIRC[cur.wi]} ` : ""}길이: 머리(12시)→발끝(6시) 방향 최대 길이의 양 끝을 탭하세요`
    : `${nW > 1 ? `상처 ${CIRC[cur.wi]} ` : ""}너비: 길이와 직각 방향 최대폭의 양 끝을 탭하세요`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-700 font-medium">마커 실제 길이</span>
        <input type="number" inputMode="decimal" step="0.1" value={markerCm}
          onChange={(e) => setMarkerCm(e.target.value)}
          className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 text-base text-right" />
        <span className="text-slate-500">cm</span>
      </div>
      <div ref={boxRef} className="relative rounded-xl overflow-hidden border border-slate-300 select-none"
        onPointerDown={(e) => { downRef.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          if (dragRef.current) { dragRef.current = null; downRef.current = null; return; }
          const s = downRef.current; downRef.current = null;
          if (!s || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) return;
          handleTap(e);
        }}
        style={{ touchAction: "manipulation", cursor: "crosshair" }}>
        <img src={photo.dataUrl} alt="wound" className="w-full block" draggable={false} />
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${photo.w} ${photo.h}`} preserveAspectRatio="none" style={{ pointerEvents: "none" }}>
          {calib.length === 2 && (
            <line x1={calib[0].x * photo.w} y1={calib[0].y * photo.h} x2={calib[1].x * photo.w} y2={calib[1].y * photo.h}
              stroke="#2563EB" strokeWidth="3" vectorEffect="non-scaling-stroke" />
          )}
          {wpts.map((w, i) => (
            <g key={i}>
              {w.length.length === 2 && <line x1={w.length[0].x * photo.w} y1={w.length[0].y * photo.h} x2={w.length[1].x * photo.w} y2={w.length[1].y * photo.h} stroke="#16A34A" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
              {w.width.length === 2 && <line x1={w.width[0].x * photo.w} y1={w.width[0].y * photo.h} x2={w.width[1].x * photo.w} y2={w.width[1].y * photo.h} stroke="#EA580C" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
            </g>
          ))}
        </svg>
        {calib.map((p, i) => (
          <div key={"c" + i} className="absolute flex items-center justify-center"
            onPointerDown={(e) => startDrag(e, "calib", 0, null, i)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: "translate(-50%,-50%)", width: 30, height: 30, touchAction: "none", cursor: "grab" }}>
            <div className="rounded-full border-2 border-white" style={{ width: 13, height: 13, backgroundColor: "#2563EB" }} />
          </div>
        ))}
        {wpts.map((w, i) => (
          <React.Fragment key={"wp" + i}>
            {w.length.map((p, j) => (
              <div key={"l" + j} className="absolute flex items-center justify-center"
                onPointerDown={(e) => startDrag(e, "wound", i, "length", j)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: "translate(-50%,-50%)", width: 30, height: 30, touchAction: "none", cursor: "grab" }}>
                <div className="rounded-full border-2 border-white" style={{ width: 13, height: 13, backgroundColor: "#16A34A" }} />
              </div>
            ))}
            {w.width.map((p, j) => (
              <div key={"w" + j} className="absolute flex items-center justify-center"
                onPointerDown={(e) => startDrag(e, "wound", i, "width", j)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: "translate(-50%,-50%)", width: 30, height: 30, touchAction: "none", cursor: "grab" }}>
                <div className="rounded-full border-2 border-white" style={{ width: 13, height: 13, backgroundColor: "#EA580C" }} />
              </div>
            ))}
            {w.length.length === 2 && vals[i].lengthCm != null && (
              <div className="absolute px-1.5 py-0.5 rounded text-white font-bold"
                style={{ left: `${mid(w.length).x * 100}%`, top: `${mid(w.length).y * 100}%`, transform: "translate(-50%,-150%)", backgroundColor: "#16A34A", pointerEvents: "none", fontSize: 11 }}>
                {nW > 1 ? `${CIRC[i]} ` : ""}{vals[i].lengthCm} cm
              </div>
            )}
            {w.width.length === 2 && vals[i].widthCm != null && (
              <div className="absolute px-1.5 py-0.5 rounded text-white font-bold"
                style={{ left: `${mid(w.width).x * 100}%`, top: `${mid(w.width).y * 100}%`, transform: "translate(-50%,-150%)", backgroundColor: "#EA580C", pointerEvents: "none", fontSize: 11 }}>
                {nW > 1 ? `${CIRC[i]} ` : ""}{vals[i].widthCm} cm
              </div>
            )}
          </React.Fragment>
        ))}
        {calib.length === 2 && mk > 0 && (
          <div className="absolute px-1.5 py-0.5 rounded text-white font-bold"
            style={{ left: `${mid(calib).x * 100}%`, top: `${mid(calib).y * 100}%`, transform: "translate(-50%,-150%)", backgroundColor: "#2563EB", pointerEvents: "none", fontSize: 11 }}>
            {mk} cm
          </div>
        )}
        {targets && targets.length ? <TargetRings points={targets} /> : null}
      </div>
      <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800 font-medium">{guideText}</div>
      {aiMeasure && pxPerCm != null && (
        <button onClick={runAiMeasure} disabled={aiBusy}
          className="w-full py-2.5 rounded-lg text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50"
          style={{ backgroundColor: "#0369A1" }}>
          <Sparkles size={15} /> {aiBusy ? "AI가 측정선을 잡는 중…" : nW > 1 ? `AI 자동 측정 — 상처 ${nW}개 축 한 번에 제안` : "AI 자동 측정 — 길이·너비 축 자동 제안"}
        </button>
      )}
      {aiNote && <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 leading-relaxed">{aiNote}</div>}
      <div className="space-y-0.5">
        {vals.map((v, i) => (
          <div key={i} className="flex items-center gap-3 text-sm font-semibold">
            {nW > 1 && <span style={{ color: "#00B8D9" }}>{CIRC[i]}</span>}
            <span style={{ color: "#16A34A" }}>길이 {v.lengthCm != null ? `${v.lengthCm} cm` : "—"}</span>
            <span style={{ color: "#EA580C" }}>너비 {v.widthCm != null ? `${v.widthCm} cm` : "—"}</span>
          </div>
        ))}
        <div className="text-slate-400 font-normal" style={{ fontSize: 11 }}>너비는 길이 축에 자동 수직 보정</div>
      </div>
      <div className="flex gap-2">
        <button onClick={undo} className="flex-1 py-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">한 점 취소</button>
        <button onClick={reset} className="flex-1 py-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">전체 초기화</button>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">정의: Length = 머리–발끝(12→6시) 방향 최대 길이 · Width = Length에 수직(3–9시) 최대 폭. 마커와 상처가 같은 평면에 있고 카메라가 수직일수록 정확합니다. 각도가 기울면 오차가 커집니다. 찍힌 점은 끌어서(드래그) 미세 조정할 수 있습니다.{Array.isArray(initCalib) && initCalib.length === 2 ? " 이전 상처의 마커 캘리브레이션을 재사용 중입니다 — 다시 지정하려면 전체 초기화하세요." : ""}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 새 사정 위저드                                                       */
/* ------------------------------------------------------------------ */
const emptyFinal = () => ({
  stage: "ND",
  blanching: null,
  iadCheck: null,
  woundBed: { types: [], predominant: null },
  exudateAmount: null, exudateType: null,
  periwound: [],
  edge: null,
  overrideReason: null,
  clinChecks: {},
  infection: { odor: "None", warmth: false, pain: false, purulent: false, fever: false },
  memo: "",
});

function NewAssessment({ idx, initFollowWoundId, onSaved, onIdxUpdate, onCancel }) {
  const initWound = initFollowWoundId && idx.wounds[initFollowWoundId] ? idx.wounds[initFollowWoundId] : null;
  const [step, setStep] = useState(1);
  const [pid, setPid] = useState(initWound ? initWound.patientId : "");
  const [demo, setDemo] = useState({ ward: "", room: "", sex: "", age: "" });
  const [mode, setMode] = useState(initWound ? "follow" : "new"); // new | follow
  const [selWoundId, setSelWoundId] = useState(initWound ? initWound.id : null);
  const [location, setLocation] = useState(null);
  const [locationSub, setLocationSub] = useState("");
  const [assessDate, setAssessDate] = useState(dateToInput(new Date()));

  const [photo, setPhoto] = useState(null);
  const [quality, setQuality] = useState(null);
  const [photoErr, setPhotoErr] = useState("");
  const [refPhoto, setRefPhoto] = useState(null);
  const [multiWound, setMultiWound] = useState(false);
  const [targets, setTargets] = useState([]);
  const [calibCarry, setCalibCarry] = useState(null);
  const [savedFlash, setSavedFlash] = useState("");
  const tapRef = useRef(null);
  const [prevFinal, setPrevFinal] = useState(null);
  const [quickMode, setQuickMode] = useState(false);
  const [aiBatch, setAiBatch] = useState(null);
  const [batchStatus, setBatchStatus] = useState("idle");
  const [batchErr, setBatchErr] = useState("");
  const [batchStages, setBatchStages] = useState([]);
  const [batchMemo, setBatchMemo] = useState("");
  const [batchSizes, setBatchSizes] = useState([]);
  const [batchProg, setBatchProg] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [measureMode, setMeasureMode] = useState("manual");
  const [aiMeasurePending, setAiMeasurePending] = useState(false);
  const [aiMeasureUsed, setAiMeasureUsed] = useState(false);
  const [size, setSize] = useState({ lengthCm: "", widthCm: "", depthCm: "", undermining: "", tunneling: "", method: "manual" });

  const [ai, setAi] = useState(null);
  const [aiStatus, setAiStatus] = useState("idle"); // idle|loading|done|error
  const [aiErr, setAiErr] = useState("");
  const [aiApplied, setAiApplied] = useState(false);

  const [final, setFinal] = useState(emptyFinal());
  const [braden, setBraden] = useState(emptyBraden());
  const [showBraden, setShowBraden] = useState(false);
  const [blanchModal, setBlanchModal] = useState(false);
  const [iadModal, setIadModal] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [deeperChecked, setDeeperChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const existing = idx.patients[pid.trim()];
  const patientWounds = Object.values(idx.wounds).filter((w) => w.patientId === pid.trim());

  useEffect(() => {
    if (existing) setDemo({ ward: existing.ward || "", room: existing.room || "", sex: existing.sex || "", age: existing.age || "" });
  }, [pid]);

  // follow-up 시 이전 사진 참고 로드
  useEffect(() => {
    (async () => {
      setRefPhoto(null);
      if (step === 2 && mode === "follow" && selWoundId) {
        const w = idx.wounds[selWoundId];
        if (!w) return;
        const ids = [...(w.assessmentIds || [])].reverse();
        for (const aid of ids) {
          if (idx.assess[aid]) {
            const full = await loadFull(aid);
            if (full && full.photo) { setRefPhoto(full.photo.dataUrl); break; }
          }
        }
      }
    })();
  }, [step, mode, selWoundId]);

  const effLocation = mode === "follow" && selWoundId ? (idx.wounds[selWoundId] || {}).location : location;
  const targetPoint = multiWound && targets.length === 1 ? targets[0] : null;
  const batch = multiWound && targets.length >= 2;

  useEffect(() => {
    if (!batch) return;
    setBatchSizes((prev) => Array.from({ length: targets.length }, (_, i) => prev[i] || { lengthCm: "", widthCm: "", depthCm: "", location: location || "Sacrum" }));
  }, [batch, targets.length]);

  const handleFile = async (file) => {
    if (!file) { setPhotoErr("파일이 선택되지 않았습니다. 다시 시도해주세요."); return; }
    setPhotoErr("");
    if (file.type && !file.type.startsWith("image/")) {
      setPhotoErr("이미지 파일이 아닙니다. 사진 파일(JPG, PNG)을 선택해주세요.");
      return;
    }
    try {
      const p = await fileToResizedDataUrl(file);
      setPhoto(p);
      setQuality(await checkImageQuality(p.dataUrl));
      setAi(null); setAiStatus("idle"); setAiApplied(false);
      setMultiWound(false); setTargets([]);
      setPrevFinal(null); setQuickMode(false);
      setAiBatch(null); setBatchStatus("idle"); setBatchErr(""); setBatchStages([]); setBatchMemo(""); setBatchSizes([]);
      setMeasureMode("manual");
      setAiMeasurePending(false); setAiMeasureUsed(false);
    } catch (e) {
      const isHeic = /heic|heif/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
      setPhotoErr(isHeic
        ? "HEIC 형식 사진은 이 브라우저에서 열 수 없습니다. 휴대폰 카메라 설정을 '높은 호환성(JPEG)'으로 바꾸거나, 갤러리에서 JPG로 저장·공유한 뒤 다시 선택해주세요."
        : "사진을 불러오지 못했습니다 (" + (e.message || "알 수 없는 오류") + "). 파일 형식(JPG/PNG)을 확인하고 다시 선택해주세요.");
    }
  };

  const onFileInput = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    handleFile(f);
  };
  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(f);
  };
  useEffect(() => {
    if (step !== 2 || photo) return;
    const onPaste = (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { handleFile(f); break; }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [step, photo]);

  const aiMeasureFn = async () => {
    const list = multiWound ? targets : [];
    const src = list.length ? await annotateTargets(photo, list) : photo.dataUrl;
    return aiMeasureAxes(src, { multiTarget: list.length === 1, multiCount: list.length >= 2 ? list.length : 0 });
  };

  const runAi = async () => {
    if (!photo) return;
    setAiStatus("loading"); setAiErr("");
    try {
      const src = multiWound && targetPoint ? await annotateTargets(photo, [targetPoint]) : photo.dataUrl;
      const aiImages = (mode === "follow") ? (refPhoto ? [refPhoto, src] : [src]) : src;
      const r = await analyzeWoundImage(aiImages, {
        location: effLocation,
        lengthCm: size.lengthCm || null, widthCm: size.widthCm || null, depthCm: size.depthCm || null,
        multiTarget: !!(multiWound && targetPoint),
        followUpCompare: mode === "follow" && !!refPhoto,
      });
      setAi(r); setAiStatus("done");
      if (r && r.canAssess !== false && r.blanchingCheckNeeded) setBlanchModal(true);
      else if (r && r.canAssess !== false && r.iadCheckNeeded) {
        setFinal((f) => f.iadCheck ? f : { ...f, iadCheck: { moisture: null, diffuse: null, unclear: null, necrosis: null } });
        setIadModal(true);
      }
    } catch (e) { setAiErr(e.message || "오류"); setAiStatus("error"); }
  };

  const runBatchAi = async () => {
    if (!photo) return;
    setBatchStatus("loading"); setBatchErr(""); setBatchProg(0);
    try {
      const ws = await runPool(targets, 2, async (pt, i) => {
        const b = batchSizes[i] || {};
        try {
          const full = await annotateTargets(photo, [pt]);
          const crop = await cropAround(photo, pt);
          const r = await analyzeWoundImage([full, crop], {
            location: b.location || null,
            lengthCm: b.lengthCm || null, widthCm: b.widthCm || null, depthCm: b.depthCm || null,
            multiTarget: true, zoomHint: true,
          });
          setBatchProg((n) => n + 1);
          return { index: i + 1, ok: true, ...r };
        } catch (e) {
          setBatchProg((n) => n + 1);
          return { index: i + 1, ok: false, error: e.message || "오류" };
        }
      });
      if (!ws.some((w) => w.ok)) throw new Error(ws[0] && ws[0].error ? ws[0].error : "모든 상처 분석 실패");
      setAiBatch({ wounds: ws });
      setBatchStages(ws.map((w) => mapAiStage(w.ok && w.canAssess !== false ? w.suggestedStage : "미정")));
      setBatchStatus("done");
    } catch (e) { setBatchErr(e.message || "오류"); setBatchStatus("error"); }
  };

  const saveBatch = async () => {
    setSaving(true); setBatchErr("");
    try {
      const now = new Date();
      let dt = now;
      if (assessDate) {
        const t = new Date(assessDate + "T" + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":00");
        if (!isNaN(t.getTime())) dt = t;
      }
      const nIdx = JSON.parse(JSON.stringify(idx));
      nIdx.patients[pid.trim()] = { id: pid.trim(), ...demo };
      const baseT = Date.now();
      const recs = [];
      let firstWid = null;
      targets.forEach((pt, i) => {
        const b = batchSizes[i] || {};
        const w0 = aiBatch && aiBatch.wounds ? (aiBatch.wounds.find((x) => Number(x.index) === i + 1) || aiBatch.wounds[i]) : null;
        const w = w0 && w0.ok !== false && w0.canAssess !== false ? w0 : null;
        const wid = "w" + (baseT + i);
        const aid = "a" + (baseT + i);
        if (!firstWid) firstWid = wid;
        const stage = batchStages[i] || "ND";
        const L = b.lengthCm ? parseFloat(b.lengthCm) : null;
        const Wd = b.widthCm ? parseFloat(b.widthCm) : null;
        const D = b.depthCm ? parseFloat(b.depthCm) : null;
        const fin = {
          ...emptyFinal(),
          stage,
          woundBed: w && w.woundBed && Array.isArray(w.woundBed.present) ? {
            types: w.woundBed.present.filter((t) => WB_KEYS.some((k) => k.k === t)),
            predominant: WB_KEYS.some((k) => k.k === w.woundBed.predominant) ? w.woundBed.predominant : null,
          } : { types: [], predominant: null },
          exudateAmount: w && w.exudate && w.exudate.amount ? w.exudate.amount : null,
          exudateType: w && w.exudate && w.exudate.type ? w.exudate.type : null,
          periwound: w && Array.isArray(w.periwound) ? w.periwound.filter((p) => PERIWOUND.includes(p)) : [],
          edge: w && (w.edge === "present" || w.edge === "absent") ? w.edge : null,
          memo: batchMemo,
        };
        let aiRec = null;
        if (w && w.ok !== false) {
          const rest = { ...w };
          delete rest.index; delete rest.ok; delete rest.error;
          aiRec = rest;
        }
        const rec = {
          id: aid, woundId: wid, patientId: pid.trim(),
          location: b.location || "Other", date: dt.toISOString(),
          photo, quality,
          size: { lengthCm: L, widthCm: Wd, depthCm: D, undermining: null, tunneling: null, areaCm2: L && Wd ? fmt1(L * Wd) : null, method: "calibrated", aiAssisted: aiMeasureUsed },
          braden: bradenTotal(braden) != null ? { scores: braden, total: bradenTotal(braden) } : null,
          clinicalChecks: { depth: !!D, deeperStructure: false, blanching: false, iad: false },
          target: pt, targets: [pt], batch: true, quick: false,
          aiSuggestedStage: w ? mapAiStage(w.suggestedStage) : null,
          clinicianFinalStage: stage,
          ai: aiRec, final: fin,
        };
        nIdx.wounds[wid] = { id: wid, patientId: pid.trim(), location: rec.location, sub: CIRC[i], createdAt: rec.date, assessmentIds: [aid] };
        nIdx.assess[aid] = { id: aid, woundId: wid, date: rec.date, stage, aiStage: rec.aiSuggestedStage, lengthCm: L, widthCm: Wd, areaCm2: rec.size.areaCm2, hasPhoto: true };
        recs.push(rec);
      });
      for (const r of recs) await saveFull(r);
      await saveIndex(nIdx);
      onSaved(nIdx, firstWid);
    } catch (e) {
      setBatchErr("저장에 실패했습니다: " + (e.message || "알 수 없는 오류"));
      setSaving(false);
    }
  };

  const aiNonStage = (f) => {
    const present = ai.woundBed && Array.isArray(ai.woundBed.present) ? ai.woundBed.present : null;
    const hasEpi = present ? present.includes("epithelial") : false;
    return {
      woundBed: present ? {
        types: present.filter((t) => WB_KEYS.some((w) => w.k === t)),
        predominant: WB_KEYS.some((w) => w.k === ai.woundBed.predominant) ? ai.woundBed.predominant : null,
      } : f.woundBed,
      edge: ai.edge === "present" || ai.edge === "absent" ? ai.edge : (hasEpi ? "present" : f.edge),
      exudateAmount: ai.exudate && ai.exudate.amount ? ai.exudate.amount : f.exudateAmount,
      exudateType: ai.exudate && ai.exudate.type ? ai.exudate.type : f.exudateType,
      periwound: Array.isArray(ai.periwound) ? ai.periwound.filter((p) => PERIWOUND.includes(p)) : f.periwound,
    };
  };

  const applyAi = () => {
    if (!ai) return;
    let stage = mapAiStage(ai.suggestedStage);
    if (final.blanching === "blanch" && ["1", "ND"].includes(stage)) stage = "NONE";
    else if (final.blanching === "nonblanch" && stage === "ND" && ai.blanchingCheckNeeded) stage = "1";
    setFinal((f) => ({ ...f, stage, ...aiNonStage(f) }));
    setAiApplied(true);
    setStep(5);
  };

  const applyAiExceptStage = () => {
    if (!ai) { setStep(5); return; }
    setFinal((f) => ({ ...f, ...aiNonStage(f) }));
    setAiApplied(true);
    setStep(5);
  };

  const areaCm2 = size.lengthCm && size.widthCm ? fmt1(parseFloat(size.lengthCm) * parseFloat(size.widthCm)) : null;

  const canNext1 = pid.trim() && (mode === "follow" ? selWoundId : location);
  const infFlag = infectionFlag(final);

  const toggleWb = (k) => setFinal((f) => {
    const has = f.woundBed.types.includes(k);
    const types = has ? f.woundBed.types.filter((x) => x !== k) : [...f.woundBed.types, k];
    let predominant = f.woundBed.predominant;
    if (has && predominant === k) predominant = null;
    if (types.length === 1) predominant = types[0];
    if (!types.length) predominant = null;
    return { ...f, woundBed: { types, predominant } };
  });

  const openIad = () => {
    if (!final.iadCheck) setFinal((f) => ({ ...f, iadCheck: { moisture: null, diffuse: null, unclear: null, necrosis: null } }));
    setIadModal(true);
  };
  const iadVerdict = iadVerdictFrom(final.iadCheck);

  const buildRecord = () => {
    const now = new Date();
    let dt = now;
    if (assessDate) {
      const t = new Date(assessDate + "T" + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":00");
      if (!isNaN(t.getTime())) dt = t;
    }
    return {
      id: "a" + Date.now(),
      woundId: mode === "follow" ? selWoundId : "w" + Date.now(),
      patientId: pid.trim(),
      location: effLocation,
      date: dt.toISOString(),
      photo,
      quality,
      size: {
        lengthCm: size.lengthCm ? parseFloat(size.lengthCm) : null,
        widthCm: size.widthCm ? parseFloat(size.widthCm) : null,
        depthCm: size.depthCm ? parseFloat(size.depthCm) : null,
        undermining: size.undermining.trim() || null,
        tunneling: size.tunneling.trim() || null,
        areaCm2, method: size.method, aiAssisted: aiMeasureUsed,
      },
      braden: bradenTotal(braden) != null ? { scores: braden, total: bradenTotal(braden) } : null,
      clinicalChecks: {
        depth: !!size.depthCm,
        deeperStructure: deeperChecked,
        blanching: final.blanching != null,
        iad: iadVerdictFrom(final.iadCheck) != null,
      },
      target: targets.length === 1 ? targets[0] : null,
      targets: multiWound && targets.length ? targets : null,
      quick: quickMode,
      aiSuggestedStage: ai && ai.canAssess !== false ? mapAiStage(ai.suggestedStage) : null,
      clinicianFinalStage: final.stage,
      ai, final,
    };
  };

  const resetForNextWound = () => {
    setMode("new"); setSelWoundId(null); setLocation(null); setLocationSub("");
    setSize({ lengthCm: "", widthCm: "", depthCm: "", undermining: "", tunneling: "", method: "manual" });
    setAi(null); setAiStatus("idle"); setAiErr(""); setAiApplied(false);
    setFinal(emptyFinal());
    setDeeperChecked(false);
    setTargets([]);
    setQuickMode(false);
    setMeasureMode("manual");
    setAiMeasurePending(false); setAiMeasureUsed(false);
    setSaveErr("");
    setSavedFlash("이전 상처가 저장되었습니다. 같은 사진으로 다음 상처를 사정합니다 — 부위를 선택하세요.");
    setTimeout(() => setSavedFlash(""), 6000);
    setStep(1);
  };

  const save = async (next) => {
    setSaving(true); setSaveErr("");
    try {
      const rec = buildRecord();
      const nIdx = JSON.parse(JSON.stringify(idx));
      nIdx.patients[rec.patientId] = { id: rec.patientId, ...demo };
      if (!nIdx.wounds[rec.woundId]) {
        nIdx.wounds[rec.woundId] = { id: rec.woundId, patientId: rec.patientId, location: rec.location, sub: locationSub.trim() || null, createdAt: rec.date, assessmentIds: [] };
      }
      nIdx.wounds[rec.woundId].assessmentIds.push(rec.id);
      nIdx.assess[rec.id] = {
        id: rec.id, woundId: rec.woundId, date: rec.date, stage: final.stage, aiStage: rec.aiSuggestedStage,
        lengthCm: rec.size.lengthCm, widthCm: rec.size.widthCm, areaCm2: rec.size.areaCm2,
        hasPhoto: !!photo,
      };
      await saveFull(rec);
      await saveIndex(nIdx);
      if (next) {
        if (onIdxUpdate) onIdxUpdate(nIdx);
        setPrevFinal(JSON.parse(JSON.stringify(final)));
        setSaving(false);
        resetForNextWound();
      } else {
        onSaved(nIdx, rec.woundId);
      }
    } catch (e) {
      setSaveErr("저장에 실패했습니다: " + (e.message || "알 수 없는 오류") + ". 잠시 후 다시 시도해주세요.");
      setSaving(false);
    }
  };

  const StepDots = () => (
    <div className="flex gap-1.5 justify-center py-2">
      {[1, 2, 3, 4, 5, 6].map((s) => (
        <div key={s} className="w-2 h-2 rounded-full" style={{ backgroundColor: s === step ? "#0369A1" : s < step ? "#7DD3FC" : "#CBD5E1" }} />
      ))}
    </div>
  );

  return (
    <div className="pb-28">
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center px-3 py-3 gap-2">
          <button onClick={() => (step > 1 ? setStep(step - 1) : onCancel())} className="p-2 rounded-lg bg-white border border-slate-300">
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="text-base font-bold text-slate-900">새 욕창 사정</div>
            <div className="text-xs text-slate-500">
              {step === 1 && "1단계 · 환자 정보 및 부위"}
              {step === 2 && "2단계 · 사진 촬영"}
              {step === 3 && "3단계 · 크기 측정"}
              {step === 4 && (batch ? "4단계 · AI 일괄 분석 · 저장" : "4단계 · AI 분석")}
              {step === 5 && "5단계 · 사정 확인·수정"}
              {step === 6 && "6단계 · 요약 및 저장"}
            </div>
          </div>
          <button onClick={onCancel} className="p-2 rounded-lg bg-white border border-slate-300"><X size={18} /></button>
        </div>
        <StepDots />
      </div>

      <div className="p-4 space-y-4">
        {/* ---------------- Step 1 ---------------- */}
        {step === 1 && (
          <>
            {savedFlash && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{savedFlash}</div>
            )}
            {prevFinal && (
              <Card>
                <SectionTitle>사정 방식</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  <Chip active={!quickMode} onClick={() => { if (quickMode) setFinal(emptyFinal()); setQuickMode(false); }}>일반 사정</Chip>
                  <Chip active={quickMode} onClick={() => {
                    setQuickMode(true);
                    setFinal({ ...JSON.parse(JSON.stringify(prevFinal)), blanching: null, iadCheck: null, overrideReason: null, clinChecks: {} });
                  }}>빠른 사정 — 이전 상처 사정 복사</Chip>
                </div>
                {quickMode && (
                  <p className="text-xs text-amber-700 mt-2 leading-relaxed">이전 상처의 사정({stageLabel(prevFinal.stage)}, wound bed·삼출물 등)을 복사하고 AI 분석·상세 사정 단계를 건너뜁니다. 크기만 새로 측정하며, 요약 화면에서 이 상처에도 동일한지 반드시 확인하세요.</p>
                )}
              </Card>
            )}
            <Card>
              <SectionTitle>Patient ID</SectionTitle>
              <input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="예: T-0042"
                className="w-full px-3 py-3 rounded-xl border border-slate-300 text-base" />
              <p className="text-xs text-slate-500 mt-2">개인정보 보호를 위해 실제 병원등록번호 대신 테스트용 임의 ID 사용을 권장합니다. 환자 이름은 저장하지 않습니다.</p>
            </Card>
            <Card>
              <SectionTitle>사정 일자</SectionTitle>
              <input type="date" value={assessDate} onChange={(e) => setAssessDate(e.target.value)}
                className="w-full px-3 py-3 rounded-xl border border-slate-300 text-base bg-white" />
              <p className="text-xs text-slate-500 mt-1.5">기본값은 오늘입니다. 어제 관찰한 내용을 지금 기록하려면 날짜를 바꾸세요 — trend와 비교는 이 날짜 기준으로 정렬됩니다.</p>
            </Card>
            <Card>
              <SectionTitle>기본 정보</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                <input value={demo.ward} onChange={(e) => setDemo({ ...demo, ward: e.target.value })} placeholder="병동" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
                <input value={demo.room} onChange={(e) => setDemo({ ...demo, room: e.target.value })} placeholder="병실" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
                <select value={demo.sex} onChange={(e) => setDemo({ ...demo, sex: e.target.value })} className="px-3 py-3 rounded-xl border border-slate-300 text-base bg-white">
                  <option value="">성별</option><option value="남">남</option><option value="여">여</option>
                </select>
                <input value={demo.age} onChange={(e) => setDemo({ ...demo, age: e.target.value })} placeholder="연령" type="number" inputMode="numeric" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
              </div>
            </Card>
            {existing && patientWounds.length > 0 && (
              <Card>
                <SectionTitle>기존 욕창 follow-up</SectionTitle>
                <div className="space-y-2">
                  {patientWounds.map((w) => (
                    <button key={w.id}
                      onClick={() => { setMode("follow"); setSelWoundId(w.id); }}
                      className={"w-full text-left px-3 py-3 rounded-xl border " + (mode === "follow" && selWoundId === w.id ? "border-transparent" : "border-slate-300 bg-white")}
                      style={mode === "follow" && selWoundId === w.id ? { backgroundColor: "#E0F2FE", borderColor: "#0369A1", borderWidth: 1, borderStyle: "solid" } : {}}>
                      <div className="font-semibold text-slate-900 text-sm">{w.location}{w.sub ? ` (${w.sub})` : ""}</div>
                      <div className="text-xs text-slate-500">사정 {(w.assessmentIds || []).length}회 · 시작 {dateShort(w.createdAt)}</div>
                    </button>
                  ))}
                  <button onClick={() => { setMode("new"); setSelWoundId(null); }}
                    className={"w-full px-3 py-3 rounded-xl border text-sm font-semibold " + (mode === "new" ? "border-transparent" : "border-slate-300 bg-white text-slate-700")}
                    style={mode === "new" ? { backgroundColor: "#E0F2FE", color: "#075985", borderColor: "#0369A1", borderWidth: 1, borderStyle: "solid" } : {}}>
                    + 새 부위 사정
                  </button>
                </div>
              </Card>
            )}
            {mode === "new" && (
              <Card>
                <SectionTitle>욕창 위치</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {LOCATIONS.map((l) => (
                    <Chip key={l} active={location === l} onClick={() => setLocation(l)}>{l}</Chip>
                  ))}
                </div>
                <input value={locationSub} onChange={(e) => setLocationSub(e.target.value)}
                  placeholder="세부 위치 메모 (선택) — 예: 좌측, 상부, 2시 방향"
                  className="w-full mt-3 px-3 py-2.5 rounded-xl border border-slate-300 text-sm" />
                <p className="text-xs text-slate-500 mt-1.5">같은 부위에 상처가 여러 개면 세부 위치로 구분해두면 follow-up 시 혼동이 없습니다.</p>
              </Card>
            )}
            <Card>
              <button onClick={() => setShowBraden(!showBraden)} className="w-full flex items-center justify-between">
                <span className="text-sm font-bold text-slate-900">Braden Scale (선택)</span>
                <span className="text-xs font-semibold" style={{ color: "#0369A1" }}>
                  {bradenTotal(braden) != null ? `${bradenTotal(braden)}점 · ${showBraden ? "접기" : "열기"}` : showBraden ? "접기" : "입력"}
                </span>
              </button>
              {showBraden && (
                <div className="mt-3">
                  <BradenForm value={braden} onChange={setBraden} />
                  {bradenTotal(braden) != null && (
                    <div className={"mt-3 rounded-xl border p-3 text-sm font-semibold " + (bradenRisk(bradenTotal(braden)).high ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>
                      총점 {bradenTotal(braden)}점 — {bradenRisk(bradenTotal(braden)).label}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </>
        )}

        {/* ---------------- Step 2 ---------------- */}
        {step === 2 && (
          <>
            <Card>
              <SectionTitle>촬영 안내</SectionTitle>
              <div className="text-sm text-slate-700 leading-relaxed space-y-1">
                <p>· 상처 전체가 보이도록 촬영하세요.</p>
                <p>· 가능하면 동일한 거리와 각도에서 촬영하세요.</p>
                <p>· 상처 옆에 크기 측정용 calibration marker(1cm 스티커, 종이자 등)를 놓으세요.</p>
                <p>· 얼굴 등 환자 식별이 가능한 부위는 화면에 포함하지 마세요.</p>
              </div>
            </Card>
            {refPhoto && (
              <Card>
                <SectionTitle>이전 사진 참고</SectionTitle>
                <img src={refPhoto} alt="previous" className="w-full rounded-xl border border-slate-200" />
                <p className="text-xs text-slate-500 mt-2">이전 사진과 비슷한 거리·각도·방향에서 촬영하세요.</p>
              </Card>
            )}
            {!photo ? (
              <div className="space-y-2">
                <Card>
                  <SectionTitle>Measurement Guide — 촬영 전 확인</SectionTitle>
                  <div className="text-sm text-slate-700 leading-relaxed space-y-1">
                    <p>· 정확한 크기 측정을 위해 wound ruler를 병변 옆에 놓고 촬영하는 것을 권장합니다 (상처와 같은 평면).</p>
                    <p>· 가능하면 병변 전체와 주변 피부가 함께 보이도록 촬영하세요.</p>
                    <p>· 강한 빛 반사와 그림자를 피해주세요.</p>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">Ruler/scale이 없는 사진은 화면 보정 측정이 불가하며, 실측값 직접 입력(Manual)으로 진행합니다. AI는 사진만으로 cm를 추정하지 않습니다.</p>
                </Card>
                <label className="w-full py-4 rounded-xl text-white text-base font-semibold flex items-center justify-center gap-2 cursor-pointer" style={{ backgroundColor: "#0369A1" }}>
                  <Camera size={20} /> 카메라로 촬영
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileInput} />
                </label>
                <label className="w-full py-4 rounded-xl border border-slate-300 bg-white text-slate-700 text-base font-semibold flex items-center justify-center gap-2 cursor-pointer">
                  <Upload size={20} /> 갤러리·파일에서 선택
                  <input type="file" accept="image/*" className="hidden" onChange={onFileInput} />
                </label>
                <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
                  className="w-full py-5 px-3 rounded-xl border border-slate-300 bg-white text-center text-xs text-slate-500 leading-relaxed" style={{ borderStyle: "dashed" }}>
                  PC에서는 사진 파일을 여기로 끌어다 놓거나, 복사한 이미지를 이 화면에서 붙여넣기(Ctrl/Cmd+V) 할 수 있습니다
                </div>
                {photoErr && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 leading-relaxed">{photoErr}</div>
                )}
              </div>
            ) : (
              <Card>
                <div className="relative rounded-xl overflow-hidden border border-slate-200"
                  onPointerDown={(e) => { tapRef.current = { x: e.clientX, y: e.clientY }; }}
                  onPointerUp={(e) => {
                    if (!multiWound) return;
                    const s = tapRef.current; tapRef.current = null;
                    if (!s || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const p = {
                      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
                      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
                    };
                    setTargets((ts) => {
                      const near = ts.findIndex((t) => Math.hypot((t.x - p.x) * rect.width, (t.y - p.y) * rect.height) < 26);
                      if (near >= 0) return ts.filter((_, i) => i !== near);
                      if (ts.length >= 5) return ts;
                      return [...ts, p];
                    });
                  }}
                  style={{ touchAction: "manipulation", cursor: multiWound ? "crosshair" : "default" }}>
                  <img src={photo.dataUrl} alt="preview" className="w-full block" draggable={false} />
                  {multiWound && <TargetRings points={targets} />}
                </div>
                <div className="mt-3">
                  <div className="text-xs font-bold text-slate-700 mb-1">사진 속 욕창 개수</div>
                  <div className="flex gap-2">
                    <Chip active={!multiWound} onClick={() => { setMultiWound(false); setTargets([]); }}>하나</Chip>
                    <Chip active={multiWound} onClick={() => setMultiWound(true)}>여러 개</Chip>
                  </div>
                  {multiWound && (
                    <p className="text-xs text-slate-600 mt-2">사정할 상처를 사진에서 모두 탭해 번호를 매기세요(최대 5개, 잘못 찍었으면 그 원을 다시 탭해 삭제). {targets.length > 0 ? `현재 ${targets.length}개 지정됨.` : ""} 2개 이상 지정하면 측정과 AI 분석을 한 화면에서 일괄 처리하고, 각각 별개의 wound로 저장됩니다.</p>
                  )}
                </div>
                {quality && quality.issues.length > 0 && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1">
                    {quality.issues.map((s, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{s}</div>
                    ))}
                    <p className="text-xs text-amber-700">참고용 자동 검사입니다. 문제가 없다고 판단되면 계속 진행할 수 있습니다.</p>
                  </div>
                )}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => { setPhoto(null); setQuality(null); setPhotoErr(""); }} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 flex items-center justify-center gap-1"><RefreshCw size={14} /> 다시 선택</button>
                </div>
              </Card>
            )}
          </>
        )}

        {/* ---------------- Step 3 ---------------- */}
        {step === 3 && (
          <>
            {photo && (
              <Card>
                <SectionTitle>Measurement mode</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  <Chip active={measureMode === "manual"} onClick={() => { setMeasureMode("manual"); setSize((sz) => ({ ...sz, method: "manual" })); }}>Manual — 실측값 입력 (기본)</Chip>
                  <Chip active={measureMode === "ruler"} onClick={() => setMeasureMode("ruler")}>Ruler-assisted — 사진 보정 (선택)</Chip>
                </div>
                <p className="text-xs text-slate-500 mt-2">Manual: 병상에서 실측한 값을 직접 입력합니다(기본). Ruler-assisted: 사진 속 자/마커의 두 점을 직접 탭해 pixel→cm 보정 후 측정합니다. 어느 모드든 사진만으로 cm를 추정하지 않으며, ruler 자동 인식은 추후 확장으로 예정되어 있습니다.</p>
              </Card>
            )}
            {photo && measureMode === "ruler" ? (
              <Card>
                <SectionTitle><span className="flex items-center gap-1.5"><Ruler size={16} /> Ruler-assisted 측정 (마커 기준)</span></SectionTitle>
                <MeasureTool photo={photo} targets={multiWound ? targets : []} aiMeasure={aiMeasureFn}
                  onAiApplied={() => { setAiMeasureUsed(true); setAiMeasurePending(true); }}
                  onHumanMeasure={() => setAiMeasurePending(false)}
                  initCalib={calibCarry ? calibCarry.calib : null}
                  initMarkerCm={calibCarry ? calibCarry.markerCm : null}
                  onCalib={setCalibCarry}
                  onLive={(r) => {
                    const ws = (r && r.wounds) || [];
                    if (batch) {
                      setBatchSizes((prev) => prev.map((b, i) => ({
                        ...b,
                        ...(ws[i] && ws[i].lengthCm != null ? { lengthCm: String(ws[i].lengthCm) } : {}),
                        ...(ws[i] && ws[i].widthCm != null ? { widthCm: String(ws[i].widthCm) } : {}),
                      })));
                    } else {
                      const v = ws[0] || {};
                      setSize((s) => ({
                        ...s,
                        ...(v.lengthCm != null ? { lengthCm: String(v.lengthCm) } : {}),
                        ...(v.widthCm != null ? { widthCm: String(v.widthCm) } : {}),
                        method: "calibrated",
                      }));
                    }
                  }} />
              </Card>
            ) : photo ? (
              <Card><p className="text-sm text-slate-600">Manual 모드 — 아래 📏 Wound Measurement에 병상 실측값을 입력하세요. Area는 자동 계산됩니다.</p></Card>
            ) : (
              <Card><p className="text-sm text-slate-600">사진이 없어 실측값 직접 입력(Manual)으로 진행합니다.</p></Card>
            )}
            {aiMeasurePending && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm text-amber-800 font-medium mb-2">AI가 제안한 측정값입니다 — 사진의 측정선이 상처 축과 일치하는지 확인하고, 필요하면 점을 끌어 수정하거나 값을 직접 고치세요. 확인 전에는 다음 단계로 진행할 수 없습니다.</p>
                <button onClick={() => setAiMeasurePending(false)}
                  className="w-full py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#B45309" }}>
                  측정값 확인 완료 — 이 값 사용
                </button>
              </div>
            )}
            {!batch ? (
            <SizingPanel size={size} setSize={setSize} areaCm2={areaCm2} onTouched={() => setAiMeasurePending(false)} aiUsed={aiMeasureUsed} />
            ) : (
            <Card>
              <SectionTitle>상처별 측정값 · 위치</SectionTitle>
              <div className="space-y-3">
                {batchSizes.map((b, i) => (
                  <div key={i} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base font-bold" style={{ color: "#00B8D9" }}>{CIRC[i]}</span>
                      <select value={b.location} onChange={(e) => setBatchSizes((arr) => arr.map((v, vi) => vi === i ? { ...v, location: e.target.value } : v))}
                        className="flex-1 px-2 py-2 rounded-lg border border-slate-300 bg-white text-sm">
                        {LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <div className="text-xs text-slate-500 mb-1">L (cm)</div>
                        <input type="number" inputMode="decimal" step="0.1" value={b.lengthCm} onChange={(e) => { setAiMeasurePending(false); setBatchSizes((arr) => arr.map((v, vi) => vi === i ? { ...v, lengthCm: e.target.value } : v)); }} className="w-full px-2 py-2.5 rounded-xl border border-slate-300 text-base text-center" />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">W (cm)</div>
                        <input type="number" inputMode="decimal" step="0.1" value={b.widthCm} onChange={(e) => { setAiMeasurePending(false); setBatchSizes((arr) => arr.map((v, vi) => vi === i ? { ...v, widthCm: e.target.value } : v)); }} className="w-full px-2 py-2.5 rounded-xl border border-slate-300 text-base text-center" />
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">D (cm)</div>
                        <input type="number" inputMode="decimal" step="0.1" value={b.depthCm} onChange={(e) => setBatchSizes((arr) => arr.map((v, vi) => vi === i ? { ...v, depthCm: e.target.value } : v))} className="w-full px-2 py-2.5 rounded-xl border border-slate-300 text-base text-center" />
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 mt-1.5">L×W {b.lengthCm && b.widthCm ? `${fmt1(parseFloat(b.lengthCm) * parseFloat(b.widthCm))} cm²` : "—"}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">잠식·터널·감염 소견 등 상세 항목은 일괄 모드에서 생략됩니다 — 필요한 상처는 저장 후 해당 상처의 F/U 사정에서 보완하세요. Depth는 멸균 면봉 등으로 직접 측정해 입력합니다.</p>
            </Card>
            )}
          </>
        )}

        {/* ---------------- Step 4 ---------------- */}
        {step === 4 && !batch && (
          <>
            {!photo && (
              <Card>
                <p className="text-sm text-slate-700">사진이 없어 AI 분석을 생략합니다. 다음 단계에서 직접 사정을 입력하세요.</p>
              </Card>
            )}
            {photo && aiStatus === "idle" && (
              <Card>
                <SectionTitle><span className="flex items-center gap-1.5"><Sparkles size={16} /> AI-assisted assessment</span></SectionTitle>
                <p className="text-sm text-slate-700 leading-relaxed mb-3">사진과 입력 정보를 바탕으로 사정 초안(제안 stage, wound bed, exudate, periwound)을 생성합니다. 결과는 5단계에서 반드시 확인·수정해야 합니다.</p>
                {multiWound && targetPoint && (
                  <p className="text-xs mb-3" style={{ color: "#0369A1" }}>사진에 상처가 여러 개 — 원으로 표시한 상처만 분석하도록 지시합니다.</p>
                )}
                <PrimaryBtn onClick={runAi}>AI 분석 실행</PrimaryBtn>
                <div className="mt-3"><DisclaimerBox /></div>
              </Card>
            )}
            {aiStatus === "loading" && (
              <Card>
                <div className="flex items-center gap-3 py-4">
                  <div className="w-5 h-5 rounded-full border-2 border-slate-300 animate-spin" style={{ borderTopColor: "#0369A1" }} />
                  <span className="text-sm text-slate-700">사진을 분석하는 중입니다…</span>
                </div>
              </Card>
            )}
            {aiStatus === "error" && (
              <Card>
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">AI 분석에 실패했습니다({aiErr}). 다시 시도하거나, 수동 사정으로 진행하세요.</div>
                <div className="flex gap-2">
                  <button onClick={runAi} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#0369A1" }}>다시 시도</button>
                  <button onClick={() => setStep(5)} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">건너뛰기</button>
                </div>
              </Card>
            )}
            {aiStatus === "done" && ai && (
              <>
                {ai.canAssess === false ? (
                  <Card>
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      사진 품질이 충분하지 않습니다 — 신뢰할 수 있는 욕창 사정을 위해 다시 촬영해주세요.
                      {(ai.photoQuality && ai.photoQuality.issues || []).map((s, i) => <div key={i}>· {s}</div>)}
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => setStep(2)} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">다시 촬영</button>
                      <button onClick={() => setStep(5)} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#0369A1" }}>수동 사정 진행</button>
                    </div>
                  </Card>
                ) : (
                  <>
                    <Card>
                      <div className="flex items-center justify-between mb-2">
                        <SectionTitle><span className="flex items-center gap-1.5"><Sparkles size={16} /> AI 제안</span></SectionTitle>
                        <span className="text-xs px-2 py-1 rounded-lg bg-slate-100 border border-slate-300 text-slate-600">불확실성: {ai.uncertainty || "—"}</span>
                      </div>
                      <div className="mb-2"><PhotoQualityLine pq={ai.photoQuality} /></div>
                      {Array.isArray(ai.keyFindings) && ai.keyFindings.length > 0 && (
                        <div className="mb-3">
                          <div className="text-xs font-bold text-slate-700 mb-1">관찰 소견 (Observed Findings)</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.keyFindings.map((f, i) => <p key={i}>✓ {f}</p>)}
                          </div>
                        </div>
                      )}
                      {mode === "follow" && refPhoto && photo && (<div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-sm font-bold text-slate-800 mb-2">F/U 사진 비교</div><div className="grid grid-cols-2 gap-2"><div><div className="text-xs font-semibold text-slate-600 mb-1 text-center">치료 전</div><img src={refPhoto} className="w-full aspect-square object-cover rounded-lg border border-slate-200" /></div><div><div className="text-xs font-semibold text-slate-600 mb-1 text-center">치료 후</div><img src={photo.dataUrl} className="w-full aspect-square object-cover rounded-lg border border-slate-200" /></div></div></div>)}<div className="mb-1"><span className="text-xs text-slate-500 mr-2">AI Suggested Stage</span><StageBadge code={mapAiStage(ai.suggestedStage)} /></div>
                      {ai.healing && (
                        <div className={"mb-3 rounded-xl border p-3 " + (
                          ai.healing.status === "호전" ? "border-emerald-200 bg-emerald-50" :
                          ai.healing.status === "악화 의심" ? "border-red-200 bg-red-50" :
                          ai.healing.status === "변화 없음" ? "border-slate-200 bg-slate-50" :
                          "border-amber-200 bg-amber-50"
                        )}>
                          <div className="text-sm font-bold text-slate-800">Healing 평가 · 이전 사진과 비교</div>
                          <div className="text-base font-bold mt-1 text-slate-900">{ai.healing.status}</div>
                          {(ai.healing.evidence || []).map((e, i) => <p key={i} className="text-xs text-slate-700 mt-1">✓ {e}</p>)}
                          <p className="text-[11px] text-slate-500 mt-2">촬영 조건 차이가 크면 경과 판단의 정확도가 떨어질 수 있습니다.</p>
                        </div>
                      )}
                      <div className="text-xs text-slate-500 mb-2">AI-assisted assessment · Clinical confirmation required — 최종 판단은 의료진이 합니다.</div>
                      <div className="text-xs font-bold text-slate-700 mb-1">Why this stage?</div>
                      <p className="text-sm text-slate-800 leading-relaxed">{ai.rationale}</p>
                      {Array.isArray(ai.differentials) && ai.differentials.length > 0 && (
                        <div className="mt-2">
                          <div className="text-xs font-bold text-slate-700 mb-1">배제 근거</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.differentials.map((d, i) => <p key={i}>✕ {stageLabel(mapAiStage(d.stage))} 아님 — {d.reason}</p>)}
                          </div>
                        </div>
                      )}
                      <div className="mt-2"><StageCriteria code={mapAiStage(ai.suggestedStage)} /></div>
                      <p className="text-xs text-slate-500 mt-2">AI confidence score unavailable — 검증된 모델의 정량 신뢰도가 없어 정성적 불확실성만 표시합니다.</p>
                      {(ai.cautions || []).length > 0 && (
                        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1">
                          {ai.cautions.map((c, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{c}</div>
                          ))}
                        </div>
                      )}
                      {ai.blanchingCheckNeeded && (
                        <button onClick={() => setBlanchModal(true)} className="mt-3 w-full text-left rounded-xl border border-amber-300 bg-amber-50 p-3">
                          <div className="text-sm font-bold text-amber-800">Blanching 확인 필요</div>
                          <div className="text-xs text-amber-800 mt-0.5">
                            {final.blanching === "blanch" ? "입력됨: 하얗게 변함 (blanchable) → 욕창 아님 가능성"
                              : final.blanching === "nonblanch" ? "입력됨: 변하지 않음 (non-blanching) → 1단계 지지"
                              : "탭하여 blanching 검사 결과를 입력하세요"}
                          </div>
                        </button>
                      )}
                      {ai.iadCheckNeeded && (
                        <button onClick={openIad} className="mt-3 w-full text-left rounded-xl border border-amber-300 bg-amber-50 p-3">
                          <div className="text-sm font-bold text-amber-800">IAD(실금관련피부염) 감별 필요</div>
                          <div className="text-xs text-amber-800 mt-0.5">{iadVerdict ? `체크 결과: ${iadVerdict}` : "탭하여 감별 체크리스트를 작성하세요"}</div>
                        </button>
                      )}
                      {(ai.photoQuality && !ai.photoQuality.adequate && (ai.photoQuality.issues || []).length > 0) && (
                        <div className="mt-2 text-xs text-slate-500">사진 품질: {ai.photoQuality.issues.join(" · ")}</div>
                      )}
                    </Card>
                    {ai.woundBed && Array.isArray(ai.woundBed.present) && ai.woundBed.present.length > 0 && (
                      <Card>
                        <SectionTitle>Wound bed (사진 소견)</SectionTitle>
                        <p className="text-sm text-slate-800">확인되는 조직: {ai.woundBed.present.filter((t) => WB_KEYS.some((w) => w.k === t)).map(wbLabel).join(", ") || "—"}</p>
                        {ai.woundBed.predominant && <p className="text-sm text-slate-800 mt-1">주된 조직: <b>{wbLabel(ai.woundBed.predominant)}</b></p>}
                        <p className="text-xs text-slate-500 mt-2">비율(%)은 추정하지 않습니다. 다음 단계에서 확인·수정하세요.</p>
                      </Card>
                    )}
                    <Card>
                      <SectionTitle>기타 제안</SectionTitle>
                      <div className="text-sm text-slate-800 space-y-1">
                        <p>Exudate: {ai.exudate && ai.exudate.amount ? `${ai.exudate.amount}${ai.exudate.type ? ` · ${ai.exudate.type}` : ""}` : "판단 보류 — 직접 입력"}</p>
                        <p>Periwound: {(ai.periwound || []).length ? ai.periwound.join(", ") : "판단 보류 — 직접 입력"}</p>
                      </div>
                    </Card>
                    <Card>
                      <SectionTitle>Clinical check — 직접 확인 항목</SectionTitle>
                      <div className="space-y-2">
                        <CheckRow done={!!size.depthCm} label="Wound depth 직접 측정·입력"
                          hint={size.depthCm ? `입력됨: ${size.depthCm} cm` : "탭하면 측정 단계로 이동합니다"}
                          onClick={() => setStep(3)} />
                        {["3", "4", "U", "ND"].includes(mapAiStage(ai.suggestedStage)) && !ai.blanchingCheckNeeded && (
                          <CheckRow done={deeperChecked} label="심부 구조(근막·근육·건·뼈) 노출 여부 직접 확인"
                            hint={deeperChecked ? "확인함" : "사진만으로 배제 불가 — 확인 후 탭하여 표시"}
                            onClick={() => setDeeperChecked(!deeperChecked)} />
                        )}
                        {ai.blanchingCheckNeeded && (
                          <CheckRow done={final.blanching != null} label="Blanching test 시행"
                            hint={final.blanching ? (final.blanching === "blanch" ? "결과: 하얗게 변함 (blanchable)" : "결과: 변하지 않음 (non-blanching)") : "탭하여 결과 입력"}
                            onClick={() => setBlanchModal(true)} />
                        )}
                        {ai.iadCheckNeeded && (
                          <CheckRow done={iadVerdict != null} label="IAD 감별 체크"
                            hint={iadVerdict || "탭하여 체크리스트 작성"}
                            onClick={openIad} />
                        )}
                        {(() => {
                          const sug = mapAiStage(ai.suggestedStage);
                          const grp = CLIN_GROUPS[sug] || (sug === "ND" && ai.blanchingCheckNeeded ? CLIN_GROUPS["1"] : null);
                          if (!grp) return null;
                          const cc = final.clinChecks || {};
                          const setCC = (k, v) => setFinal({ ...final, clinChecks: { ...cc, [k]: v } });
                          const valFor = (k) => k === "blanching" ? (cc.blanching || final.blanching || null) : (cc[k] || null);
                          const changeFor = (k) => (v) => {
                            if (k === "blanching") {
                              setFinal({ ...final, blanching: v === "nonblanch" || v === "blanch" ? v : null, clinChecks: { ...cc, blanching: v } });
                            } else setCC(k, v);
                          };
                          const hints = [];
                          if (sug === "2" && ["sloughEschar", "fat", "deep"].some((k) => cc[k] === "yes"))
                            hints.push("확인 결과가 Stage 2와 양립하지 않습니다 — Unstageable(기저부 가려짐) 또는 Stage 3·4를 검토하고 다음 단계에서 단계를 직접 조정하세요.");
                          if (["3", "U"].includes(sug) && cc.deep === "yes")
                            hints.push("심부 구조 노출이 확인되었습니다 — Stage 4 기준 충족 가능성이 있어 단계 재검토가 필요합니다.");
                          if (grp === CLIN_GROUPS["1"]) {
                            if (valFor("blanching") === "blanch") hints.push("Blanchable — 반응성 충혈 가능성, Confirm 시 '욕창 아님'으로 반영됩니다.");
                            if (valFor("blanching") === "nonblanch") hints.push("Non-blanchable — Confirm 시 Stage 1로 반영됩니다.");
                          }
                          if (sug === "DTPI") {
                            if (valFor("blanching") === "blanch")
                              hints.push("Blanchable 소견 — DTPI보다 반응성 충혈 가능성이 있어 재검토가 필요합니다.");
                            const pos = (valFor("blanching") === "nonblanch" ? 1 : 0) + (cc.pain === "present" ? 1 : 0) + (["warmer", "cooler"].includes(cc.temp) ? 1 : 0) + (["firm", "boggy"].includes(cc.firm) ? 1 : 0) + (cc.color === "yes" ? 1 : 0) + (cc.blister === "yes" ? 1 : 0);
                            if (pos >= 3) hints.push("다수 항목 양성 — DTPI 소견을 지지합니다. 입력값은 최종 사정에 반영됩니다.");
                          }
                          if (grp.items.some(([k]) => valFor(k) === "na"))
                            hints.push("'판단 불가' 항목은 전문가 재사정 시 함께 확인하세요.");
                          return (
                            <>
                              <div className="text-xs font-bold text-slate-700 mt-3 mb-1">{grp.title} — 임상 확인 (해당 시)</div>
                              {grp.items.map(([k, label, opts]) => (
                                <TriRow key={k} label={label} value={valFor(k)} opts={opts} onChange={changeFor(k)} />
                              ))}
                              {hints.map((h, i) => <p key={i} className="text-xs text-amber-800 mt-1">⚠ {h}</p>)}
                            </>
                          );
                        })()}
                      </div>
                    </Card>
                    <DisclaimerBox />
                    <div className="space-y-2">
                      <button onClick={applyAi} className="w-full py-3 rounded-xl text-white text-sm font-semibold" style={{ backgroundColor: "#0369A1" }}>Confirm — 제안 Stage로 검토 계속</button>
                      <button onClick={applyAiExceptStage} className="w-full py-3 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">Edit — Stage 직접 선택 (다음 단계)</button>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {step === 4 && batch && (
          <>
            {batchStatus === "idle" && (
              <Card>
                <SectionTitle><span className="flex items-center gap-1.5"><Sparkles size={16} /> AI 일괄 분석 — 상처 {targets.length}개</span></SectionTitle>
                <p className="text-sm text-slate-700 leading-relaxed mb-3">각 상처를 확대 이미지와 함께 하나씩 개별 분석한 뒤 결과를 모아 보여줍니다. 모두 같은 단계로 보이면 한 번만 확인하고, 다르게 보이면 상처별로 확인한 뒤 일괄 저장합니다.</p>
                <PrimaryBtn onClick={runBatchAi}>AI 일괄 분석 실행</PrimaryBtn>
                <button onClick={() => { setAiBatch(null); setBatchStages(targets.map(() => "ND")); setBatchStatus("manual"); }}
                  className="w-full mt-2 py-3 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">AI 없이 단계 직접 선택</button>
                <div className="mt-3"><DisclaimerBox /></div>
              </Card>
            )}
            {batchStatus === "loading" && (
              <Card>
                <div className="flex items-center gap-3 py-4">
                  <div className="w-5 h-5 rounded-full border-2 border-slate-300 animate-spin" style={{ borderTopColor: "#0369A1" }} />
                  <span className="text-sm text-slate-700">상처를 하나씩 개별 분석 중… {batchProg}/{targets.length} 완료</span>
                </div>
                <p className="text-xs text-slate-500">정확도를 위해 상처마다 확대 이미지로 별도 분석합니다. 상처 수에 비례해 시간이 걸립니다.</p>
              </Card>
            )}
            {batchStatus === "error" && (
              <Card>
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">AI 일괄 분석에 실패했습니다({batchErr}). 다시 시도하거나 단계를 직접 선택하세요.</div>
                <div className="flex gap-2">
                  <button onClick={runBatchAi} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#0369A1" }}>다시 시도</button>
                  <button onClick={() => { setAiBatch(null); setBatchStages(targets.map(() => "ND")); setBatchStatus("manual"); }}
                    className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">직접 선택</button>
                </div>
              </Card>
            )}
            {(batchStatus === "done" || batchStatus === "manual") && (
              <>
                {batchStatus === "done" && aiBatch && (() => {
                  const ws = (aiBatch.wounds || []).filter((w) => w.ok && w.canAssess !== false);
                  const allSame = ws.length === (aiBatch.wounds || []).length && ws.length > 0 && ws.every((w) => mapAiStage(w.suggestedStage) === mapAiStage(ws[0].suggestedStage));
                  return allSame ? (
                    <div className="rounded-xl border p-3" style={{ backgroundColor: "#E0F2FE", borderColor: "#7DD3FC" }}>
                      <div className="text-sm font-bold flex items-center gap-2 flex-wrap" style={{ color: "#075985" }}>모든 상처가 동일 단계로 보입니다 <StageBadge code={mapAiStage(ws[0].suggestedStage)} /></div>
                      <p className="text-xs mt-1" style={{ color: "#075985" }}>아래에서 확인하고 한 번에 저장하세요. 판단이 다른 상처만 해당 단계를 바꾸면 됩니다.</p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">상처별 단계가 다르게 보입니다 — 각각 확인하세요.</div>
                  );
                })()}
                {batchStatus === "done" && aiBatch && aiBatch.photoQuality && (aiBatch.photoQuality.issues || []).length > 0 && (
                  <div className="text-xs text-slate-500">사진 품질: {aiBatch.photoQuality.issues.join(" · ")}</div>
                )}
                <div className="space-y-2">
                  {targets.map((_, i) => {
                    const w = aiBatch && aiBatch.wounds ? (aiBatch.wounds.find((x) => Number(x.index) === i + 1) || aiBatch.wounds[i]) : null;
                    const b = batchSizes[i] || {};
                    return (
                      <Card key={i}>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-base font-bold" style={{ color: "#00B8D9" }}>{CIRC[i]}</span>
                          <span className="text-sm font-bold text-slate-900">{b.location || "위치 미지정"}</span>
                          {b.lengthCm ? <span className="text-xs text-slate-500">{b.lengthCm}×{b.widthCm || "?"} cm</span> : null}
                          {w && w.ok && w.canAssess !== false && <span className="ml-auto text-xs text-slate-500">불확실성 {w.uncertainty || "—"}</span>}
                        </div>
                        {w && w.ok === false && (
                          <div className="rounded-lg bg-red-50 border border-red-200 p-2 text-xs text-red-700">이 상처의 AI 분석에 실패했습니다({w.error}). 단계를 직접 선택하세요.</div>
                        )}
                        {w && w.ok && w.canAssess === false && (
                          <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800">AI가 이 상처는 사진만으로 판독이 어렵다고 판단했습니다{w.photoQuality && (w.photoQuality.issues || []).length ? ` (${w.photoQuality.issues.join(", ")})` : ""}. 단계를 직접 선택하세요.</div>
                        )}
                        {w && w.ok && w.canAssess !== false && w.photoQuality && (w.photoQuality.adequate === false || (w.photoQuality.issues || []).length > 0) && (
                          <div className="mb-1"><PhotoQualityLine pq={w.photoQuality} /></div>
                        )}
                        {w && w.ok && w.canAssess !== false && Array.isArray(w.keyFindings) && w.keyFindings.length > 0 && (
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5 mb-1">
                            {w.keyFindings.map((f, fi) => <p key={fi}>✓ {f}</p>)}
                          </div>
                        )}
                        {w && w.ok && w.canAssess !== false && <p className="text-sm text-slate-800 leading-relaxed">{w.rationale}</p>}
                        {w && w.ok && w.canAssess !== false && (w.cautions || []).map((c, ci) => (
                          <div key={ci} className="flex items-start gap-2 text-xs text-amber-800 mt-1"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{c}</div>
                        ))}
                        {w && w.ok && w.canAssess !== false && (w.blanchingCheckNeeded || w.iadCheckNeeded) && (
                          <p className="text-xs text-amber-800 mt-1">⚠ {w.blanchingCheckNeeded ? "Blanching 확인 필요 — 병상에서 확인 후 이 상처의 단계를 조정하세요. " : ""}{w.iadCheckNeeded ? "IAD(실금관련피부염) 감별 필요." : ""}</p>
                        )}
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-slate-500 shrink-0">최종 단계</span>
                          <select value={batchStages[i] || "ND"} onChange={(e) => setBatchStages((arr) => arr.map((v, vi) => vi === i ? e.target.value : v))}
                            className="flex-1 px-2 py-2 rounded-lg border border-slate-300 bg-white text-sm">
                            {STAGES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                          </select>
                          {w && w.ok && w.canAssess !== false && <span className="text-xs text-slate-400 shrink-0">AI: {stageLabel(mapAiStage(w.suggestedStage))}</span>}
                        </div>
                      </Card>
                    );
                  })}
                </div>
                <Card>
                  <SectionTitle>공통 메모 (선택)</SectionTitle>
                  <textarea value={batchMemo} onChange={(e) => setBatchMemo(e.target.value)} rows={2}
                    placeholder="예: 두 병변 모두 체위변경 강화, 폼 드레싱 적용" className="w-full px-3 py-2 rounded-xl border border-slate-300 text-base" />
                </Card>
                <p className="text-xs text-slate-500">일괄 모드에서는 감염 소견·잠식·상세 사정을 생략합니다. 감염이 의심되거나 상세 기록이 필요한 상처는 저장 후 해당 상처에서 F/U 사정으로 보완하세요.</p>
                {batchErr && batchStatus === "done" && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{batchErr}</div>}
                <DisclaimerBox />
              </>
            )}
          </>
        )}

        {/* ---------------- Step 5 ---------------- */}
        {step === 5 && (
          <>
            {aiApplied && (
              <div className="rounded-xl border p-3 text-xs leading-relaxed" style={{ backgroundColor: "#E0F2FE", borderColor: "#7DD3FC", color: "#075985" }}>
                AI 제안이 반영되어 있습니다. 모든 항목을 직접 확인하고 필요 시 수정하세요. 최종 판단은 사정자의 책임입니다.
              </div>
            )}
            <Card>
              <SectionTitle>Stage (최종 선택)</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {STAGES.map((s) => {
                  const aiSug = ai && ai.canAssess !== false && mapAiStage(ai.suggestedStage) === s.code;
                  return (
                    <button key={s.code} onClick={() => setFinal({ ...final, stage: s.code })}
                      className={"text-left px-3 py-2.5 rounded-xl border " + (final.stage === s.code ? "" : "border-slate-300 bg-white")}
                      style={final.stage === s.code ? { backgroundColor: "#E0F2FE", borderColor: "#0369A1", borderWidth: 1, borderStyle: "solid" } : {}}>
                      <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">{s.label}
                        {aiSug && <span className="text-white rounded px-1 py-0.5 font-bold" style={{ backgroundColor: "#0369A1", fontSize: 9 }}>AI 제안</span>}
                      </div>
                      <div className="text-xs text-slate-500">{s.desc}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3"><StageCriteria code={final.stage} /></div>
              <div className="flex gap-4 mt-3">
                <button onClick={() => setShowFlow(!showFlow)} className="text-xs underline text-slate-500">단계 판정 흐름 {showFlow ? "접기" : "보기"}</button>
                <button onClick={openIad} className="text-xs underline text-slate-500">IAD 감별 도우미</button>
              </div>
              {showFlow && <div className="mt-2"><StageFlow /></div>}
            </Card>
            {ai && ai.canAssess !== false && final.stage !== "ND" && mapAiStage(ai.suggestedStage) !== final.stage && (
              <Card>
                <SectionTitle>Override reason — AI 제안과 다른 단계 선택</SectionTitle>
                <div className="space-y-1.5">
                  {OVERRIDE_REASONS.map(([code, label]) => (
                    <button key={code} onClick={() => setFinal({ ...final, overrideReason: { code, text: (final.overrideReason && final.overrideReason.text) || "" } })}
                      className={"w-full text-left px-3 py-2.5 rounded-xl border text-sm " + (final.overrideReason && final.overrideReason.code === code ? "" : "border-slate-300 bg-white text-slate-700")}
                      style={final.overrideReason && final.overrideReason.code === code ? { backgroundColor: "#E0F2FE", borderColor: "#0369A1", borderWidth: 1, borderStyle: "solid" } : {}}>
                      {label}
                    </button>
                  ))}
                </div>
                {final.overrideReason && final.overrideReason.code === "other" && (
                  <input value={final.overrideReason.text || ""} onChange={(e) => setFinal({ ...final, overrideReason: { code: "other", text: e.target.value } })}
                    placeholder="사유 직접 입력" className="w-full mt-2 px-3 py-2.5 rounded-xl border border-slate-300 text-sm" />
                )}
                <p className="text-xs text-slate-500 mt-2">불일치 사유는 기록에 저장되어 감사(audit)와 AI 개선에 사용됩니다.</p>
              </Card>
            )}
            <Card>
              <SectionTitle>Blanching 검사 (intact skin 발적 시)</SectionTitle>
              <div className="flex flex-wrap gap-2">
                <Chip active={final.blanching === "blanch"} onClick={() => setFinal({ ...final, blanching: final.blanching === "blanch" ? null : "blanch" })}>하얗게 변함 (blanchable)</Chip>
                <Chip active={final.blanching === "nonblanch"} onClick={() => setFinal({ ...final, blanching: final.blanching === "nonblanch" ? null : "nonblanch" })}>변하지 않음</Chip>
              </div>
              {final.blanching === "blanch" && final.stage === "1" && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-start gap-2 text-xs text-amber-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  Blanching(+)이면 1단계 욕창보다 반응성 충혈 가능성이 높습니다. '욕창 아님' 선택을 고려하세요.
                </div>
              )}
              {final.blanching === "nonblanch" && final.stage === "NONE" && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-start gap-2 text-xs text-amber-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  Non-blanching 발적은 intact skin이라면 1단계 욕창을 시사합니다. Stage를 재확인하세요.
                </div>
              )}
              <p className="text-xs text-slate-500 mt-2">발적 부위를 손가락 또는 투명판으로 약 3초간 눌렀다 뗐을 때 하얗게 변하는지 확인합니다.</p>
            </Card>
            <Card>
              <SectionTitle>Wound bed — 확인되는 조직 (복수 선택)</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {WB_KEYS.map((w) => (
                  <Chip key={w.k} active={final.woundBed.types.includes(w.k)} onClick={() => toggleWb(w.k)}>{w.l}</Chip>
                ))}
              </div>
              {final.woundBed.types.length > 1 && (
                <>
                  <div className="text-xs text-slate-500 mt-3 mb-1">주된(predominant) 조직</div>
                  <div className="flex flex-wrap gap-2">
                    {final.woundBed.types.map((t) => (
                      <Chip key={t} active={final.woundBed.predominant === t}
                        onClick={() => setFinal({ ...final, woundBed: { ...final.woundBed, predominant: t } })}>
                        {wbLabel(t)}
                      </Chip>
                    ))}
                  </div>
                </>
              )}
              <p className="text-xs text-slate-500 mt-2">정확한 비율(%) 대신 존재하는 조직과 주된 조직만 기록합니다.</p>
                          <div className="mt-3">
                <div className="text-xs font-bold text-slate-700 mb-1">Wound Edge · Epithelialization (별도 항목)</div>
                <div className="flex flex-wrap gap-2">
                  <Chip active={final.edge === "present"} onClick={() => setFinal({ ...final, edge: final.edge === "present" ? null : "present" })}>상피화 있음</Chip>
                  <Chip active={final.edge === "absent"} onClick={() => setFinal({ ...final, edge: final.edge === "absent" ? null : "absent" })}>상피화 없음</Chip>
                  <Chip active={final.edge == null} onClick={() => setFinal({ ...final, edge: null })}>판단 불가</Chip>
                </div>
              </div>
            </Card>
            <Card>
              <SectionTitle>Exudate</SectionTitle>
              <div className="text-xs text-slate-500 mb-1">양</div>
              <div className="flex flex-wrap gap-2 mb-3">
                {EXU_AMT.map((a) => <Chip key={a} active={final.exudateAmount === a} onClick={() => setFinal({ ...final, exudateAmount: a })}>{a}</Chip>)}
              </div>
              <div className="text-xs text-slate-500 mb-1">양상</div>
              <div className="flex flex-wrap gap-2">
                {EXU_TYPE.map((t) => <Chip key={t} active={final.exudateType === t} onClick={() => setFinal({ ...final, exudateType: final.exudateType === t ? null : t })}>{t}</Chip>)}
              </div>
            </Card>
            <Card>
              <SectionTitle>Periwound (복수 선택)</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {PERIWOUND.map((p) => (
                  <Chip key={p} active={final.periwound.includes(p)}
                    onClick={() => setFinal({ ...final, periwound: final.periwound.includes(p) ? final.periwound.filter((x) => x !== p) : [...final.periwound, p] })}>
                    {p}
                  </Chip>
                ))}
              </div>
            </Card>
            <Card>
              <SectionTitle>감염 관련 소견 (간호사 직접 평가)</SectionTitle>
              <div className="text-xs text-slate-500 mb-1">Odor</div>
              <div className="flex flex-wrap gap-2 mb-3">
                {ODOR.map((o) => <Chip key={o} active={final.infection.odor === o} onClick={() => setFinal({ ...final, infection: { ...final.infection, odor: o } })}>{o}</Chip>)}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {INF_TOGGLES.map((t) => (
                  <button key={t.k} onClick={() => setFinal({ ...final, infection: { ...final.infection, [t.k]: !final.infection[t.k] } })}
                    className={"px-3 py-2.5 rounded-xl border text-sm font-medium text-left " + (final.infection[t.k] ? "text-white border-transparent" : "bg-white text-slate-700 border-slate-300")}
                    style={final.infection[t.k] ? { backgroundColor: "#B91C1C" } : {}}>
                    {t.l}
                  </button>
                ))}
              </div>
              {infFlag && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 flex items-start gap-2 text-sm text-red-700">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  감염 가능성을 고려하여 추가적인 임상 평가가 필요합니다. 기관 프로토콜에 따라 담당의에게 보고하세요.
                </div>
              )}
            </Card>
            <Card>
              <SectionTitle>추가 메모</SectionTitle>
              <textarea value={final.memo} onChange={(e) => setFinal({ ...final, memo: e.target.value })} rows={2}
                placeholder="터널링·undermining, 드레싱 종류 등" className="w-full px-3 py-2 rounded-xl border border-slate-300 text-base" />
            </Card>
          </>
        )}

        {/* ---------------- Step 6 ---------------- */}
        {step === 6 && (
          <>
            {quickMode && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 leading-relaxed">빠른 사정 — 이전 상처의 사정 내용을 복사했습니다. Stage와 소견이 이 상처에도 동일한지 확인하고, 다르면 뒤로 가서 수정하세요.</div>
            )}
            <Card>
              <div className="mb-2">
                <div className="text-lg font-bold text-slate-900">Wound Assessment</div>
                <div className="text-xs text-slate-500">{pid.trim()} · {effLocation}{locationSub.trim() ? ` (${locationSub.trim()})` : ""} · {assessDate}</div>
              </div>
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-3">
                <div className="flex items-center gap-1.5"><span className="text-xs text-slate-500">최종 (Clinician)</span><StageBadge code={final.stage} /></div>
                <div className="flex items-center gap-1.5"><span className="text-xs text-slate-500">AI 제안</span>{ai && ai.canAssess !== false ? <StageBadge code={mapAiStage(ai.suggestedStage)} /> : <span className="text-xs text-slate-400">미시행</span>}</div>
                {ai && ai.canAssess !== false && (
                  <span className="text-xs text-slate-500">{mapAiStage(ai.suggestedStage) === final.stage ? "✓ AI 제안과 최종 판단 일치" : "⚠ AI 제안과 최종 판단 불일치"}</span>
                )}
              </div>
              <div className="mb-2"><PhotoQualityLine pq={ai ? ai.photoQuality : null} /></div>
              {photo && (
                <div className="relative rounded-xl overflow-hidden border border-slate-200 mb-3">
                  <img src={photo.dataUrl} alt="wound" className="w-full block" />
                  {multiWound && <TargetRings points={targets} />}
                </div>
              )}
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <span className="text-slate-500">Length</span><span className="font-semibold text-right">{size.lengthCm ? `${size.lengthCm} cm` : "—"}</span>
                <span className="text-slate-500">Width</span><span className="font-semibold text-right">{size.widthCm ? `${size.widthCm} cm` : "—"}</span>
                <span className="text-slate-500">Depth</span><span className="font-semibold text-right">{size.depthCm ? `${size.depthCm} cm` : "—"}</span>
                <span className="text-slate-500">L×W Area</span><span className="font-semibold text-right">{areaCm2 != null ? `${areaCm2} cm²` : "—"}</span>
                {final.blanching ? (<><span className="text-slate-500">Blanching</span><span className="font-semibold text-right">{final.blanching === "blanch" ? "하얗게 변함" : "변하지 않음"}</span></>) : null}
                {iadVerdict ? (<><span className="text-slate-500">IAD 감별</span><span className="font-semibold text-right">{iadVerdictShortFrom(final.iadCheck)}</span></>) : null}
                {bradenTotal(braden) != null ? (<><span className="text-slate-500">Braden</span><span className="font-semibold text-right">{bradenTotal(braden)}점 · {bradenRisk(bradenTotal(braden)).high ? "고위험" : "저위험"}</span></>) : null}
              </div>
              <p className="text-xs text-slate-400 mt-2">Length = 머리–발끝(12→6시) 방향 최대 길이 · Width = Length에 수직(3–9시) 최대 폭 · Depth = 가장 깊은 지점(임상 측정) · Area = L×W</p>
              {ai && ai.canAssess !== false && Array.isArray(ai.keyFindings) && ai.keyFindings.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs font-bold text-slate-700 mb-1">Key Observations</div>
                  <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                    {ai.keyFindings.slice(0, 3).map((f, i) => <p key={i}>✓ {f}</p>)}
                  </div>
                </div>
              )}
              {ai && ai.healing && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="text-xs font-bold text-slate-700">Healing 평가 · 이전 사진 비교</div>
                  <div className="text-sm font-bold text-slate-900 mt-1">{ai.healing.status}</div>
                  {(ai.healing.evidence || []).map((e, i) => <p key={i} className="text-xs text-slate-600 mt-1">✓ {e}</p>)}
                </div>
              )}
              <div className="mt-3 text-xs text-slate-500">Clinical check: Depth {size.depthCm ? "입력됨" : "미입력"} · Blanching {final.blanching ? (final.blanching === "blanch" ? "blanchable" : "non-blanchable") : "미시행"} · IAD {iadVerdictShortFrom(final.iadCheck) || "미시행"}{deeperChecked ? " · 심부구조 확인함" : ""}</div>
            </Card>
            {infFlag && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 flex items-start gap-2 text-sm text-red-700">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" /> 감염 의심 소견이 입력되었습니다. 추가 임상 평가 및 담당의 보고가 필요합니다.
              </div>
            )}
            <Card>
              <SectionTitle>Recommended Nursing Care</SectionTitle>
              <div className="space-y-3">
                {buildRecommendations(final, effLocation, { isNewWound: mode !== "follow" }).map((g) => (
                  <div key={g.t}>
                    <div className="text-xs font-bold text-slate-700 mb-1">{g.t}</div>
                    <div className="text-sm text-slate-700 leading-relaxed space-y-0.5">
                      {g.items.map((it, i) => <p key={i}>· {it}</p>)}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-3">NPIAP/EPUAP/PPPIA 원칙 기반 초안입니다. 드레싱 및 치료재료 선택은 환자 상태와 기관 지침, 상처전문가의 판단에 따릅니다.</p>
            </Card>
            <button onClick={() => setShowDetail(!showDetail)}
              className="w-full py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">
              상세 근거·소견 {showDetail ? "접기 ▲" : "보기 ▼"}
            </button>
            {showDetail && (
              <>
                <Card>
                  <SectionTitle>상세 소견</SectionTitle>
                  <div className="grid grid-cols-2 gap-y-2 text-sm">
                    <span className="text-slate-500">Wound bed</span><span className="font-semibold text-right">{woundBedText(final.woundBed)}</span>
                    <span className="text-slate-500">Exudate</span><span className="font-semibold text-right">{final.exudateAmount ? `${final.exudateAmount}${final.exudateType ? ` · ${final.exudateType}` : ""}` : "—"}</span>
                    <span className="text-slate-500">Periwound</span><span className="font-semibold text-right">{final.periwound.join(", ") || "—"}</span>
                    <span className="text-slate-500">Wound edge</span><span className="font-semibold text-right">{final.edge === "present" ? "상피화 있음" : final.edge === "absent" ? "상피화 없음" : "판단 불가"}</span>
                    {clinChecksText(final) ? (<><span className="text-slate-500">임상 확인 입력</span><span className="font-semibold text-right">{clinChecksText(final)}</span></>) : null}
                    {final.overrideReason ? (<><span className="text-slate-500">Override 사유</span><span className="font-semibold text-right">{((OVERRIDE_REASONS.find((r) => r[0] === final.overrideReason.code) || [])[1] || "") + (final.overrideReason.code === "other" && final.overrideReason.text ? ` — ${final.overrideReason.text}` : "")}</span></>) : null}
                    {size.undermining.trim() ? (<><span className="text-slate-500">잠식</span><span className="font-semibold text-right">{size.undermining}</span></>) : null}
                    {size.tunneling.trim() ? (<><span className="text-slate-500">터널</span><span className="font-semibold text-right">{size.tunneling}</span></>) : null}
                    {(final.memo || "").trim() ? (<><span className="text-slate-500">메모</span><span className="font-semibold text-right">{final.memo}</span></>) : null}
                  </div>
                </Card>
                <Card>
                  <SectionTitle>Why? — 판단 근거</SectionTitle>
                  <div className="mb-3"><StageCriteria code={final.stage} /></div>
                  {ai && ai.canAssess !== false ? (
                    <>
                      <div className="mb-2"><PhotoQualityLine pq={ai.photoQuality} /></div>
                      {Array.isArray(ai.keyFindings) && ai.keyFindings.length > 0 && (
                        <div className="mb-2">
                          <div className="text-xs font-bold text-slate-700 mb-1">관찰 소견 (Observed Findings)</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.keyFindings.map((f, i) => <p key={i}>✓ {f}</p>)}
                          </div>
                        </div>
                      )}
                      <div className="text-xs font-bold text-slate-700 mb-1">AI 소견</div>
                      <p className="text-sm text-slate-800 leading-relaxed">{ai.rationale}</p>
                      {Array.isArray(ai.differentials) && ai.differentials.length > 0 && (
                        <div className="mt-2">
                          <div className="text-xs font-bold text-slate-700 mb-1">배제 근거</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.differentials.map((d, i) => <p key={i}>✕ {stageLabel(mapAiStage(d.stage))} 아님 — {d.reason}</p>)}
                          </div>
                        </div>
                      )}
                      {(ai.cautions || []).map((c, i) => <p key={i} className="text-xs text-amber-800 mt-1">⚠ {c}</p>)}
                    </>
                  ) : <p className="text-sm text-slate-500">{quickMode ? "AI 분석 미시행 — 이전 상처의 사정을 복사함 (사정자 확인 필요)." : "AI 분석 미시행 — 사정자 직접 판단."}</p>}
                  {(final.blanching || iadVerdict) && (
                    <div className="mt-3 rounded-xl bg-slate-100 p-3 text-xs text-slate-700 space-y-0.5">
                      <div className="font-bold">안전 확인 결과</div>
                      {final.blanching && <p>Blanching: {final.blanching === "blanch" ? "하얗게 변함 → 반응성 충혈 가능(욕창 아님 고려)" : "변하지 않음 → 1단계 욕창 지지"}</p>}
                      {iadVerdict && <p>IAD 감별: {iadVerdict}</p>}
                    </div>
                  )}
                </Card>
              </>
            )}
            <DisclaimerBox />
            {saveErr && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{saveErr}</div>
            )}
          </>
        )}
      </div>

      {blanchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(15,23,42,0.6)" }}>
          <div className="bg-white rounded-2xl p-4 w-full" style={{ maxWidth: 400 }}>
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
              <div className="text-base font-bold text-slate-900">Blanching 확인 필요</div>
            </div>
            <p className="text-sm text-slate-700 leading-relaxed mb-1">사진만으로는 1단계 욕창(non-blanching erythema)과 반응성 충혈(blanchable erythema)을 구분할 수 없습니다.</p>
            <p className="text-sm text-slate-700 leading-relaxed mb-3">발적 부위를 손가락 또는 투명판으로 약 3초간 눌렀다 뗐을 때, 피부가 하얗게 변합니까?</p>
            <div className="space-y-2">
              <button onClick={() => { setFinal((f) => ({ ...f, blanching: "blanch" })); setBlanchModal(false); }}
                className="w-full text-left px-3 py-3 rounded-xl border border-emerald-200 bg-emerald-50">
                <div className="text-sm font-bold text-emerald-700">하얗게 변함 (blanchable)</div>
                <div className="text-xs text-emerald-700">욕창이 아닌 반응성 충혈 가능성 — 제안 반영 시 '욕창 아님'으로 분류</div>
              </button>
              <button onClick={() => { setFinal((f) => ({ ...f, blanching: "nonblanch" })); setBlanchModal(false); }}
                className="w-full text-left px-3 py-3 rounded-xl border border-red-200 bg-red-50">
                <div className="text-sm font-bold text-red-700">변하지 않음 (non-blanching)</div>
                <div className="text-xs text-red-700">intact skin이라면 1단계 욕창 지지 — Confirm 시 Stage 1로 적용</div>
              </button>
              <button onClick={() => { setFinal((f) => ({ ...f, blanching: null, clinChecks: { ...(f.clinChecks || {}), blanching: "na" } })); setBlanchModal(false); }}
                className="w-full text-left px-3 py-3 rounded-xl border border-slate-300 bg-white">
                <div className="text-sm font-bold text-slate-600">판단 불가 (Unable to assess)</div>
                <div className="text-xs text-slate-500">단계는 '미정' 유지 — 전문가 재사정 시 확인. 기록에 '판단 불가'로 저장됩니다.</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {iadModal && final.iadCheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(15,23,42,0.6)" }}>
          <div className="bg-white rounded-2xl p-4 w-full overflow-y-auto" style={{ maxWidth: 400, maxHeight: "85vh" }}>
            <div className="text-base font-bold text-slate-900 mb-1">IAD 감별 체크</div>
            <p className="text-xs text-slate-500 mb-3">실금관련피부염(IAD)과 욕창은 병존할 수 있습니다. 아래는 감별을 돕는 참고 기준입니다.</p>
            {[
              { k: "moisture", q: "요실금·변실금 또는 지속적 습기 노출이 있습니까?", yes: "있음", no: "없음" },
              { k: "diffuse", q: "병변이 둔부·회음부에 미만성으로 퍼져 있습니까?", yes: "미만성", no: "뼈 돌출부 국소" },
              { k: "unclear", q: "병변의 경계가 불분명합니까?", yes: "불분명", no: "명확" },
              { k: "necrosis", q: "괴사조직(slough/eschar)이 있습니까?", yes: "있음", no: "없음" },
            ].map((it) => (
              <div key={it.k} className="mb-2.5">
                <div className="text-sm text-slate-800 mb-1">{it.q}</div>
                <div className="flex gap-2">
                  <Chip active={final.iadCheck[it.k] === true} onClick={() => setFinal({ ...final, iadCheck: { ...final.iadCheck, [it.k]: true } })}>{it.yes}</Chip>
                  <Chip active={final.iadCheck[it.k] === false} onClick={() => setFinal({ ...final, iadCheck: { ...final.iadCheck, [it.k]: false } })}>{it.no}</Chip>
                </div>
              </div>
            ))}
            {iadVerdict && (
              <div className="rounded-xl border border-slate-300 bg-slate-100 p-3 text-sm font-semibold text-slate-800 mb-3">{iadVerdict}</div>
            )}
            <div className="space-y-2">
              <button onClick={() => { setFinal((f) => ({ ...f, stage: "IAD" })); setIadModal(false); }}
                className="w-full py-3 rounded-xl text-white text-sm font-semibold" style={{ backgroundColor: "#0369A1" }}>IAD 의심으로 분류</button>
              <button onClick={() => setIadModal(false)}
                className="w-full py-3 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">욕창으로 계속 사정</button>
            </div>
          </div>
        </div>
      )}

      {/* 하단 고정 액션 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-3" style={{ maxWidth: 480, margin: "0 auto" }}>
        {step === 1 && <PrimaryBtn onClick={() => setStep(2)} disabled={!canNext1}>다음 · 사진 촬영</PrimaryBtn>}
        {step === 2 && (photo
          ? <PrimaryBtn onClick={() => setStep(3)} disabled={multiWound && targets.length === 0}>{multiWound && targets.length === 0 ? "사정할 상처를 사진에서 탭하세요" : batch ? `이 사진 사용 · 다음 (상처 ${targets.length}개)` : "이 사진 사용 · 다음"}</PrimaryBtn>
          : <GhostBtn onClick={() => setStep(3)}>사진 없이 진행</GhostBtn>)}
        {step === 3 && <PrimaryBtn onClick={() => setStep(!batch && quickMode ? 6 : 4)} disabled={aiMeasurePending}>{aiMeasurePending ? "AI 측정값 확인 필요 — 위에서 확정하세요" : batch ? "다음 · AI 일괄 분석" : quickMode ? "다음 · 요약 확인" : "다음 · AI 분석"}</PrimaryBtn>}
        {step === 4 && !batch && aiStatus !== "loading" && aiStatus !== "done" && !photo && <PrimaryBtn onClick={() => setStep(5)}>다음 · 사정 입력</PrimaryBtn>}
        {step === 4 && !batch && aiStatus === "idle" && photo && <GhostBtn onClick={() => setStep(5)}>AI 없이 진행</GhostBtn>}
        {step === 4 && batch && (batchStatus === "done" || batchStatus === "manual") && <PrimaryBtn onClick={saveBatch} disabled={saving}>{saving ? "저장 중…" : `상처 ${targets.length}개 일괄 저장`}</PrimaryBtn>}
        {step === 5 && <PrimaryBtn onClick={() => setStep(6)}>다음 · 요약 확인</PrimaryBtn>}
        {step === 6 && (
          <div className="space-y-2">
            {multiWound && photo && (
              <button onClick={() => save(true)} disabled={saving}
                className="w-full py-2.5 rounded-xl border bg-white text-sm font-semibold disabled:opacity-40"
                style={{ borderColor: "#0369A1", color: "#0369A1" }}>
                {saving ? "저장 중…" : "저장 후 같은 사진으로 다음 상처 사정"}
              </button>
            )}
            <PrimaryBtn onClick={() => save(false)} disabled={saving}>{saving ? "저장 중…" : "결과 저장 · 완료"}</PrimaryBtn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 사정 상세 모달                                                       */
/* ------------------------------------------------------------------ */
function AssessmentDetail({ aid, onClose }) {
  const [rec, setRec] = useState(undefined);
  useEffect(() => { (async () => setRec(await loadFull(aid)))(); }, [aid]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: "rgba(15,23,42,0.6)" }} onClick={onClose}>
      <div className="bg-slate-50 w-full rounded-t-2xl overflow-y-auto" style={{ maxWidth: 480, maxHeight: "90vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div className="text-base font-bold text-slate-900">사정 상세</div>
          <button onClick={onClose} className="p-2 rounded-lg bg-white border border-slate-300"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3 pb-8">
          {rec === undefined && <p className="text-sm text-slate-500">불러오는 중…</p>}
          {rec === null && <p className="text-sm text-red-600">기록을 불러오지 못했습니다.</p>}
          {rec && (
            <>
              <Card>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-bold text-slate-900">{rec.location}</div>
                    <div className="text-xs text-slate-500">{rec.patientId} · {dateFull(rec.date)}</div>
                  </div>
                  <StageBadge code={rec.final.stage} />
                </div>
                {rec.photo && (
                  <div className="relative rounded-xl overflow-hidden border border-slate-200">
                    <img src={rec.photo.dataUrl} alt="wound" className="w-full block" />
                    <TargetRings points={rec.targets || (rec.target ? [rec.target] : [])} />
                  </div>
                )}
              </Card>
              <Card>
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <span className="text-slate-500">Size</span><span className="font-semibold text-right">{rec.size.lengthCm ? `${rec.size.lengthCm} × ${rec.size.widthCm} cm` : "—"}</span>
                  <span className="text-slate-500">Depth</span><span className="font-semibold text-right">{rec.size.depthCm ? `${rec.size.depthCm} cm` : "—"}</span>
                  <span className="text-slate-500">L×W Area</span><span className="font-semibold text-right">{rec.size.areaCm2 != null ? `${rec.size.areaCm2} cm²` : "—"}</span>
                  <span className="text-slate-500">Wound bed</span><span className="font-semibold text-right">{woundBedText(rec.final.woundBed)}</span>
                  <span className="text-slate-500">Exudate</span><span className="font-semibold text-right">{rec.final.exudateAmount ? `${rec.final.exudateAmount}${rec.final.exudateType ? ` · ${rec.final.exudateType}` : ""}` : "—"}</span>
                  <span className="text-slate-500">Periwound</span><span className="font-semibold text-right">{(rec.final.periwound || []).join(", ") || "—"}</span>
                  {rec.final.blanching ? (<><span className="text-slate-500">Blanching</span><span className="font-semibold text-right">{rec.final.blanching === "blanch" ? "하얗게 변함" : "변하지 않음"}</span></>) : null}
                  {iadVerdictShortFrom(rec.final.iadCheck) ? (<><span className="text-slate-500">IAD 감별</span><span className="font-semibold text-right">{iadVerdictShortFrom(rec.final.iadCheck)}</span></>) : null}
                  {rec.final.edge ? (<><span className="text-slate-500">Wound edge</span><span className="font-semibold text-right">{rec.final.edge === "present" ? "상피화 있음" : "상피화 없음"}</span></>) : null}
                  {rec.final.overrideReason ? (<><span className="text-slate-500">Override</span><span className="font-semibold text-right">{(OVERRIDE_REASONS.find((r) => r[0] === rec.final.overrideReason.code) || [])[1] || ""}</span></>) : null}
                  {clinChecksText(rec.final) ? (<><span className="text-slate-500">임상 확인</span><span className="font-semibold text-right">{clinChecksText(rec.final)}</span></>) : null}
                  {rec.size.undermining ? (<><span className="text-slate-500">잠식</span><span className="font-semibold text-right">{rec.size.undermining}</span></>) : null}
                  {rec.size.tunneling ? (<><span className="text-slate-500">터널</span><span className="font-semibold text-right">{rec.size.tunneling}</span></>) : null}
                  {rec.braden ? (<><span className="text-slate-500">Braden</span><span className="font-semibold text-right">{rec.braden.total}점 · {rec.braden.total <= 18 ? "고위험" : "저위험"}</span></>) : null}
                </div>
                {infectionFlag(rec.final) && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">감염 의심 소견이 기록된 사정입니다.</div>}
              </Card>
              <StageCriteria code={rec.final.stage} />
              {rec.ai && rec.ai.canAssess !== false && (
                <Card>
                  <SectionTitle>AI 제안 (당시)</SectionTitle>
                  <div className="mb-1"><StageBadge code={mapAiStage(rec.ai.suggestedStage)} /> <span className="text-xs text-slate-500 ml-2">불확실성: {rec.ai.uncertainty || "—"}</span></div>
                  <div className="mb-2"><PhotoQualityLine pq={rec.ai.photoQuality} /></div>
                  {Array.isArray(rec.ai.keyFindings) && rec.ai.keyFindings.length > 0 && (
                    <div className="mb-2">
                      <div className="text-xs font-bold text-slate-700 mb-1">관찰 소견</div>
                      <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                        {rec.ai.keyFindings.map((f, i) => <p key={i}>✓ {f}</p>)}
                      </div>
                    </div>
                  )}
                  <p className="text-sm text-slate-800 leading-relaxed">{rec.ai.rationale}</p>
                  {Array.isArray(rec.ai.differentials) && rec.ai.differentials.length > 0 && (
                    <div className="mt-2">
                      <div className="text-xs font-bold text-slate-700 mb-1">배제 근거</div>
                      <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                        {rec.ai.differentials.map((d, i) => <p key={i}>✕ {stageLabel(mapAiStage(d.stage))} 아님 — {d.reason}</p>)}
                      </div>
                    </div>
                  )}
                  {(rec.ai.cautions || []).map((c, i) => <p key={i} className="text-xs text-amber-800 mt-1">⚠ {c}</p>)}
                  {rec.ai.healing && (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="text-xs font-bold text-slate-700">Healing 평가 · 이전 사진 비교</div>
                      <div className="text-sm font-bold text-slate-900 mt-1">{rec.ai.healing.status}</div>
                      {(rec.ai.healing.evidence || []).map((e, i) => <p key={i} className="text-xs text-slate-600 mt-1">✓ {e}</p>)}
                    </div>
                  )}

                </Card>
              )}
              <DisclaimerBox />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 비교 뷰                                                              */
/* ------------------------------------------------------------------ */
function CompareView({ idx, woundId, onClose }) {
  const list = (idx.wounds[woundId] ? idx.wounds[woundId].assessmentIds : [])
    .map((id) => idx.assess[id]).filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const [selA, setSelA] = useState(list.length >= 2 ? list[list.length - 2].id : (list[0] || {}).id);
  const [selB, setSelB] = useState((list[list.length - 1] || {}).id);
  const [recA, setRecA] = useState(null);
  const [recB, setRecB] = useState(null);
  useEffect(() => { (async () => { if (selA) setRecA(await loadFull(selA)); })(); }, [selA]);
  useEffect(() => { (async () => { if (selB) setRecB(await loadFull(selB)); })(); }, [selB]);

  const sumA = idx.assess[selA], sumB = idx.assess[selB];
  let delta = null;
  if (sumA && sumB && sumA.areaCm2 && sumB.areaCm2) delta = fmt1(((sumB.areaCm2 - sumA.areaCm2) / sumA.areaCm2) * 100);

  const Col = ({ label, sum, rec }) => (
    <div className="flex-1 min-w-0">
      <div className="text-xs font-bold text-slate-600 mb-1">{label}</div>
      {rec && rec.photo
        ? (
          <div className="relative rounded-xl overflow-hidden border border-slate-200">
            <img src={rec.photo.dataUrl} alt={label} className="w-full block" />
            <TargetRings points={rec.targets || (rec.target ? [rec.target] : [])} />
          </div>
        )
        : <div className="w-full h-32 rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center text-xs text-slate-400">사진 없음</div>}
      {sum && (
        <div className="mt-2 text-xs text-slate-700 space-y-0.5">
          <p className="font-semibold">{dateShort(sum.date)}</p>
          <p>{sum.lengthCm ? `${sum.lengthCm} × ${sum.widthCm} cm` : "크기 미입력"}</p>
          <p>{sum.areaCm2 ? `Area ${sum.areaCm2} cm²` : ""}</p>
          <p><StageBadge code={sum.stage} /></p>
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: "rgba(15,23,42,0.6)" }} onClick={onClose}>
      <div className="bg-slate-50 w-full rounded-t-2xl overflow-y-auto" style={{ maxWidth: 480, maxHeight: "90vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div className="text-base font-bold text-slate-900 flex items-center gap-1.5"><ArrowLeftRight size={16} /> 시점 비교</div>
          <button onClick={onClose} className="p-2 rounded-lg bg-white border border-slate-300"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3 pb-8">
          <div className="grid grid-cols-2 gap-2">
            <select value={selA || ""} onChange={(e) => setSelA(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 bg-white text-sm">
              {list.map((a) => <option key={a.id} value={a.id}>{dateShort(a.date)} ({stageLabel(a.stage)})</option>)}
            </select>
            <select value={selB || ""} onChange={(e) => setSelB(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 bg-white text-sm">
              {list.map((a) => <option key={a.id} value={a.id}>{dateShort(a.date)} ({stageLabel(a.stage)})</option>)}
            </select>
          </div>
          <Card>
            <div className="flex gap-3">
              <Col label="Previous" sum={sumA} rec={recA} />
              <Col label="Current" sum={sumB} rec={recB} />
            </div>
          </Card>
          {delta != null && (
            <Card>
              <p className="text-sm font-semibold" style={{ color: delta < 0 ? "#047857" : delta > 0 ? "#B91C1C" : "#334155" }}>
                Estimated wound area {delta < 0 ? "decreased" : delta > 0 ? "increased" : "unchanged"}{delta !== 0 ? ` by ${Math.abs(delta)}%` : ""}.
              </p>
              {sumA && sumB && sumA.stage !== sumB.stage && (
                <p className="text-xs text-slate-600 mt-1">Stage: {stageLabel(sumA.stage)} → {stageLabel(sumB.stage)}</p>
              )}
              <p className="text-xs text-slate-500 mt-2">면적은 L×W 근사치이며 촬영 조건에 따라 오차가 있을 수 있습니다.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 상처 상세 화면 (추적)                                                */
/* ------------------------------------------------------------------ */
function WoundScreen({ idx, woundId, onBack, onFollowUp }) {
  const w = idx.wounds[woundId];
  const [detailId, setDetailId] = useState(null);
  const [compare, setCompare] = useState(false);
  if (!w) return <div className="p-4 text-sm text-slate-500">상처 기록을 찾을 수 없습니다.</div>;
  const p = idx.patients[w.patientId] || {};
  const list = (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const chartData = list.filter((a) => a.areaCm2 != null).map((a) => ({ d: dateShort(a.date), area: a.areaCm2 }));

  return (
    <div className="pb-8">
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex items-center px-3 py-3 gap-2">
        <button onClick={onBack} className="p-2 rounded-lg bg-white border border-slate-300"><ChevronLeft size={18} /></button>
        <div className="flex-1">
          <div className="text-base font-bold text-slate-900">{w.location}{w.sub ? ` (${w.sub})` : ""}</div>
          <div className="text-xs text-slate-500">{w.patientId}{p.ward ? ` · ${p.ward}` : ""}{p.room ? ` ${p.room}` : ""} · 사정 {list.length}회</div>
        </div>
        {list.length >= 2 && (
          <button onClick={() => setCompare(true)} className="px-3 py-2 rounded-lg text-white text-xs font-semibold flex items-center gap-1" style={{ backgroundColor: "#0369A1" }}>
            <ArrowLeftRight size={14} /> 비교
          </button>
        )}
      </div>
      <div className="p-4 space-y-3">
        <button onClick={() => onFollowUp && onFollowUp(w.id)}
          className="w-full py-3.5 rounded-xl text-white text-base font-semibold flex items-center justify-center gap-2"
          style={{ backgroundColor: "#0369A1" }}>
          <Camera size={18} /> F/U 사정 시작 — 이 상처 이어서 기록
        </button>
        {chartData.length >= 2 && (
          <Card>
            <SectionTitle>Wound size trend (L×W area, cm²)</SectionTitle>
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                  <XAxis dataKey="d" tick={{ fontSize: 11, fill: "#64748B" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748B" }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="area" stroke="#0369A1" strokeWidth={2.5} dot={{ r: 4, fill: "#0369A1" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}
        <div className="space-y-2">
          {[...list].reverse().map((a) => (
            <button key={a.id} onClick={() => setDetailId(a.id)} className="w-full text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-slate-900">{dateFull(a.date)}</div>
                <div className="text-xs text-slate-500">{a.lengthCm ? `${a.lengthCm} × ${a.widthCm} cm` : "크기 미입력"}{a.areaCm2 ? ` · ${a.areaCm2} cm²` : ""}</div>
              </div>
              <StageBadge code={a.stage} />
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          ))}
        </div>
      </div>
      {detailId && <AssessmentDetail aid={detailId} onClose={() => setDetailId(null)} />}
      {compare && <CompareView idx={idx} woundId={woundId} onClose={() => setCompare(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 기록 화면                                                            */
/* ------------------------------------------------------------------ */
function RecordsScreen({ idx, initialTab, onBack, onOpenWound }) {
  const [tab, setTab] = useState(initialTab || "patients");
  const wounds = Object.values(idx.wounds);
  const patients = Object.values(idx.patients);
  const recent = Object.values(idx.assess).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);

  return (
    <div className="pb-8">
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center px-3 py-3 gap-2">
          <button onClick={onBack} className="p-2 rounded-lg bg-white border border-slate-300"><ChevronLeft size={18} /></button>
          <div className="text-base font-bold text-slate-900">환자 · 욕창 기록</div>
        </div>
        <div className="flex gap-2 px-4 pb-3">
          {[{ k: "patients", l: "환자별" }, { k: "recent", l: "최근 사정" }].map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={"px-4 py-1.5 rounded-full text-sm font-semibold border " + (tab === t.k ? "text-white border-transparent" : "bg-white text-slate-600 border-slate-300")}
              style={tab === t.k ? { backgroundColor: "#0369A1" } : {}}>{t.l}</button>
          ))}
        </div>
      </div>
      <div className="p-4 space-y-4">
        {patients.length === 0 && (
          <Card><p className="text-sm text-slate-500 text-center py-6">저장된 기록이 없습니다.<br />홈에서 새 욕창 사정을 시작하세요.</p></Card>
        )}
        {tab === "patients" && patients.map((p) => {
          const pw = wounds.filter((w) => w.patientId === p.id);
          return (
            <div key={p.id}>
              <div className="text-xs font-bold text-slate-500 mb-1.5 px-1">{p.id}{p.ward ? ` · ${p.ward}` : ""}{p.room ? ` ${p.room}` : ""}{p.sex ? ` · ${p.sex}` : ""}{p.age ? ` ${p.age}세` : ""}</div>
              <div className="space-y-2">
                {pw.map((w) => {
                  const last = (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
                  return (
                    <button key={w.id} onClick={() => onOpenWound(w.id)} className="w-full text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-slate-900">{w.location}{w.sub ? ` (${w.sub})` : ""}</div>
                        <div className="text-xs text-slate-500">
                          사정 {(w.assessmentIds || []).length}회{last ? ` · 최근 ${dateShort(last.date)}` : ""}{last && last.lengthCm ? ` · ${last.lengthCm}×${last.widthCm} cm` : ""}
                        </div>
                      </div>
                      {last && <StageBadge code={last.stage} />}
                      <ChevronRight size={16} className="text-slate-400" />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {tab === "recent" && recent.map((a) => {
          const w = idx.wounds[a.woundId] || {};
          return (
            <button key={a.id} onClick={() => onOpenWound(a.woundId)} className="w-full text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-slate-900">{w.patientId} · {w.location}{w.sub ? ` (${w.sub})` : ""}</div>
                <div className="text-xs text-slate-500">{dateFull(a.date)}{a.lengthCm ? ` · ${a.lengthCm}×${a.widthCm} cm` : ""}</div>
              </div>
              <StageBadge code={a.stage} />
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 정보/설정                                                            */
/* ------------------------------------------------------------------ */
function InfoScreen({ onBack, onReset }) {
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [infoErr, setInfoErr] = useState("");
  const reset = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 4000);
      return;
    }
    setConfirmDel(false); setBusy(true); setInfoErr("");
    try {
      const keys = await storage.listKeys("pi:");
      for (const key of keys) {
        try { await storage.removeItem(key); } catch (e) {}
      }
      onReset();
    } catch (e) { setInfoErr("삭제 중 오류가 발생했습니다."); }
    setBusy(false);
  };
  return (
    <div className="pb-8">
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex items-center px-3 py-3 gap-2">
        <button onClick={onBack} className="p-2 rounded-lg bg-white border border-slate-300"><ChevronLeft size={18} /></button>
        <div className="text-base font-bold text-slate-900">정보 · 설정</div>
      </div>
      <div className="p-4 space-y-3">
        <Card>
          <SectionTitle>원칙</SectionTitle>
          <p className="text-sm text-slate-700 leading-relaxed">이 앱은 AI가 의료진을 대체하는 앱이 아닙니다. 모든 AI 결과는 "AI-assisted assessment"로 제공되며, 최종적인 stage 및 치료 판단은 의료진이 합니다. AI가 확실하게 판단하기 어려운 경우 억지로 하나의 stage를 제시하지 않고 추가적인 임상 확인이 필요함을 표시합니다.</p>
        </Card>
        <DisclaimerBox />
        <Card>
          <SectionTitle>프로토타입의 한계</SectionTitle>
          <div className="text-sm text-slate-700 leading-relaxed space-y-1.5">
            <p>· AI 분석은 범용 vision 모델(Claude) 기반이며 욕창 판독에 대해 임상적으로 검증되지 않았습니다. 정량 confidence를 제공하지 않는 이유입니다.</p>
            <p>· 크기 측정은 마커 캘리브레이션 정확도(마커–상처 동일 평면, 수직 촬영)에 의존합니다.</p>
            <p>· Depth와 감염 관련 소견은 사진으로 판단하지 않으며 사정자가 직접 입력합니다.</p>
            <p>· 데이터는 이 앱 사용자별 저장소에 보관되며 병원 EMR과 연동되지 않습니다.</p>
            <p>· 권고는 NPIAP/EPUAP/PPPIA 국제 가이드라인 원칙을 요약한 초안이며, 드레싱은 상표 없는 분류 수준으로만 제시합니다. 기관 도입 시 해당 기관 프로토콜에 맞춘 검토·수정이 필요합니다.</p>
          </div>
        </Card>
        <Card>
          <SectionTitle>실사용 전 필요한 검토</SectionTitle>
          <p className="text-sm text-slate-700 leading-relaxed">임상 도입 전 의료기기(SaMD) 해당 여부에 대한 식약처 규제 검토, 개인정보보호법·의료법상 의무기록 관련 검토, 병원 정보보안 및 EMR 연동 검토, 그리고 연구 목적 사용 시 IRB 승인이 필요합니다.</p>
        </Card>
        <Card>
          <SectionTitle>데이터 관리</SectionTitle>
          <button onClick={reset} disabled={busy} className="w-full py-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
            <Trash2 size={16} /> {busy ? "삭제 중…" : confirmDel ? "다시 탭하면 영구 삭제됩니다" : "모든 데이터 삭제"}
          </button>
          {infoErr && <p className="text-xs text-red-600 mt-2">{infoErr}</p>}
        </Card>
        <p className="text-center text-xs text-slate-400">PI Assist · MVP v1.0.4 (artifact-safe env)</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 욕창 위험도 평가 (Braden)                                            */
/* ------------------------------------------------------------------ */
function BradenScreen({ onBack }) {
  const recMode = "international";
  const [v, setV] = useState(emptyBraden());
  const total = bradenTotal(v);
  const risk = bradenRisk(total);
  return (
    <div className="pb-8">
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex items-center px-3 py-3 gap-2">
        <button onClick={onBack} className="p-2 rounded-lg bg-white border border-slate-300"><ChevronLeft size={18} /></button>
        <div>
          <div className="text-base font-bold text-slate-900">욕창 위험도 평가</div>
          <div className="text-xs text-slate-500">Braden Scale · {recMode === "international" ? "표준 위험 분류" : "원내 알고리즘 기준"}</div>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <Card>
          <BradenForm value={v} onChange={setV} />
        </Card>
        {total != null && risk && (
          <>
            <div className={"rounded-xl border p-4 " + (risk.high ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50")}>
              <div className={"text-lg font-bold " + (risk.high ? "text-red-700" : "text-emerald-700")}>총점 {total}점 — {risk.label}</div>
              <div className={"text-xs mt-1 " + (risk.high ? "text-red-700" : "text-emerald-700")}>표준 분류 참고: {bradenBand(total)}</div>
            </div>
            <Card>
              <SectionTitle>{risk.high ? (recMode === "international" ? "예방적 중재 (가이드라인 원칙)" : "예방적 중재 적용 (원내 알고리즘)") : (recMode === "international" ? "권장 관리 (가이드라인 원칙)" : "권장 관리 (원내 알고리즘)")}</SectionTitle>
              <div className="text-sm text-slate-700 leading-relaxed space-y-1">
                {risk.high ? (recMode === "international" ? (
                  <>
                    <p>· 개별화된 체위변경 일정 수립·시행(활동·기동성·피부 상태 고려)</p>
                    <p>· 고사양 압력재분배 매트리스 등 support surface 적용</p>
                    <p>· 발뒤꿈치 부양(heel elevation) 및 뼈 돌출부 압력 최소화</p>
                    <p>· 피부 청결·보습 및 습기 관리, 피부보호제 적용</p>
                    <p>· 영양 스크리닝 및 필요 시 보충 고려</p>
                    <p>· 뼈 돌출부 예방적 드레싱 적용 고려</p>
                  </>
                ) : (
                  <>
                    <p>· 자세변경 교육 및 시행</p>
                    <p>· 매트리스, 베개, 써티패드 등 지지면 적용 및 힐부츠 적용</p>
                    <p>· 피부관리 교육 및 주기적 피부 사정</p>
                    <p>· 영양관리 교육</p>
                    <p>· 예방적 드레싱 적용 가능</p>
                  </>
                )) : (
                  <>
                    <p>· 정기적인 피부 사정</p>
                    <p>· 욕창 위험도 재평가</p>
                  </>
                )}
                <p>· 피부 발적 발견 시 blanching erythema 확인(압박 시 하얗게 변하는지)</p>
              </div>
            </Card>
          </>
        )}
        <p className="text-center text-xs text-slate-400">새 욕창 사정 1단계에서 입력하면 사정 기록과 함께 저장됩니다.</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 홈 & 앱 루트                                                         */
/* ------------------------------------------------------------------ */
function Home({ idx, go }) {
  const nAssess = Object.keys(idx.assess).length;
  const MenuBtn = ({ icon, title, sub, onClick, primary }) => (
    <button onClick={onClick}
      className={"w-full text-left rounded-2xl p-4 flex items-center gap-3 border shadow-sm " + (primary ? "text-white border-transparent" : "bg-white border-slate-200")}
      style={primary ? { backgroundColor: "#0369A1" } : {}}>
      <div className={"p-2.5 rounded-xl " + (primary ? "" : "bg-slate-100")} style={primary ? { backgroundColor: "rgba(255,255,255,0.15)" } : {}}>{icon}</div>
      <div className="flex-1">
        <div className={"text-base font-bold " + (primary ? "text-white" : "text-slate-900")}>{title}</div>
        <div className={"text-xs " + (primary ? "" : "text-slate-500")} style={primary ? { color: "#BAE6FD" } : {}}>{sub}</div>
      </div>
      <ChevronRight size={18} className={primary ? "text-white" : "text-slate-400"} />
    </button>
  );
  return (
    <div className="p-4 space-y-4 pb-8">
      <div className="pt-4 pb-1">
        <div className="text-2xl font-bold text-slate-900">PI Assist</div>
        <div className="text-sm text-slate-500 mt-0.5">욕창 사정 보조 · AI-assisted pressure injury assessment</div>
      </div>
      <div className="space-y-2.5">
        <MenuBtn primary icon={<Camera size={22} className="text-white" />} title="새로운 욕창 사정" sub="사진 촬영 → 측정 → AI 분석 → 기록" onClick={() => go({ name: "new" })} />
        <MenuBtn icon={<FolderOpen size={22} className="text-slate-700" />} title="환자 · 욕창 기록" sub="환자별 상처 추적 및 크기 trend" onClick={() => go({ name: "records", tab: "patients" })} />
        <MenuBtn icon={<ClipboardList size={22} className="text-slate-700" />} title="이전 사정 결과" sub={nAssess ? `최근 사정 ${nAssess}건` : "저장된 사정 없음"} onClick={() => go({ name: "records", tab: "recent" })} />
        <MenuBtn icon={<Activity size={22} className="text-slate-700" />} title="욕창 위험도 평가" sub="Braden Scale · 예방적 중재 확인" onClick={() => go({ name: "braden" })} />
        <MenuBtn icon={<Info size={22} className="text-slate-700" />} title="정보 · 설정" sub="원칙 · 한계 · 데이터 관리" onClick={() => go({ name: "info" })} />
      </div>
      <div className="pt-2"><DisclaimerBox /></div>
      <p className="text-center text-xs text-slate-400">프로토타입 — 검증된 의료기기가 아니며 임상 적용 전 규제·보안 검토가 필요합니다.</p>
    </div>
  );
}

export default function App() {
  const [idx, setIdx] = useState(null);
  const [screen, setScreen] = useState({ name: "home" });

  useEffect(() => {
    (async () => {
      setIdx(await loadIndex());
    })();
  }, []);

  if (!idx) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-sm text-slate-500">불러오는 중…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto min-h-screen bg-slate-50" style={{ maxWidth: 480 }}>
        {screen.name === "home" && <Home idx={idx} go={setScreen} />}
        {screen.name === "new" && (
          <NewAssessment idx={idx} onIdxUpdate={setIdx}
            initFollowWoundId={screen.followWoundId}
            onCancel={() => setScreen({ name: "home" })}
            onSaved={(nIdx, woundId) => { setIdx(nIdx); setScreen({ name: "wound", woundId }); }} />
        )}
        {screen.name === "records" && (
          <RecordsScreen idx={idx} initialTab={screen.tab}
            onBack={() => setScreen({ name: "home" })}
            onOpenWound={(woundId) => setScreen({ name: "wound", woundId, from: "records" })} />
        )}
        {screen.name === "wound" && (
          <WoundScreen idx={idx} woundId={screen.woundId}
            onFollowUp={(wid) => setScreen({ name: "new", followWoundId: wid })}
            onBack={() => setScreen(screen.from === "records" ? { name: "records" } : { name: "home" })} />
        )}
        {screen.name === "braden" && <BradenScreen onBack={() => setScreen({ name: "home" })} />}
        {screen.name === "info" && (
          <InfoScreen
            onBack={() => setScreen({ name: "home" })}
            onReset={() => { setIdx(emptyIndex()); setProtocol(""); setRecMode("hospital"); setScreen({ name: "home" }); }} />
        )}
      </div>
    </div>
  );
}
