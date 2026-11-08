import {createProfileStorage} from "./profile-storage.mjs";
import {createRawRecordStorage} from "./profile-raw-storage.mjs";
import {getAnalysisHeaders,refreshAnalysisCredits} from "./AccountCredits.jsx";
import HomeDraftResume from "./HomeDraftResume.jsx";
import {AssessmentDraftGate,useAssessmentDraft,draftValue,DraftStatus} from "./AssessmentDraft.jsx";
import "./draft.css";
import AccountCredits from "./AccountCredits.jsx";
import "./account.css";
import React, { useState, useEffect, useRef } from "react";
import heic2any from "heic2any";
import {prepareRulerImage, mapScaleToPhoto} from "./ruler-scale.js";
import {detectHospitalRuler} from "./hospital-ruler.js";
import {
  Camera, Upload, ClipboardList, FolderOpen, Info, BookOpen, ChevronLeft,
  AlertTriangle, Sparkles, Trash2, RefreshCw, Ruler, Activity, Check, Settings,
  ArrowLeftRight, X, ChevronRight, Home as HomeIcon
} from "lucide-react";
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const phoneBackActions=new Set();
function usePhoneBack(active,handler,priority=0){const latest=useRef(handler);latest.current=handler;useEffect(()=>{if(!active)return;const action={priority,run:()=>latest.current()};phoneBackActions.add(action);return()=>phoneBackActions.delete(action);},[active,priority]);}
function dispatchPhoneBack(){const action=[...phoneBackActions].sort((a,b)=>b.priority-a.priority)[0];if(!action)return false;action.run();return true;}

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
    const r = await window.storage.get(key); return r && r.value != null ? r.value : null;
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
      req.onerror = () => { dbp = null; reject(req.error); };
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
      const v = await tx("readonly", (st) => st.get(key)); return v == null ? null : v;
    },
    async setItem(key, value) { return tx("readwrite", (st) => st.put(value, key)); },
    async removeItem(key) { return tx("readwrite", (st) => st.delete(key)); },
    async listKeys(prefix) {
      const keys = await tx("readonly", (st) => st.getAllKeys()); return (keys || []).filter((k) => typeof k === "string" && k.startsWith(prefix));
    },
  };
})();

const rawRecordStorage=createRawRecordStorage();
const storage=createProfileStorage(rawRecordStorage);

const IDX_KEY = "pi:index:v1";
const A_KEY = (id) => "pi:a:" + id;
const emptyIndex = () => ({ patients: {}, wounds: {}, assess: {} });

async function loadIndex() {
  const raw = await storage.getItem(IDX_KEY);
  if (raw == null) return emptyIndex();
  const index = JSON.parse(raw);
  if (!index || !['patients','wounds','assess'].every(k => index[k] && typeof index[k] === 'object' && !Array.isArray(index[k]))) throw new Error('기록 목록 형식을 확인할 수 없습니다.');
  return index;
}
function orderedWoundAssessments(idx, woundId, cutoffDate = null) {
  const cutoff = cutoffDate ? new Date(cutoffDate + 'T23:59:59.999').getTime() : Infinity;
  return ((idx.wounds[woundId] || {}).assessmentIds || []).map(id => idx.assess[id]).filter(a => a && Number.isFinite(new Date(a.date).getTime()) && new Date(a.date).getTime() <= cutoff).sort((a,b) => new Date(b.date)-new Date(a.date) || String(b.id).localeCompare(String(a.id)));
}
async function removeAllRecords() {
  const keys = await storage.listKeys('pi:');
  // Index is removed last; a failure is propagated instead of reporting success.
  for (const key of keys.filter(k => k !== IDX_KEY)) await storage.removeItem(key);
  await storage.removeItem(IDX_KEY);
  await storage.clearLegacyBackup();
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
  { code: "HEALED", label: "치유됨", desc: "완전 폐쇄·상피화 · Stage 아님" },
  { code: "NONE", label: "욕창 아님", desc: "Blanchable erythema(반응성 충혈)" },
  { code: "IAD", label: "IAD 의심", desc: "실금관련피부염 — 습기 손상" },
];
const stageLabel = (code) => (STAGES.find((s) => s.code === code) || {}).label || "미정";

const STAGE_CRITERIA = {
  "HEALED": {
    crit: [
      "현재 상처가 완전히 닫히고 완전 상피화된 상태",
      "치유된 욕창은 Stage 1~4로 역단계화하지 않음",
      "과거 욕창의 원래 Stage는 병력·이전 사정 기록으로 유지",
    ],
    diff: "완전 폐쇄·상피화가 아니라면 현재의 개방성 욕창과 별도로 재사정.",
  },
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
    { c: "⑤ 완전 폐쇄·상피화", r: "치유됨(HEALED) — Stage가 아니며 과거 Stage 3/4를 2·1로 역단계화하지 않음" },
    { c: "⑥ 판단 근거 불충분", r: "보이지 않음 ≠ 없음 → 미정, WOCN·담당의 재사정" },
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

const TERM_LABELS={"None":"없음","Scant":"극소량","Small":"소량","Moderate":"중간","Large":"다량","Serous":"장액성","Serosanguineous":"장액혈성","Sanguineous":"혈성","Purulent":"농성","Intact":"정상 피부","Erythema":"홍반","Maceration":"침연","Excoriation":"표피 손상","Induration":"경결","Edema":"부종","Mild":"약함","Strong":"강함"};
function BilingualLabel({code,korean}){return <span className="flex flex-col items-center text-center leading-snug"><span className="font-semibold">{korean || TERM_LABELS[code] || code}</span><span className="text-xs mt-1 opacity-75 break-words max-w-full">{code}</span></span>;}
function TermGuide(){return <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer text-sky-700 py-2">용어 설명</summary><div className="mt-2 rounded-xl bg-sky-50 p-3 space-y-2"><p>육아조직 · Granulation: 상처 회복 과정에서 생기는 새 조직.</p><p>부육 · Slough: 상처 바닥의 비활성 조직. 색만으로 확정하지 않습니다.</p><p>가피 · Eschar: 상처를 덮는 괴사조직. 짙은 변색과 구별이 필요합니다.</p><p>침연 · Maceration: 습기로 피부가 불고 약해진 상태.</p><p>경결 · Induration: 주변 피부가 단단하게 만져지는 상태.</p><p>표피 손상 · Excoriation: 피부 표면이 벗겨지거나 손상된 상태.</p><p>상피화 · Epithelialization: 상처 가장자리에서 새 피부가 자라는 과정.</p><p>장액혈성 · Serosanguineous: 장액에 혈액이 섞인 양상.</p></div></details>;}
const EXU_AMT = ["None", "Scant", "Small", "Moderate", "Large"];
const exudateText = (fin) => !EXU_AMT.includes(fin?.exudateAmount) ? "미입력" : (fin.exudateAmount==='Moderate'?'중간량':TERM_LABELS[fin.exudateAmount]) + (fin.exudateType ? " · " + TERM_LABELS[fin.exudateType] : "");
const EXU_TYPE = ["Serous", "Serosanguineous", "Sanguineous", "Purulent"];
const PERIWOUND = ["Intact", "Erythema", "Maceration", "Excoriation", "Induration", "Edema"];
const ODOR = ["None", "Mild", "Moderate", "Strong"];
const WB_KEYS = [
  { k: "granulation", l: "육아조직", en: "Granulation" },
  { k: "slough", l: "부육", en: "Slough" },
  { k: "eschar", l: "가피", en: "Eschar" },
  { k: "necrotic", l: "괴사조직", en: "Necrotic tissue" },
  { k: "dermis", l: "노출된 진피", en: "Exposed dermis" },
  { k: "other", l: "기타", en: "Other" },
];
const WB_LEGACY = { epithelial: "Epithelial(구)" };
const wbLabel = (k) => ((WB_KEYS.find((w) => w.k === k) || {}).l || WB_LEGACY[k] || k);

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
async function normalizeImageFile(file) {
  const isHeic = /heic|heif/i.test(file?.type || "") || /\.hei[cf]$/i.test(file?.name || "");
  if (!isHeic) return file;
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  return new File([blob], (file.name || "photo").replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
}

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

let aiTransmissionAccepted = false;
const AI_REQUEST_TIMEOUT_MS = 60000;
async function callClaude(dataUrls, promptText, options = {}) {
  if (!aiTransmissionAccepted) {
    if (!window.confirm("AI 분석을 위한 외부 전송 안내\n\n전송 항목\n선택한 상처 사진과 분석에 필요한 부위·크기·깊이·이전 사정 정보입니다. 경과 비교 시 이전 사진도 포함됩니다.\n\n전송 업체·위치\nRender 서버(미국 Ohio)를 거쳐 Anthropic의 Claude API로 전송합니다. Anthropic은 미국에 저장하며, 미국 외 국가에서도 처리할 수 있습니다.\n\n보관·삭제\n현재 Anthropic 조직 기본 설정은 30일 보관입니다. 법령·안전 조사 등에 따른 예외가 있습니다. 앱에서 기록을 삭제하거나 탈퇴해도 외부 데이터가 즉시 삭제되지는 않습니다.\n\n환자 정보 확인\n이름·얼굴·환자번호 등 식별정보를 제외하세요. 상처 사진은 건강정보가 될 수 있습니다. 이 확인이 환자 동의나 기관의 적법한 처리 권한을 대신하지 않습니다.\n\n전송에 동의하면 ‘확인’, 원하지 않으면 ‘취소’를 눌러주세요. 취소하면 AI 요청을 보내지 않으며 수동 사정·기록을 계속 이용할 수 있습니다.")) throw new Error("외부 AI 전송을 취소했습니다. 수동 사정으로 진행할 수 있습니다.");
    aiTransmissionAccepted = true;
  }
  const controller = new AbortController();
  const relay = () => controller.abort();
  let timedOut = false;
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', relay, {once:true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, AI_REQUEST_TIMEOUT_MS);
  try {
    const parts = (dataUrls || []).map(u => typeof u === 'string' && u.includes(',') ? u.split(',')[1] : u);
    const authHeaders=await getAnalysisHeaders();
    const requestId=crypto.randomUUID();
    const res = await fetch(AI_PROXY_BASE + '/api/ai/credited-analyze', {method:'POST',headers:{'Content-Type':'application/json',...authHeaders},body:JSON.stringify({images:parts,prompt:promptText,requestId}),signal:controller.signal});
    const data = await res.json();
    if (!res.ok || !data || data.error) throw new Error(data?.error || 'AI 프록시 오류 (' + res.status + ')');
    return data.text || '';
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? '60초 동안 응답이 없어 분석을 중단했습니다. 재시도하거나 수동 사정으로 진행하세요.' : '분석을 취소했습니다. 입력한 사진과 사정값은 유지됩니다.');
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort',relay);
    void refreshAnalysisCredits();
  }
}
function normalizeStageEvidence(result) {
  if (!result || typeof result !== 'object') throw new Error('AI 결과 형식을 확인할 수 없습니다.');
  const r = {...result};
  const evidence = r.stageEvidence || {};
  const isU = ['U','Unstageable'].includes(r.suggestedStage);
  const insufficientU = isU && (evidence.tissueLoss !== 'fullThickness' || !['slough','eschar'].includes(evidence.covering));
  if (r.photoQuality?.status === 'FAIL' || r.photoQuality?.adequate === false) {
    r.suggestedStage = '미정'; r.canAssess = false; r.uncertainty = '높음';
  } else if (insufficientU) {
    r.originalSuggestedStage = r.suggestedStage;
    r.suggestedStage = '미정'; r.uncertainty = '높음'; r.woundBed = null;
    r.rationale = '전층 조직 손실과 가피·부육의 피복을 구분할 근거가 충분하지 않아 단계 제안을 보류합니다. 짙은 변색·혈성 수포와 실제 가피를 직접 관찰하여 DTPI 등과 감별하세요.';
    r.cautions = [...(Array.isArray(r.cautions)?r.cautions:[]), '짙은 색이나 사진에서 깊이가 보이지 않는다는 이유만으로 Unstageable을 판단하지 않습니다.'];
    r.differentials = [{stage:'DTPI',reason:'피부 표면·변색·혈성 수포 임상 확인 필요'},{stage:'Unstageable',reason:'전층 손실과 가피·부육 피복 근거 부족'}];
  }
  return r;
}

function buildAnalysisPrompt(ctx) {
  const sizeStr = ctx.lengthCm ? `, 측정 길이=${ctx.lengthCm}cm, 폭=${ctx.widthCm}cm` : "";
  const depthStr = ctx.depthCm ? `, 깊이=${ctx.depthCm}cm` : "";
  return `당신은 병원 간호사의 욕창(pressure injury) 사정을 보조하는 임상 의사결정 지원 도구입니다. 첨부된 상처 사진을 NPIAP 분류 기준으로 분석하여 구조화된 '사정 초안'을 JSON으로만 출력하세요.

컨텍스트: 부위=${ctx.location || "미상"}${sizeStr}${depthStr}${ctx.previousStage ? `, 이전 사정 Stage=${ctx.previousStage}` : ""}
${ctx.multiTarget ? "\n대상 지정: 이 사진에는 병변이 여러 개 있습니다. 흰색 테두리의 청록색 원으로 표시된 병변 하나만 분석 대상입니다. 원 밖의 병변은 stage 판정·keyFindings·woundBed에 포함하지 말고, 필요하면 존재만 cautions에 한 줄로 언급하세요. 컨텍스트의 측정값도 표시된 병변의 값입니다." + (ctx.zoomHint ? " 두 번째 이미지는 표시된 병변만 확대한 것으로, 확대 이미지 중앙의 병변이 분석 대상입니다." : "") + "\n" : ""}
${ctx.followUpCompare ? "\n경과 비교: 첫 번째 이미지는 이전 사정 사진이고 마지막 이미지는 현재 사정 사진입니다. 현재 사진의 stage는 현재 사진 기준으로 판정하고, healing은 두 사진에서 실제로 보이는 변화만 비교하세요.\n" : ""}
핵심 원칙:
A) 최종 판단은 의료진이 합니다. 이 출력은 "Suggested Stage" 참고 초안이며, 진단을 확정하는 표현을 쓰지 마세요.
B) 사진에서 확인할 수 없는 것을 추측하지 마세요. "보이지 않음"과 "존재하지 않음"을 엄격히 구분하세요 — 구조물이 사진에서 보이지 않는다는 이유만으로 그 손상이 없다고 단정하지 마세요. 판단 근거가 불충분하면 suggestedStage="미정".
C) 숫자 confidence를 만들지 마세요. uncertainty는 "낮음"/"중간"/"높음"만 사용하고, 불확실하면 "높음"으로 설정하세요.
D) 사진만으로 감염을 진단하지 마세요.
E) 사진만으로 상처의 실제 크기(cm)를 추정하지 마세요. 크기는 컨텍스트로 제공된 측정값만 사용하며, rationale·keyFindings에 cm 추정치를 쓰지 마세요.

단계 판정 로직 — 반드시 아래 순서와 우선순위를 따르세요:
현재 사진에서 먼저 "개방성 피부손상이 실제로 존재하는지" 확인하세요. 이전 욕창이 치료되어 현재 피부가 완전히 닫히고 완전 상피화되어 있으며 개방성 피부손실이 보이지 않는다면 Stage 2나 Stage 1로 낮추지 마세요. 이 경우 suggestedStage는 "HEALED"로 하세요. HEALED는 욕창의 Stage가 아니라 "치유된 욕창" 상태입니다. follow-up에서 이전 단계가 제공되면 previousStage를 근거로 "과거 Stage 3 — 현재 치유됨"처럼 설명하세요. 과거 Stage 3/4는 치유 과정에서 Stage 2/1로 역단계화하지 마세요. rationale에는 "현재 사진상 개방성 피부손실이 없고 완전 상피화된 피부가 관찰되어 현재 상태는 치유됨으로 보입니다"를 포함하고, 사진만으로 완전 치유를 확정하기 어려우면 cautions에 임상 확인 필요를 적으세요. 완전 폐쇄·상피화된 경우에는 blanchingCheckNeeded=false로 하세요.
Blanching(압박 시 창백해짐) 자체는 Stage 2의 근거가 아닙니다. Stage 1은 온전한 피부의 비창백성 홍반일 때만 고려하세요. 이미 완전 상피화되어 닫힌 욕창에는 blanchable/비창백성 여부를 이용해 Stage 1로 바꾸지 마세요.


1) Photo Quality Check를 먼저 수행하세요. photoQuality.status는 "PASS"(상처 전체와 edge가 보이고 초점·조명 적절, 심한 반사·노출 문제 없음), "CAUTION"(일부 반사, 부분적 과노출/저노출, 상처 일부 불명확 — 분석은 가능하나 신뢰도 제한), "FAIL"(상처 전체 확인 불가, 심한 blur, 심한 과노출/저노출, edge가 거의 안 보임, 드레싱·물질로 가려짐) 중 하나. FAIL이거나 상처 사진이 아니면 canAssess=false로 하고 stage를 제안하지 마세요(이유는 photoQuality.issues에). CAUTION이면 분석을 진행하되 품질 제한을 cautions에 명시하세요.
2) DTPI는 피부가 온전하거나 표피가 분리된 경우 모두 가능합니다. 피부가 intact인지 불명확하다는 이유만으로 DTPI를 배제하지 마세요. 지속성 비창백성 짙은 적색·maroon·자주색 변색, 어두운 바닥을 드러낸 표피 분리 또는 혈성 수포를 고려하고 임상 확인 필요를 명시하세요. 짙은 색만으로 eschar·괴사라고 단정하지 마세요.
피부 표면·전층 손실·가피인지 변색인지 구분되지 않으면 Unstageable로 대체하지 말고 미정으로 보류합니다.
피부가 온전하고 국소 발적·변색만 있는 경우:
   - 짙은 적색·자주색·흑갈색(maroon) 변색이 지속되거나 혈성 수포가 보이면 → suggestedStage="DTPI", cautions에 "DTPI 고려 — 사진만으로 확정할 수 없음" 포함.
   - 그 외의 홍반이면 → blanching 여부는 사진으로 판단할 수 없으므로 suggestedStage="미정", blanchingCheckNeeded=true, rationale에 "1단계 욕창과 반응성 충혈(blanchable erythema)의 감별을 위해 blanching 확인이 필요합니다"를 포함하세요. "1"을 직접 제안하지 마세요.
3) 부분층 손상(표피 소실·진피 노출), 기저부가 pink/red, 얕은 상처이며 slough·eschar·지방 노출·granulation·심부조직이 전혀 보이지 않으면 → suggestedStage="2". slough/eschar/지방/심부조직이 하나라도 보이면 절대 "2"로 제안하지 마세요. 습기 손상·IAD·외상성 상처 가능성이 있으면 "2"로 단정하지 말고 해당 감별을 cautions에 명시하세요.
4) Unstageable은 전층 피부·조직 손실이 있고 실제 slough/eschar가 손상 범위를 가리는 근거가 있을 때 고려합니다. 초점 불량·화면 재촬영·깊이 미확인만으로 Unstageable을 제안하지 않습니다.
stageEvidence에 tissueLoss="fullThickness"|"superficial"|"none"|"unknown", covering="slough"|"eschar"|"discoloration"|"none"|"unknown", surface="intact"|"open"|"unknown"을 반드시 쓰고 불명확한 항목은 unknown으로 하세요.
전층(full-thickness) 손상 근거가 확인되면 다음 우선순위를 따르세요:
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
10) differentials는 배제 단정이 아니라 인접 분류와의 감별 및 추가 확인 항목입니다. 불명확한 경우 "아님"이라고 쓰지 마세요. 인접 분류의 판단을 보류한 이유를 최대 2개까지 {"stage","reason"} 형태로 쓰세요. reason은 25자 이내 한 구절로(예: "근육·뼈 노출 미확인, 배제 불가").
11) rationale는 2~3문장으로 간결하게, 다음을 포함하세요: ①관찰된 주요 특징 ②해당 stage를 고려한 이유 ③인접 stage와의 감별 근거 ④필요한 임상 확인. 예: "전층 피부 및 조직 손상이 의심되며 피하지방 노출 소견이 관찰됩니다. 사진상 근육, 건, 연골 또는 뼈의 노출은 확인되지 않아 Stage 3가 제안됩니다. 다만 사진만으로 deeper tissue involvement를 완전히 배제할 수 없어 임상적 확인이 필요합니다."
12) 경과 비교 사진이 제공된 경우 healing을 평가하세요. 이전→현재 순서로 비교하고, Stage가 낮아졌다는 이유만으로 호전이라고 판단하지 마세요. 사진만으로 상처 면적을 정량 계산하지 말고 눈에 보이는 변화만 사용하세요. 촬영 거리·각도·원형 크롭·조명이 다르면 면적 감소를 근거로 쓰지 마세요. 같은 조건에서 경계 수축이 명확할 때만 질적 표현으로 제시하세요. 호전 근거는 상피화 진행, 건강한 granulation 증가, slough/eschar 감소, 상처 경계 수축 등을 우선합니다. 악화 의심 근거는 병변 확대, 새로운 괴사·검은색 변화, slough/eschar 증가, 새로운 수포·심부조직 노출 의심 등입니다. 촬영 거리·각도·조명 차이가 크면 healing="판단 불가"로 하세요.
13) healing.status는 "호전"|"변화 없음"|"악화 의심"|"판단 불가" 중 하나만 사용하세요. healing.evidence는 실제 비교 근거를 최대 3개까지 짧게 쓰세요. 경과 비교 사진이 없으면 healing=null로 하세요.
12) rationale, cautions, issues, keyFindings, differentials는 한국어로. 마크다운·설명문 없이, 줄바꿈이나 들여쓰기가 전혀 없는 압축된 JSON 객체 한 줄만 출력하세요. 응답이 길어져 잘리지 않도록 모든 항목을 간결하게 유지하세요.

스키마:
{"stageEvidence":{"tissueLoss":"fullThickness"|"superficial"|"none"|"unknown","covering":"slough"|"eschar"|"discoloration"|"none"|"unknown","surface":"intact"|"open"|"unknown"},"canAssess":boolean,"photoQuality":{"status":"PASS"|"CAUTION"|"FAIL","adequate":boolean,"issues":string[]},"suggestedStage":"1"|"2"|"3"|"4"|"Unstageable"|"DTPI"|"HEALED"|"미정","blanchingCheckNeeded":boolean,"iadCheckNeeded":boolean,"uncertainty":"낮음"|"중간"|"높음","rationale":string,"cautions":string[],"woundBed":{"present":("granulation"|"slough"|"eschar"|"necrotic"|"dermis"|"other")[],"predominant":"granulation"|"slough"|"eschar"|"necrotic"|"dermis"|"other"|null}|null,"exudate":{"amount":"None"|"Scant"|"Small"|"Moderate"|"Large"|null,"type":"Serous"|"Serosanguineous"|"Sanguineous"|"Purulent"|null},"periwound":string[],"edge":"present"|"absent"|null,"keyFindings":string[],"differentials":[{"stage":"1"|"2"|"3"|"4"|"Unstageable"|"DTPI","reason":string}],"healing":{"status":"호전"|"변화 없음"|"악화 의심"|"판단 불가","evidence":string[]} | null}`;
}

async function analyzeWoundImage(dataUrl, ctx, options = {}) {
  const urls = Array.isArray(dataUrl) ? dataUrl : [dataUrl];
  const text = await callClaude(urls, buildAnalysisPrompt(ctx), options);
  return normalizeStageEvidence(parseAiJson(text));
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
5) 자/마커가 보이면 실제 눈금으로 확인 가능한 두 점(p1,p2)과 그 사이의 실제 길이 cm를 scale에 기록하세요. 눈금 숫자 또는 1 cm 간격이 명확하지 않으면 scale은 null로 하세요.
6) 각 병변에 대해 실제 개방성 손상 조직의 최소 bounding box를 bbox:{xMin,yMin,xMax,yMax}로 함께 기록하세요. 주변 발적·정상 피부·자·스티커는 bbox에 포함하지 마세요. length와 width의 네 끝점은 반드시 이 bbox 안에 있어야 합니다.
JSON만 출력: {"found":boolean,"scaleVisible":boolean,"scale":{"p1":{"x":number,"y":number},"p2":{"x":number,"y":number},"cm":number}|null,"wounds":[{"index":number,"bbox":{"xMin":number,"yMin":number,"xMax":number,"yMax":number},"length":[{"x":number,"y":number},{"x":number,"y":number}],"width":[{"x":number,"y":number},{"x":number,"y":number}]}],"note":string}`;
  }
  return `사진 속 욕창(pressure injury)의 크기 측정을 위한 축 좌표를 추정하세요.${ctx.multiTarget ? " 이 사진에는 병변이 여러 개 있으며, 흰 테두리의 청록색 원으로 표시된 병변만 대상입니다." : ""}

규칙:
1) 좌표는 이미지 좌상단(0,0)~우하단(1,1) 기준 비율(소수)로 표기하세요.
2) length: 상처 경계 기준 최대 직경 축의 양 끝점 2개 (상처의 실제 최장축).
3) width: length 축과 수직 방향의 최대 폭 양 끝점 2개.
4) 자·마커·스티커·표시용 원·정상 피부는 상처가 아닙니다. 조직 손상의 경계를 기준으로 하세요(주변 발적 제외). 사진에 자(ruler)·마커 등 크기 기준(scale)이 보이는지 scaleVisible로 함께 보고하세요.
특히 자가 상처 바로 옆에 있어도 자의 길이와 눈금은 절대로 측정 대상에 포함하지 마세요.
측정선의 양 끝점은 반드시 실제 손상된 조직의 경계에 닿아 있어야 합니다.
상처 밖 정상 피부를 통과하는 측정선은 잘못된 결과이므로 만들지 마세요.
5) 상처 경계가 불명확하거나 대상 병변을 특정할 수 없으면 found=false로 하고 note에 이유를 쓰세요. 억지로 추정하지 마세요.
6) 자/마커가 보이면 실제 눈금으로 확인 가능한 두 점(p1,p2)과 그 사이의 실제 길이 cm를 scale에 기록하세요. 눈금 숫자 또는 1 cm 간격이 명확하지 않으면 scale은 null로 하세요. JSON만 출력: {"found":boolean,"scaleVisible":boolean,"scale":{"p1":{"x":number,"y":number},"p2":{"x":number,"y":number},"cm":number}|null,"length":[{"x":number,"y":number},{"x":number,"y":number}]|null,"width":[{"x":number,"y":number},{"x":number,"y":number}]|null,"note":string}`;
}

async function aiMeasureAxes(dataUrls, ctx) {
  const images = Array.isArray(dataUrls) ? dataUrls : [dataUrls];

  const prompt =
    buildMeasurePrompt(ctx) +
    `

추가 규칙:
- 사진이 2장 제공되면 첫 번째 사진이 좌표 기준이 되는 원본 사진입니다.
- 두 번째 사진은 첫 번째 사진의 대상 병변을 확대해서 경계를 확인하기 위한 참고 사진입니다.
- 반드시 첫 번째 원본 사진의 좌표계(좌상단 0,0 ~ 우하단 1,1)를 기준으로 좌표를 반환하세요.
- 두 번째 확대사진의 좌표를 그대로 반환하지 마세요.
- 자, 측정용 카드, 정상 피부, 주변 발적은 상처 경계에 포함하지 마세요.
- 상처의 실제 조직 손실/개방된 영역의 경계를 우선해서 length와 width를 결정하세요.
- 상처 경계가 명확하지 않으면 억지로 긴 축을 만들지 말고 found=false로 반환하세요.`;

  const text = await callClaude(images, prompt);
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
  if (s === "HEALED" || s === "치유됨") return "HEALED";
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
function SavedFindingRows({rows}) {
 const visible=rows.filter(([,value])=>value!=null&&value!==''&&value!=='—'&&value!=='미입력');
 return visible.length?<dl className="pl-saved-finding-rows">{visible.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>:<p className="pl-saved-empty">기록된 항목이 없습니다.</p>;
}
function SavedWoundFindings({record:rec}) {
 const f=rec.final||{},size=rec.size||{};
 const rows=[['상처 바닥',woundBedText(f.woundBed)],['삼출물',exudateText(f)],['주변 피부',(f.periwound||[]).map(v=>TERM_LABELS[v]||v).join(' · ')],
 ['압박 시 색 변화',f.blanching?(f.blanching==='blanch'?'하얗게 변함':f.blanching==='nonblanch'?'변하지 않음':'판단 불가'):null],
 ['IAD 감별',iadVerdictShortFrom(f.iadCheck)],['상처 가장자리',f.edge?(f.edge==='present'?'상피화 있음':f.edge==='absent'?'상피화 없음':'판단 불가'):null],
 ['분류 변경 사유',f.overrideReason?(OVERRIDE_REASONS.find(r=>r[0]===f.overrideReason.code)||[])[1]:null],['잠식',size.undermining],['터널',size.tunneling],['Braden',rec.braden?rec.braden.total+'점 · '+(rec.braden.total<=18?'고위험':'저위험'):null]];
 return <Card className="pl-saved-findings"><SectionTitle>상처 상태</SectionTitle><SavedFindingRows rows={rows}/>{infectionFlag(f)&&<div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">감염 의심 소견이 기록된 사정입니다.</div>}</Card>;
}
function ClinicalChecksSummary({final}) {
 const labels={depthObscured:'부육·가피로 깊이 확인 불가',intact:'피부 온전성',blanching:'압박 시 색 변화',pain:'통증',temp:'피부 온도',firm:'피부 촉감',color:'짙은 색 변화',blister:'혈성 수포',partial:'부분층 손상',sloughEschar:'부육·가피',fat:'지방조직 노출',deep:'심부 조직 노출',depthDone:'깊이 측정'};
 const values={yes:'있음',no:'없음',present:'있음',absent:'없음',na:'판단 불가',warmer:'따뜻함',cooler:'차가움',none:'변화 없음',firm:'단단함',boggy:'물렁함',blanch:'하얗게 변함',nonblanch:'변하지 않음'};
 const rows=Object.entries(final?.clinChecks||{}).filter(([k,v])=>labels[k]&&v).map(([k,v])=>({k,v,label:labels[k],value:k==='intact'?(v==='yes'?'온전함':v==='no'?'손상 있음':'판단 불가'):k==='depthDone'?(v==='yes'?'측정함':v==='no'?'측정하지 않음':'판단 불가'):values[v]||v}));
 if(!rows.length)return null;
 return <Card className="pl-saved-findings"><SectionTitle>단계 판정 관련 소견</SectionTitle><SavedFindingRows rows={rows.map(r=>[r.label,r.value])}/><p className="pl-saved-state-note">판단 불가·미측정은 사정 당시 기록된 상태입니다.</p></Card>;
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
    depthObscured: {yes:"기저부가림+",no:"기저부가림-",na:"기저부가림?"},
    depthDone: { yes: "깊이측정+", no: "깊이측정-", na: "깊이?" },
  };
  return Object.entries(cc).filter(([, v]) => v).map(([k, v]) => (L[k] && L[k][v]) || `${k}:${v}`).join(" · ");
}

function iadVerdictShortFrom(check) {
  const v = iadVerdictFrom(check);
  return v == null ? null : v.startsWith("IAD") ? "IAD 우세" : v.startsWith("욕창") ? "욕창 우세" : "감별 불명확";
}

function buildRecommendations(final = {}, location, opts = {}) {
  const stage=final.stage||'ND', cc=final.clinChecks||{}, peri=final.periwound||[];
  const heel=/heel|발꿈치|발뒤꿈치/i.test(location||'');
  const bed=Array.isArray(final.woundBed?.types)?final.woundBed.types:Object.entries(final.woundBed||{}).filter(([key,value])=>['slough','eschar','necrotic'].includes(key)&&Number(value)>0).map(([key])=>key);
  const open=['2','3','4','U'].includes(stage), wet=['Moderate','Large'].includes(final.exudateAmount);
  const necrosis=cc.sloughEschar==='yes'||bed.some(t=>['slough','eschar','necrotic'].includes(t));
  const alerts=!!(final.infection?.fever||final.infection?.purulent||final.exudateType==='Purulent');
  const skinRisk=stage==='IAD'||peri.some(t=>['Maceration','Excoriation'].includes(t))||final.iadCheck?.moisture===true;
  const core={
    '1':['피부 온전성 유지: 붉은 부위를 마사지하거나 문지르지 않습니다.','홍반·통증·온도·촉감 변화를 재사정하고 압력 제거 후 경과를 기록합니다.'],
    '2':['노출된 상처면을 부드럽게 세정하고 보호하며, 삼출물에 맞는 드레싱으로 적절한 습윤 환경을 유지합니다.','지방·심부 조직 노출 또는 부육·가피가 보이면 Stage 2와 맞지 않는 소견인지 재사정합니다.'],
    '3':['깊이·잠식·터널·사강을 직접 사정하고 기록합니다. 사진만으로 깊은 공간을 판단하지 않습니다.','괴사조직 제거와 사강 관리 필요성은 혈류·감염·통증·치료 목표를 고려해 WOCN·담당의와 결정합니다.'],
    '4':['노출된 근막·근육·건·뼈 등 심부 구조를 보호하고 건조와 추가 손상을 피하도록 전문 치료 계획을 확인합니다.','골수염 등 심부 감염 가능성과 외과적 치료 필요성을 WOCN·담당의에게 평가받습니다.'],
    U:['깊이를 가리는 조직과 혈류 상태를 평가하고, 괴사조직 제거 여부·방법은 전문가와 결정합니다.','발뒤꿈치 또는 허혈성 사지의 건조하고 단단히 부착된 안정 가피(주변 홍반·물렁거림 없음)는 임의로 불리거나 제거하지 않습니다.'],
    DTPI:['보라·적갈색 변색, 통증, 온도·촉감, 혈성 수포와 피부 손상 변화를 면밀히 관찰합니다.','표면보다 깊은 손상이 있을 수 있습니다. 피부가 열리거나 병변이 확대되면 조기에 전문가 재평가를 요청합니다.'],
    IAD:['실금과 피부 자극의 원인을 관리하고, 오염 후 부드럽게 세정·건조합니다.','압력손상 동반 여부를 별도로 평가하고 피부보호제를 제품 설명서에 따라 적용합니다.'],
    NONE:['압력 원인을 제거한 뒤 발적이 가라앉는지 재확인하고 예방 관리를 지속합니다.'],
    HEALED:['이전 욕창 부위의 재손상을 예방합니다. 치유된 욕창을 낮은 Stage로 바꾸어 기록하지 않습니다.'],
    ND:['피부 온전성·깊이·조직 노출·IAD 여부를 직접 재사정하고, 분류가 불명확하면 WOCN·담당의에게 확인합니다.']
  };
  const priority=['병변에 압력이 계속 가해지지 않도록 체위와 지지면을 조정하고, 마찰·전단력을 줄입니다.','체위 변경 간격은 피부 반응·활동성·지지면·전신 상태에 맞춰 개별화합니다.'];
  if(heel)priority.push('종아리 등을 적절히 지지해 발뒤꿈치가 지지면에서 완전히 떨어지는지 확인합니다.');
  const specific=[...(core[stage]||core.ND)];
  if(open){
    if(wet)specific.push('중등도~다량 삼출물: 흡수 용량과 교환 간격을 조절하고 누출·포화·침연을 확인합니다.');
    else if(final.exudateAmount==='None')specific.push('삼출물 없음만으로 건조 상태라고 판단하지 말고 상처 바닥을 직접 확인해 수분 균형을 관리합니다.');
    if(necrosis&&stage!=='U')specific.push('부육·가피가 기록되어 있습니다. 관류와 감염을 확인하고 제거 필요성을 전문가에게 평가받습니다.');
    if(opts.size?.tunneling||opts.size?.undermining)specific.push('기록된 잠식·터널을 포함해 사강의 범위와 변화, 드레싱 제거 가능 여부를 확인합니다. 임의로 깊게 탐침하거나 과도하게 채우지 않습니다.');
  }
  const protection=[];
  if(skinRisk)protection.push('기록된 습기 노출 또는 주변 피부 손상에 맞춰 세정·오염 관리와 피부보호제 필요성을 확인합니다.');
  else protection.push('실금·땀·삼출물에 반복 노출되거나 침연 위험이 있는 경우에 피부보호제 사용을 고려합니다. 단계만으로 일률 적용하지 않습니다.');
  protection.push('주변 피부 보호용 제품은 해당 제품 설명서에 따라 적용합니다. 패인 상처 안이나 터널에 임의로 채우지 않으며, 상처 내부용 창상피복재와 구분합니다.');
  protection.push('접착 드레싱과 함께 사용할 때는 건조·남은 크림 제거 등 제품별 지침을 확인합니다. 건조한 피부의 보습과 습기 차단은 목적을 구분합니다.');
  const escalation=[];
  if(alerts)escalation.push('발열 또는 화농성 삼출물이 기록되어 있습니다. 감염 여부와 전신 상태를 신속히 평가하고 담당의에게 보고합니다.');
  if(['3','4','U','DTPI','ND'].includes(stage))escalation.push('깊은 손상·괴사조직·분류 불확실성에 대한 WOCN·담당의 평가 계획을 확인합니다.');
  escalation.push('발적 확산, 새 열감·종창, 통증 증가, 화농성 배액, 발열, 병변의 빠른 확대·심부 조직 노출 시 담당의에게 보고합니다.');
  escalation.push('전신 상태가 급격히 악화하거나 패혈증이 의심되면 기관의 응급 보고·대응 절차를 우선합니다.');
  escalation.push('단계나 냄새·통증 하나만으로 감염을 확진하거나 항생제·항균 드레싱을 자동 선택하지 않습니다.');
  return [{t:'우선 시행 · 압력 관리',items:priority},{t:stageLabel(stage)+' · 이 상처에 맞는 관리',items:specific},{t:'주변 피부 보호 · 상처 내부와 구분',items:protection},{t:'보고·협진이 필요한 변화',items:escalation},{t:'공통 관리 · 통증·영양·경과',items:['세정·교환·체위 변경 시 통증과 불편감을 평가하고 필요한 완화 방법을 협의합니다.','영양·수분 상태와 혈류·전신 상태를 확인하고, 필요 시 영양팀·담당의와 협의합니다.','F/U 시 크기·깊이·상처 바닥·삼출물·주변 피부 변화를 기록합니다. 면적 감소만으로 치유를 확정하지 않습니다.']}];
}

function SkinProtectionEducation(){return <details className="pl-skin-protection"><summary>피부보호·보습 제품 · 목적에 맞게 구분하기</summary><p>특정 제품을 추천하는 목록이 아닙니다. 단계 번호보다 습기·대소변·삼출물 노출과 피부 상태에 따라 종류를 선택합니다. 제품마다 성분·적용 부위·손상 피부 사용 가능 여부가 다릅니다.</p><h4>피부보호크림·연고</h4><p>습기와 자극 물질에 노출되는 주변 피부 보호를 위해 검토합니다. 도포량·재도포·접착 드레싱과의 병용은 제품 설명서를 확인하세요.</p><h4>피부보호필름</h4><p>액상 제품이 마르며 피부에 보호막을 형성하는 종류입니다. 주변 피부의 체액·접착제 노출 등 사용 목적과 적용 가능한 피부 상태를 제품별로 확인합니다.</p><h4>보습제</h4><p>건조한 피부의 보습을 위해 사용합니다. 습기·대소변 차단용 보호제와 같은 목적으로 일률적으로 선택하지 않습니다. 보습 기능과 보호 기능을 함께 가진 제품도 있어 표시된 용도를 확인합니다.</p><p>주변 피부용 보호제와 상처 내부에 적용하는 크림형 창상피복재는 구분합니다. 보호제를 깊은 상처나 터널에 임의로 채우지 마세요. 압력 관리와 상처 내부 드레싱은 별도로 시행합니다.</p><div className="pl-care-source-links"><a href="https://www.internationalguideline.com/skincare" target="_blank" rel="noreferrer">국제 가이드라인 · 피부 관리 원칙 ↗</a><a href="https://www.nice.org.uk/guidance/cg179/chapter/Recommendations" target="_blank" rel="noreferrer">NICE · 피부보호제와 욕창 관리 ↗</a></div></details>;}

function careItemIsFlagged(final={},item){
 if(item.startsWith('발열 또는 화농성 삼출물이 기록'))return !!(final.infection?.fever||final.infection?.purulent||final.exudateType==='Purulent');
 if(item.startsWith('기록된 습기 노출 또는 주변 피부 손상'))return (final.periwound||[]).some(value=>['Maceration','Excoriation'].includes(value));
 return false;
}

function NursingCarePlan({final,location,size={}}){
 const groups=buildRecommendations(final,location,{size});
 return <Card className="pl-care-plan"><div className="pl-care-plan-heading"><span>최종 사정에 맞춘 관리</span><h3>간호 중재</h3><p>{stageLabel(final?.stage||'ND')} · 기록한 삼출물·주변 피부·임상 소견 기준</p></div>{groups.map((group,i)=><section key={group.t} className="pl-care-block"><h4><span>{i+1}</span>{group.t}</h4><ul>{group.items.map((item,j)=><li key={j} className={careItemIsFlagged(final,item)?"pl-care-item-attention":undefined}>{careItemIsFlagged(final,item)&&<strong className="pl-care-recorded-label">기록된 주의 소견</strong>}{item}</li>)}</ul></section>)}<SkinProtectionEducation/><details className="pl-care-source-links"><summary>근거와 선택 원칙</summary><p>단계만으로 제품·항생제·괴사조직 제거를 확정하지 않습니다. 환자 상태·기관 지침·전문가 치료 계획을 함께 확인하세요.</p><a href="https://www.nice.org.uk/guidance/cg179/chapter/Recommendations" target="_blank" rel="noreferrer">NICE · 욕창 관리 ↗</a><a href="https://www.internationalguideline.com/repositioning" target="_blank" rel="noreferrer">국제 가이드라인 · 압력 관리 ↗</a><a href="https://npiap.com/page/PressureInjuryStages" target="_blank" rel="noreferrer">NPIAP · 단계·안정 가피 기준 ↗</a></details></Card>;
}

function clinicalGuideSignature(final){return JSON.stringify({blanching:final.blanching||null,checks:Object.entries(final.clinChecks||{}).filter(([key])=>['intact','blanching','partial','sloughEschar','depthObscured','fat','deep','color','blister'].includes(key)).sort(([a],[b])=>a.localeCompare(b))});}
function applyClinicalGuide(final,stage){const next={...final,stage,blanching:['blanch','nonblanch'].includes(final.clinChecks?.blanching)?final.clinChecks.blanching:final.blanching};return {...next,clinicalApplied:{stage,signature:clinicalGuideSignature(next)}};}
function updateClinicalGuide(final,key,value){const next={...final,clinChecks:{...(final.clinChecks||{}),[key]:value}};if(key==='intact'){if(value!=='no')for(const k of ['partial','sloughEschar','depthObscured','fat','deep'])delete next.clinChecks[k];if(value!=='yes'){delete next.clinChecks.blanching;next.blanching=null;}}if(key==='blanching')next.blanching=['blanch','nonblanch'].includes(value)?value:null;return next;}
function clinicalGuideApplied(final,result){return !!result&&final.stage===result&&final.clinicalApplied?.stage===result&&final.clinicalApplied.signature===clinicalGuideSignature(final);}


const dressingCards = [
    {key:"foam",title:"폼 드레싱 (Foam)",subtitle:"삼출물 흡수 · 완충 · 보호",icon:"▣",desc:"흡수성 폼으로 삼출물을 관리하고 외부 마찰로부터 상처를 보호합니다. 실리콘 접촉층·테두리·흡수력은 제품마다 다릅니다.",use:"삼출물이 있는 상처에서 흡수 용량과 피부 취약성, 부착 부위를 고려합니다.",caution:"건조한 상처에 흡수력이 높은 제품을 일률적으로 적용하지 않습니다. 접착제 손상과 가장자리 누출을 확인합니다."},
    {key:"hydrocolloid",title:"하이드로콜로이드",subtitle:"습윤 환경 · 겔 형성",icon:"◉",desc:"삼출물과 반응하여 겔을 형성하는 밀폐·반밀폐성 드레싱입니다.",use:"감염 소견이 없고 삼출물이 적거나 중간 정도인 얕은 상처에서 제품 적응증을 확인합니다.",caution:"임상적 감염이 의심되거나 삼출물이 많은 상처에 일률적으로 적용하지 않습니다. 제거 시 취약한 주변 피부 손상에 주의합니다."},
    {key:"hydrogel",title:"하이드로겔",subtitle:"건조한 상처에 수분 공급",icon:"≈",desc:"건조한 상처 표면에 수분을 제공하고 일부 상황에서 자가분해적 변연절제를 돕습니다.",use:"건조한 wound bed의 수분 균형을 평가하고 필요 시 적절한 2차 드레싱과 함께 사용합니다.",caution:"삼출물이 많거나 주변 피부가 침연된 경우 추가 수분 공급이 부적절할 수 있습니다. 허혈성 건조 가피는 임의로 연화하지 않습니다."},
    {key:"hydrofiber",title:"하이드로화이버",subtitle:"삼출물 흡수 · 겔 형성",icon:"≋",desc:"상처 삼출물과 접촉하면 겔을 형성하는 흡수성 섬유 드레싱입니다.",use:"중등도~다량 삼출물과 주변 피부 침연 위험을 함께 고려하며 제품에 따라 2차 드레싱을 사용합니다.",caution:"건조한 상처에 무조건 사용하지 않습니다. 공동이나 터널에 적용할 때 과도하게 채우지 않고 제거 가능하도록 제품 지침을 따릅니다."},
    {key:"alginate",title:"알지네이트 (Alginate)",subtitle:"삼출물 흡수 · 겔 형성",icon:"≋",desc:"해조류 유래 흡수성 섬유로 삼출물과 접촉하여 겔을 형성합니다. 제품에 따라 칼슘 성분이 포함됩니다.",use:"삼출물이 중등도 이상인 상처에서 형태·깊이와 2차 드레싱 필요 여부를 확인합니다.",caution:"건조한 상처에는 부적합할 수 있습니다. 깊은 공동에 사용할 때 과충전 및 잔류 여부를 확인합니다. 지혈 효과를 모든 제품에 일반화하지 않습니다."},
    {key:"film",title:"투명 필름 (Film)",subtitle:"표면 보호 · 관찰 용이",icon:"▤",desc:"얇고 투명한 접착성 막으로 외부 오염과 마찰을 줄이며 상처 상태를 관찰할 수 있습니다. 흡수력은 거의 없습니다.",use:"삼출물이 거의 없는 표재성 병변이나 적절한 2차 고정 용도로 제품 적응증을 확인합니다.",caution:"삼출물이 많은 개방성 상처에는 단독 사용이 적절하지 않을 수 있습니다. 제거 시 피부 벗겨짐에 주의합니다."},
    {key:"contact",title:"비점착성 접촉층",subtitle:"취약한 조직 보호",icon:"▥",desc:"상처에 직접 닿는 비점착성 층으로 교환 시 조직 손상을 줄이는 데 도움을 줍니다. 제품에 따라 실리콘 또는 망 형태입니다.",use:"통증이 있거나 취약한 육아조직·새로 형성된 상피를 보호할 때 흡수성 2차 드레싱과 조합을 고려합니다.",caution:"접촉층 자체의 흡수력은 제한적일 수 있습니다. 2차 드레싱의 흡수력과 교환 주기를 함께 확인합니다."},
    {key:"antimicrobial",title:"항균성 드레싱",subtitle:"감염 위험 평가 후 제한적 고려",icon:"✚",desc:"은·요오드·PHMB 등 항균 성분이 포함된 제품군입니다. 성분별 적응증과 제한사항이 다릅니다.",use:"국소 감염이나 높은 미생물 부담이 의심되는 상황에서 임상 평가와 기관 지침에 따라 필요성과 재평가 시점을 정합니다.",caution:"모든 욕창에 예방적으로 사용하거나 무기한 지속하지 않습니다. 전신 감염의 평가·치료를 대신하지 않으며 알레르기·제품별 금기를 확인합니다."}
  ];
const dressingProducts = {
    foam: ["Mepilex Border Flex / Border Sacrum / Border Heel (메필렉스 보더: 부위별 테두리형)", "ALLEVYN Gentle Border / Life / Gentle Border Lite (알레빈: 세부 흡수력·형태 확인)", "Biatain Silicone / Silicone Lite / Non-Adhesive (바이아테인: 실리콘·비접착형 구분)"],
    hydrocolloid: ["DuoDERM (듀오덤)", "Comfeel Plus (컴필 플러스)"],
    hydrogel: ["INTRASITE Gel (인트라사이트 젤)", "SOLOSITE Gel (솔로사이트 젤)"],
    hydrofiber: ["AQUACEL Extra (아쿠아셀 엑스트라)", "AQUACEL Ag+ Extra (은 함유형 — 일반형과 구분)"],
    alginate: ["KALTOSTAT (칼토스타트)", "Melgisorb (멜지소브)"],
    film: ["Tegaderm Transparent Film (테가덤 투명 필름)", "OPSITE Flexifix (옵사이트 필름)"],
    contact: ["Mepitel One (메피텔 원)", "ADAPTIC TOUCH (아답틱 터치)"],
    antimicrobial: ["Mepilex Border Ag (은 함유 폼)", "AQUACEL Ag+ Extra (은 함유 하이드로화이버)", "IODOFLEX (요오드 함유 — 성분별 금기 확인)"]
  };

// 최종 임상 사정값 기반 교육용 드레싱 검토 항목 (AI 사진 판정/처방 아님)
function dressingConsiderations(fin, depthCm, location) {
  const stage = fin?.stage;
  const amount = fin?.exudateAmount;
  const bed = Array.isArray(fin?.woundBed?.types) ? fin.woundBed.types : WB_KEYS.filter(w => Number(fin?.woundBed?.[w.k]) > 0).map(w => w.k);
  const peri = fin?.periwound || [];
  const infection = infectionFlag(fin || {} ) || fin?.exudateType === "Purulent";
  const wet = ["Moderate", "Large"].includes(amount);
  const dry = ["None", "Scant"].includes(amount);
  const items = [];
  const notes = [];
  const add = (title, why, caution) => { if (!items.some(x => x.title === title)) items.push({ title, why, caution }); };
  if (["ND", "U", "DTPI"].includes(stage)) notes.push("단계·심부손상 또는 가피 상태에 대한 전문가 평가를 우선하세요.");
  if (["HEALED", "NONE", "IAD"].includes(stage)) return { items: [], notes: ["현재 분류에서는 개방성 욕창의 치료용 드레싱을 자동 제안하지 않습니다. 피부 보호·원인 관리와 재사정을 확인하세요."] };
  if (stage === "1") return { items: [], notes: ["피부가 온전한 Stage 1: 압력 제거·피부 보호가 우선이며, 예방적 폼 적용은 피부 상태와 기관 지침에 따라 별도로 검토하세요."] };
  if (stage === "2") {
    const incompatible = bed.some(t => ["slough", "eschar", "necrotic", "granulation"].includes(t)) ||
      ["sloughEschar", "fat", "deep"].some(k => fin?.clinChecks?.[k] === "yes");
    if (incompatible) {
      notes.push("Stage 2 재확인 필요: Slough/Eschar·괴사조직·육아조직 또는 지방/심부 조직 노출은 Stage 2 기준과 맞지 않습니다. 기저부와 깊이를 직접 재사정하고 WOCN·담당의에게 확인하세요. 깊이가 가려진 경우 Unstageable 여부를 평가하며 자동으로 Stage를 변경하지 않습니다.");
    }
    if (infection) notes.push("감염 의심 소견: 담당의/WOCN 평가가 우선이며 드레싱 선택은 평가 후 결정하세요.");
    if (bed.includes("eschar") || bed.includes("necrotic")) notes.push("특히 발꿈치/허혈성 사지의 안정된 건조 가피는 임의로 연화·제거하지 마세요. 관류와 감염 징후를 평가하세요.");
    if (peri.includes("Maceration")) notes.push("주변 피부 침연: 추가 수분 공급을 피하고 흡수 용량·교환 간격·피부 보호를 확인하세요.");
    if (peri.includes("Excoriation")) notes.push("주변 피부 손상: 접착제에 의한 추가 손상을 줄이는 제품을 검토하세요.");
    if ((location || "").toLowerCase().includes("heel")) notes.push("발꿈치 관류·압력 완전 부양 여부를 별도로 확인하세요.");
    if (!EXU_AMT.includes(amount)) notes.push("삼출액 양 미입력: None(없음)과 다릅니다. 실제 삼출액 양과 상처 바닥의 습윤·건조 상태를 확인하세요.");
    else if (amount === "None") notes.push("삼출액 None(없음): 미입력이 아니며 상처 바닥이 건조하다는 뜻도 아닙니다. 실제 수분 상태를 확인하세요.");
    if (incompatible) return { items, notes };
    if (dry && !infection) add("저흡수성 실리콘 폼 (조건부)", "삼출액 없음·소량에서도 제품별 적응증에 따라 취약한 상처 보호를 검토", "Mepilex Lite / Border Flex Lite 등 저흡수성 제품을 구분; None만으로 건조 여부 판단 금지, 일반 Border Flex와 동일하게 적용하지 않음");
    if (!EXU_AMT.includes(amount)) {
      add("폼 드레싱 (주요 검토 · 삼출액 확인 후)", "Stage 2의 상처 보호와 삼출액 관리에 적합한지 우선 검토", "삼출액·수분 상태 확인 전 선택 보류; 건조한 상처에 고흡수성 폼 일률 적용 금지");
    } else if (amount === "None") {
      add("비점착성 접촉층", "삼출액 없는 얕은 상처의 취약한 바닥 보호 검토", "필요 시 적절한 2차 드레싱 확인");
    } else {
      add("폼 드레싱 (주요 검토)", wet ? "중등도~다량 삼출액 흡수와 얕은 상처 보호를 우선 검토" : "소량 삼출액과 취약한 상처 보호에 맞는 낮은 흡수 용량·실리콘 폼을 우선 검토", "삼출액에 맞는 흡수 용량, 접착제 손상, 누출·침연을 확인; 건조한 상처에 일률 적용 금지");
      if (wet) add("하이드로화이버 / 알지네이트 (조건부)", "폼만으로 삼출액 관리가 충분하지 않을 때 추가 검토", "제품 적응증 및 2차 드레싱 확인; 얕은 Stage 2에 충전재를 일률 적용하지 않음");
      else if (!infection) add("하이드로콜로이드 (대안)", "감염 소견 없는 얕고 삼출액 적은 상처에서 검토", "접착제 손상·침연 및 제품 적응증 확인");
    }
    if (dry && !infection && !peri.includes("Maceration")) {
      add("하이드로겔 (건조·수분 공급 필요 확인 시만)", "None/Scant만으로 건조를 판단하지 않고, 직접 사정에서 건조한 바닥과 수분 공급 필요가 확인된 경우에만 검토", "기본 선택이 아님; 습윤한 바닥에는 불필요할 수 있으며 침연·삼출액 증가 시 재평가, 적절한 2차 드레싱 확인");
    }
    return { items, notes };
  }
  if (!amount) {
    notes.push("삼출액 양 미입력: 아래 후보는 확정 추천이 아닌 조건별 검토 예시입니다. 실제 삼출액을 확인한 뒤 선택하세요.");
    if (["2", "3", "4"].includes(stage)) {
      add("폼 드레싱 (삼출액 확인 후)", "삼출액이 있는 경우 흡수·보호 목적으로 검토", "건조한 상처에는 일률 적용하지 않으며 흡수 용량과 피부 상태를 확인");
      if (bed.includes("slough") || bed.includes("granulation")) add("하이드로화이버 / 알지네이트 (조건부)", "중등도~다량 삼출액이 확인되는 경우 검토", "삼출액 미확인 상태에서는 선택 보류; 건조한 상처에 사용 주의");
      if (bed.includes("slough") && !infection && !bed.includes("eschar")) add("하이드로겔 (건조할 때만)", "상처 바닥이 건조한 경우 수분 균형을 검토", "삼출액이 많거나 침연이 있으면 부적절할 수 있음; 허혈성 안정 가피 연화 금지");
    }
  }
  if (infection) notes.push("감염 의심 소견: 담당의/WOCN 평가가 우선입니다. 항균성 드레싱은 평가 후 제품 적응증과 재평가 시점을 정하세요.");
  if (bed.includes("eschar") || bed.includes("necrotic")) notes.push("괴사조직·가피의 관류 및 변연절제 필요성을 평가하세요. 특히 발꿈치/허혈성 사지의 안정된 건조 가피는 임의로 연화·제거하지 마세요.");
  if (wet) {
    add("폼 드레싱", "중등도 이상 삼출액 흡수 및 외부 보호를 검토", "제품별 흡수 용량·교환 시점·누출 여부 확인");
    add("하이드로화이버 / 알지네이트", "삼출액이 많은 상처에서 흡수성 충전재 검토", "건조한 상처에는 부적합할 수 있음. 필요 시 2차 드레싱, 공동 과충전 금지");
  } else if (dry && !infection && !(bed.includes("eschar") || bed.includes("necrotic"))) {
    if ((bed.includes("slough") || bed.includes("granulation")) && !peri.includes("Maceration")) add("하이드로겔 (건조·수분 공급 필요 확인 시만)", "직접 사정에서 건조한 상처 바닥과 수분 공급 필요가 확인된 경우 검토", "None만으로 건조 판단 금지; 침연·과도한 삼출 시 피하고, 적절한 2차 드레싱 확인");
    add("저흡수성 실리콘 폼 (조건부)", "삼출액 없음·소량에서도 제품별 적응증에 따라 취약한 상처 보호를 검토", "Mepilex Lite / Border Flex Lite 등 저흡수성 제품을 구분; None만으로 건조 여부 판단 금지, 일반 Border Flex와 동일하게 적용하지 않음");
    if (stage === "2" && amount !== "None") add("하이드로콜로이드", "감염 소견 없는 얕고 삼출액 적은 상처에서 검토", "감염 의심·다량 삼출에는 일률 적용 금지; 접착제 손상 주의");
    add("비점착성 접촉층", "취약한 상처 바닥 보호 및 교환 시 손상 감소 검토", "자체 흡수력이 제한적이므로 필요 시 2차 드레싱 확인");
  } else if (amount === "Small") {
    add("폼 드레싱 / 비점착성 접촉층", "소량 삼출액과 주변 피부 취약성에 맞춰 검토", "흡수력과 접착력은 제품마다 다름");
  }
  if (peri.includes("Maceration")) notes.push("주변 피부 침연: 흡수 용량·교환 간격·피부 보호제 필요성을 함께 확인하세요.");
  if (peri.includes("Excoriation")) notes.push("주변 피부 손상: 접착제에 의한 추가 손상을 피할 수 있는 제품을 검토하세요.");
  if (["3", "4", "U"].includes(stage) && !depthCm) notes.push("깊이·잠식·터널·사강은 사진만으로 평가할 수 없으므로 임상 확인 후 충전재를 선택하세요.");
  if ((location || "").toLowerCase().includes("heel")) notes.push("발꿈치 관류·압력 완전 부양 여부를 별도로 확인하세요.");
  return { items, notes };
}

function DressingConsiderationCard({ final, depthCm, location }) {
  const [selected, setSelected] = useState(null);
  usePhoneBack(!!selected,()=>setSelected(null),120);
  const closeRef = useRef(null);
  useEffect(() => {
    if (!selected) return;
    const before = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKey = (e) => {
      if (e.key === "Escape") setSelected(null);
      if (e.key === "Tab") {
        const dialog = closeRef.current?.closest("[role=dialog]");
        const focusable = [...(dialog?.querySelectorAll("button, a[href]") || [])];
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handleKey); before?.focus?.(); };
  }, [selected]);
  const keysFor = (title) => title.includes("하이드로화이버") ? ["hydrofiber", "alginate"] : title.includes("폼") ? ["foam"] : title.includes("하이드로콜로이드") ? ["hydrocolloid"] : title.includes("하이드로겔") ? ["hydrogel"] : ["contact"];
  const result = dressingConsiderations(final, depthCm, location);
  return (
    <Card>
      <SectionTitle>드레싱 선택 참고 · 최종 사정 기반</SectionTitle>
      <p className="text-xs text-slate-500 mb-3">간호사가 확인한 Stage, wound bed, 삼출액 및 주변 피부 입력값으로 표시하는 교육용 검토 항목입니다. AI 처방이나 제품 선택 확정이 아닙니다.</p>
      {result.items.length ? <div className="space-y-2">{result.items.map((d) => <button type="button" key={d.title} onClick={() => setSelected(d)} className="w-full text-left rounded-xl border border-sky-100 bg-sky-50 p-3"><div className="text-sm font-bold text-sky-900">{d.title}</div><p className="text-xs text-slate-700 mt-1">검토 이유: {d.why}</p><p className="text-xs text-amber-800 mt-1">주의: {d.caution}</p><div className="text-xs font-bold text-teal-700 mt-2">제품 예시 보기 ›</div></button>)}</div> : <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-bold text-amber-900">드레싱 선택 보류 · 추가 확인 필요</p><p className="text-xs text-slate-700 mt-1">{result.notes.some(n => n.includes("가피")) ? "가피·괴사조직 또는 단계와 맞지 않는 소견이 있어, 혈류·상처 바닥·깊이 확인 후 드레싱을 선택해야 합니다." : "현재 사정에서는 치료용 드레싱 후보를 자동 표시하지 않습니다. 아래 이유와 필요한 확인사항을 확인하세요."}</p></div>}
      {selected && <div className="pl-dressing-backdrop" onClick={() => setSelected(null)}><section role="dialog" aria-modal="true" aria-label="드레싱 제품 예시" className="pl-dressing-dialog" onClick={e => e.stopPropagation()}><div className="flex items-start justify-between gap-3"><h2 className="text-lg font-bold text-teal-900">{selected.title}</h2><button ref={closeRef} type="button" aria-label="팝업 닫기" onClick={() => setSelected(null)} className="p-2 rounded-lg bg-slate-100"><X size={20}/></button></div><p className="text-xs text-slate-500 mt-2">제품 예시 · 세부 모델별 적응증 확인</p><p className="text-sm mt-3">{selected.why}</p><p className="text-xs text-amber-800 mt-2">{selected.caution}</p>{keysFor(selected.title).map(key => { const card = dressingCards.find(c => c.key === key); const examples = key === "foam" && selected.title.includes("저흡수성") ? ["Mepilex Lite (메필렉스 라이트: 비테두리형, 삼출액 없음~소량)", "Mepilex Border Flex Lite (메필렉스 보더 플렉스 라이트: 테두리형, 삼출액 없음~중등도; 국내 공급·허가 및 제품 설명서 확인)"] : dressingProducts[key]; return <div key={key} className="rounded-xl border border-teal-100 bg-teal-50 p-3 mt-3"><h3 className="font-bold text-sm">{card.title}</h3><p className="text-xs mt-2">{card.desc}</p><ul className="text-sm space-y-2 mt-3">{examples.map(name => <li key={name}>• {name}</li>)}</ul>{key === "foam" && <p className="text-xs text-amber-900 mt-3">일반 Mepilex Border Flex와 Lite의 흡수력·적응증은 다릅니다. 제조사 자료에서 일반 Border Flex의 건조 상처 적용은 겔 병용 조건이며, 안정된 발꿈치·허혈성 가피를 임의로 연화하라는 뜻은 아닙니다.</p>}</div>; })}<p className="text-xs text-slate-500 mt-4">상처 상태·수분 균형·주변 피부에 맞춰 종류를 선택합니다. 제품명은 교육용 예시이며 특정 제품으로 선택을 확정하지 않습니다.</p><div className="text-xs space-y-2 mt-3"><a className="block text-teal-700 underline" href="https://www.internationalguideline.com/woundhealing" target="_blank" rel="noreferrer">국제 욕창 지침 · 상처 상태에 따른 선택</a><a className="block text-teal-700 underline" href="https://www.molnlycke.com/globalassets/local/anz/cwcs_molnlycke-product-catalogue.pdf" target="_blank" rel="noreferrer">Mölnlycke 제품 설명 · Flex / Lite 구분</a></div><button type="button" onClick={() => setSelected(null)} className="w-full rounded-xl bg-teal-600 text-white py-3 mt-4">닫기</button></section></div>}
      {result.notes.length > 0 && <div className="mt-3 space-y-1">{result.notes.map((n,i) => <p key={i} className="text-xs text-amber-800">• {n}</p>)}</div>}
      <p className="text-xs text-slate-500 mt-3">최종 선택 전 혈류·감염·통증·사강·제품별 적응증·기관 프로토콜 및 담당의/WOCN 판단을 확인하세요. 홈의 욕창 교육자료 → ③ 드레싱 선택 원칙에서 종류별 상세 설명을 볼 수 있습니다.</p>
    </Card>
  );
}

function BilingualChip({active,onClick,children}) {return <button type="button" onClick={onClick} className={"w-full min-h-[68px] px-2 py-3 rounded-2xl border text-sm transition-colors "+(active?"text-white border-transparent":"bg-white text-slate-700 border-slate-300")} style={active?{backgroundColor:"#07848a"}:{}}>{children}</button>;}
function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={"px-3 py-2 rounded-full border text-sm font-medium transition-colors " +
        (active ? "text-white border-transparent" : "bg-white text-slate-700 border-slate-300")}
      style={active ? { backgroundColor: "#087F83" } : {}}>
      {children}
    </button>
  );
}


function ArtIcon({kind,size=64}){const areas={camera:[63,508,260,220],records:[100,780,300,268],education:[521,781,340,275],braden:[84,1215,330,290],info:[530,1225,320,280],skin:[510,92,410,350]};const [x,y,w,h]=areas[kind]||areas.records;return <span aria-hidden="true" className="pl-art-icon pl-reference-art" style={{width:size,height:size,backgroundImage:"url('/images/home-approved.png')",backgroundSize:(941/w*100)+'% '+(1672/h*100)+'%',backgroundPosition:(x/(941-w)*100)+'% '+(y/(1672-h)*100)+'%'}}/>;}
function StageIllustration({code}){const cells={'1':[40,210],'2':[550,210],'3':[40,660],'4':[550,660],U:[40,1110],DTPI:[550,1110]};const cell=cells[code];if(!cell)return null;return <div className="pl-stage-original" role="img" aria-label={stageLabel(code)+' 교육용 입체 단면 모식도'} style={{backgroundPosition:(cell[0]/584*100)+'% '+(cell[1]/1256*100)+'%'}}/>;}
function PageIntro({title,sub,kind}){return <div className={'pl-page-intro pl-tone-'+kind}><div><h1>{title}</h1>{sub&&<p>{sub}</p>}</div><ArtIcon kind={kind} size={82}/></div>}
function PageToolbar({onBack,subtitle}) {
  return <header className="pl-content-toolbar">
    <button type="button" className="pl-toolbar-button" aria-label="뒤로가기" onClick={onBack}><ChevronLeft size={20}/></button>
    {subtitle && <span className="pl-toolbar-subtitle">{subtitle}</span>}
    <button type="button" className="pl-toolbar-button pl-toolbar-home" aria-label="홈으로" onClick={onBack}><HomeIcon size={21}/></button>
  </header>;
}
function RecordThumb({id}){const [photo,setPhoto]=useState(null);useEffect(()=>{let active=true;setPhoto(null);if(id)loadFull(id).then(r=>{if(active)setPhoto(r?.photo?.dataUrl||null)});return()=>{active=false}},[id]);return photo?<img className="pl-record-thumb" src={photo} alt="저장된 상처 사진"/>:<span className="pl-record-thumb pl-thumb-empty"><ArtIcon kind="records" size={48}/></span>}

function Card({ children, className }) {
  return <div className={"pl-card bg-white rounded-2xl border border-slate-200 shadow-sm p-4 " + (className || "")}>{children}</div>;
}

function SectionTitle({ children }) {
  return <div className="text-sm font-bold text-slate-900 mb-2">{children}</div>;
}

function PrimaryBtn({ onClick, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-3 rounded-xl text-white text-base font-semibold disabled:opacity-40"
      style={{ backgroundColor: "#087F83", color: "#FFFFFF" }}>
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

const STAGE_COLORS={'1':['#fff2df','#9a4d0b'],'2':['#fff0f5','#a52659'],'3':['#fee8eb','#b42336'],'4':['#f5e4ec','#792447'],'U':['#f2e9df','#765030'],'DTPI':['#efe9fb','#6842a0'],'ND':['#edf0f3','#475569'],'HEALED':['#dff5f0','#087568'],'NONE':['#edf0f3','#475569'],'IAD':['#e5f0ff','#315e9c']};
function StageBadge({code}) {const [background,color]=STAGE_COLORS[code]||STAGE_COLORS.ND;return <span className="pl-stage-badge" style={{background,color,borderColor:background}}>{stageLabel(code)}</span>;}
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
function SizingPanel({ size, setSize, areaCm2, onTouched }) {
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
      <p className="text-xs text-slate-500 mt-2">기록 표현: 길이 × 너비 × 깊이(cm). 잠식·터널은 시계 방향과 cm로 기록합니다. 측정값 출처: {size.method === "calibrated" ? "Ruler-assisted (마커 보정)" : "실측값 직접 입력"}</p>
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
  { key: "calib", color: "#2563EB", guide: "① 자의 눈금 구간을 확인하세요. 필요하면 양 끝점을 드래그해 수정하세요" },
 { key: "length", color: "#16A34A", guide: "② 길이: 실제 상처의 가장 긴 축(최장축)의 양 끝을 탭하세요" },
  { key: "width", color: "#EA580C", guide: "③ 너비: 길이 축에 수직인 방향의 최대폭 양 끝을 탭하세요" },
];

function MeasureTool({ photo, onLive, onCalib, initCalib, initMarkerCm, targets, onHumanMeasure, autoRulerStatus }) {
  const nW = Math.max(1, (targets && targets.length) || 1);
  const emptyW = () => Array.from({ length: nW }, () => ({ length: [], width: [] }));
  const [markerCm, setMarkerCm] = useState(initMarkerCm || "1.0");
  const [calib, setCalib] = useState(Array.isArray(initCalib) && initCalib.length === 2 ? initCalib : []);
  const [isDragging, setIsDragging] = useState(false);
  const [scaleConfirmed, setScaleConfirmed] = useState(false);
  const lastReportedCalibRef = useRef(null);
  const initCalibSig = Array.isArray(initCalib) && initCalib.length === 2 ? JSON.stringify(initCalib) : "";
  useEffect(() => {
    if (isDragging) return;
    const incoming = initCalibSig && initMarkerCm != null ? initCalibSig + "|" + initMarkerCm : null;
    // Parent echo of this tool's own pointer edit is not a new seed.
    if (incoming && incoming === lastReportedCalibRef.current) return;
    if (initCalibSig) {
      setCalib(prev => JSON.stringify(prev) === initCalibSig ? prev : initCalib);
      setScaleConfirmed(false);
    }
    if (initMarkerCm != null && initMarkerCm !== "") setMarkerCm(prev => String(prev) === String(initMarkerCm) ? prev : String(initMarkerCm));
  }, [initCalibSig, initMarkerCm, isDragging]);
  const [wpts, setWpts] = useState(emptyW);
  const downRef = useRef(null);
  const boxRef = useRef(null);
const dragRef = useRef(null);
const [zoom, setZoom] = useState(1);
const [pan, setPan] = useState({ x: 0, y: 0 });
const pinchRef = useRef(null);
  let cur = null;
  if (calib.length < 2) cur = { type: "calib" };
  else {
    for (let i = 0; i < nW && !cur; i++) {
      if (wpts[i] && wpts[i].length.length < 2) cur = { type: "length", wi: i };
      else if (wpts[i] && wpts[i].width.length < 2) cur = { type: "width", wi: i };
    }
  }

  const distPx = (pair) => {
    if (
      !photo ||
      !Number.isFinite(Number(photo.w)) ||
      !Number.isFinite(Number(photo.h)) ||
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair[0] ||
      !pair[1]
    ) return 0;
    return Math.hypot(
      (Number(pair[0].x) - Number(pair[1].x)) * Number(photo.w),
      (Number(pair[0].y) - Number(pair[1].y)) * Number(photo.h)
    );
  };
  const mkRaw = Number.parseFloat(markerCm);
  const mk = Number.isFinite(mkRaw) && mkRaw > 0 ? mkRaw : null;
  const calibPx = calib.length === 2 ? distPx(calib) : 0;
  const pxPerCm = calibPx > 2 && mk ? calibPx / mk : null;
  const vals = wpts.map((w) => ({
  lengthCm:
    pxPerCm && w.length.length === 2
      ? fmt1(distPx(w.length) / pxPerCm)
      : null,
  widthCm:
    pxPerCm && w.width.length === 2
      ? fmt1(distPx(w.width) / pxPerCm)
      : null,
}));

  const valsSig = JSON.stringify(vals);
  useEffect(() => {
    if (isDragging) return;
    if (!scaleConfirmed) { onLive({calibrationPending:true}); return; }
    if (vals.some((v) => v.lengthCm != null || v.widthCm != null)) onLive({ wounds: vals });
  }, [valsSig, isDragging, scaleConfirmed]);

  const calibSig = calib.length === 2 && mk > 0 ? JSON.stringify(calib) + "|" + markerCm : null;
  useEffect(() => {
    if (isDragging || !calibSig || !onCalib) return;
    if (lastReportedCalibRef.current === calibSig) return;
    lastReportedCalibRef.current = calibSig;
    onCalib({ calib: calib.map((p) => ({ ...p })), markerCm });
  }, [calibSig, onCalib, isDragging]);

  const snapPerpTo = (L, anchor, p) => {
    if (
      !photo || !Array.isArray(L) || L.length !== 2 ||
      !L[0] || !L[1] || !anchor || !p ||
      !Number.isFinite(Number(photo.w)) || !Number.isFinite(Number(photo.h))
    ) return p;
    const lx = (L[1].x - L[0].x) * photo.w, ly = (L[1].y - L[0].y) * photo.h;
    const llen = Math.hypot(lx, ly);
    if (!llen) return p;
    const ux = -ly / llen, uy = lx / llen;
    const ax = anchor.x * photo.w, ay = anchor.y * photo.h;
    const vx = p.x * photo.w - ax, vy = p.y * photo.h - ay;
    const t = vx * ux + vy * uy;
    return { x: Math.min(1, Math.max(0, (ax + t * ux) / photo.w)), y: Math.min(1, Math.max(0, (ay + t * uy) / photo.h)) };
  };

const handlePinchPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;

    const p = pinchRef.current || { pointers: new Map() };
    p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    p.justPinched = false;
    if (p.pointers.size === 1) p.singleStart = {x:e.clientX,y:e.clientY,pan:{...pan}};
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();

    if (p.pointers.size === 2) {
      const pts = [...p.pointers.values()];
      const rect = boxRef.current?.getBoundingClientRect();
      const center = {
        x: ((pts[0].x + pts[1].x) / 2) - (rect?.left || 0),
        y: ((pts[0].y + pts[1].y) / 2) - (rect?.top || 0),
      };
      p.startDistance = Math.max(1, Math.hypot(
        pts[0].x - pts[1].x,
        pts[0].y - pts[1].y
      ));
      p.startZoom = zoom;
      p.startPan = { ...pan };
      p.startCenter = center;
      p.pinching = true;
    }

    pinchRef.current = p;
  };

  const handlePinchPointerMove = (e) => {
    if (!pinchRef.current) return;

    const p = pinchRef.current;
    if (!p.pointers.has(e.pointerId)) return;

    p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (p.pointers.size === 1 && p.singleStart && zoom > 1) {
      const dx=e.clientX-p.singleStart.x,dy=e.clientY-p.singleStart.y;
      if (Math.hypot(dx,dy)>6 || p.justPinched) {
        const rect=boxRef.current?.getBoundingClientRect();
        if(rect) setPan({x:Math.min(0,Math.max(-rect.width*(zoom-1),p.singleStart.pan.x+dx)),
          y:Math.min(0,Math.max(-rect.height*(zoom-1),p.singleStart.pan.y+dy))});
        p.justPinched=true; downRef.current=null; e.preventDefault();
      }
    }
    if (p.pointers.size === 2 && p.startDistance) {
      const pts = [...p.pointers.values()];
      const distance = Math.hypot(
        pts[0].x - pts[1].x,
        pts[0].y - pts[1].y
      );
      const nextZoom = Math.min(
        4,
        Math.max(1, p.startZoom * (distance / p.startDistance))
      );

      const center = {
        x: ((pts[0].x + pts[1].x) / 2) - (boxRef.current?.getBoundingClientRect().left || 0),
        y: ((pts[0].y + pts[1].y) / 2) - (boxRef.current?.getBoundingClientRect().top || 0),
      };

      const ratio = nextZoom / p.startZoom;
      const nextPan = {
        x: center.x - (p.startCenter.x - p.startPan.x) * ratio,
        y: center.y - (p.startCenter.y - p.startPan.y) * ratio,
      };

      const rect = boxRef.current?.getBoundingClientRect();
      const maxX = rect ? rect.width * (nextZoom - 1) : 0;
      const maxY = rect ? rect.height * (nextZoom - 1) : 0;

      setZoom(nextZoom);
      setPan({
        x: Math.min(0, Math.max(-maxX, nextPan.x)),
        y: Math.min(0, Math.max(-maxY, nextPan.y)),
      });
      p.pinching = true;
      p.justPinched = true;
    }
  };

  const handlePinchPointerUp = (e) => {
    if (!pinchRef.current) return;
    const p = pinchRef.current;
    p.pointers.delete(e.pointerId);
    if(e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if(p.pointers.size===1) {const remaining=[...p.pointers.values()][0];p.singleStart={...remaining,pan:{...pan}};}
    else p.singleStart=null;

    if (p.pointers.size < 2) {
      if (p.pinching) p.justPinched = true;
      p.startDistance = null;
      p.pinching = false;
    }
  };

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const changeZoom = (delta) => {
    const next = Math.min(4, Math.max(1, zoom + delta));
    setZoom(next);
    if (next === 1) setPan({ x: 0, y: 0 });
  };

  const posFromEvent = (e) => {
    const rect = boxRef.current
      ? boxRef.current.getBoundingClientRect()
      : e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left - pan.x) / (rect.width * zoom))),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top - pan.y) / (rect.height * zoom))),
    };
  };
    const startDrag = (e, kind, wi, axis, pi) => {
    e.stopPropagation();
    e.preventDefault();

    downRef.current = null;
    setIsDragging(true);
    if (kind === "calib" || axis === "calib") setScaleConfirmed(false);
    const p = posFromEvent(e);

    if (kind === "line") {
      const points =
        axis === "calib"
          ? calib
          : (wpts[wi]?.[axis] || []);

      if (points.length !== 2) return;

      dragRef.current = {
        pointerId: e.pointerId,
        kind: "line",
        wi,
        axis,
        start: p,
        points: points.map((q) => ({ ...q }))
      };
    } else {
      dragRef.current = {
        pointerId: e.pointerId,
        kind,
        wi,
        axis,
        pi
      };
    }

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
  };

  const moveDrag = (e) => {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();

    const p = posFromEvent(e);
    const d = dragRef.current;

    if (d.kind === "line") {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;

      const moved = d.points.map((q) => ({
        x: Math.min(1, Math.max(0, q.x + dx)),
        y: Math.min(1, Math.max(0, q.y + dy))
      }));

      if (d.axis === "calib") {
        setCalib(moved);
      } else {
        setWpts((ws) => {
          const n = ws.map((w) => ({
            length: [...w.length],
            width: [...w.width]
          }));

          if (!n[d.wi]) return ws;

          n[d.wi][d.axis] = moved;
          return n;
        });
      }

      d.start = p;
      d.points = moved;
      return;
    }

    if (d.kind === "calib") {
      // 캘리브레이션 두 점은 완전 자유 이동: 수평/자의 방향 스냅 없음.
      setCalib((c) => c.map((q, i) => (i === d.pi ? p : q)));
      return;
    }

    setWpts((ws) => {
      const n = ws.map((w) => ({
        length: [...w.length],
        width: [...w.width]
      }));

      if (!n[d.wi] || n[d.wi][d.axis].length <= d.pi) {
        return ws;
      }

      n[d.wi][d.axis][d.pi] = p;

      if (
        n[d.wi].length.length === 2 &&
        n[d.wi].width.length === 2
      ) {
        n[d.wi].width = [
          n[d.wi].width[0],
          snapPerpTo(
            n[d.wi].length,
            n[d.wi].width[0],
            n[d.wi].width[1]
          )
        ];
      }

      return n;
    });
  };

  const endDrag = (e) => {
    e.stopPropagation();
    if (dragRef.current && dragRef.current.pointerId !== e.pointerId) return;
    dragRef.current = null; downRef.current = null;
    setIsDragging(false);
    try { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  const handleTap = (e) => {
    if (dragRef.current || isDragging || !cur || !photo || !photo.w || !photo.h) return;
    let p = posFromEvent(e);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (cur.type === "calib") {
      // AI가 제안한 1 cm 선은 자유롭게 수정합니다.
      // 화면 수평이나 자의 기울기에 맞춰 강제로 스냅하지 않습니다.
      setScaleConfirmed(false);
      setCalib((c) => c.length < 2 ? [...c, p] : c);
      return;
    }
    if (onHumanMeasure) onHumanMeasure();
    setWpts((ws) => {
      const n = ws.map((w) => ({ length: [...(w?.length || [])], width: [...(w?.width || [])] }));
      if (!n[cur.wi] || !Array.isArray(n[cur.wi][cur.type])) return ws;
      if (cur.type === "width" && n[cur.wi].width.length === 1 && n[cur.wi].length.length === 2) {
        p = snapPerpTo(n[cur.wi].length, n[cur.wi].width[0], p);
      }
      if (n[cur.wi][cur.type].length >= 2) return ws;
      n[cur.wi][cur.type] = [...n[cur.wi][cur.type], p];
      return n;
    });
  };
  const undo = () => {
    if (onHumanMeasure) onHumanMeasure();
    for (let i = nW - 1; i >= 0; i--) {
      if (wpts[i].width.length > 0) { setWpts((ws) => ws.map((w, j) => j === i ? { ...w, width: w.width.slice(0, -1) } : w)); return; }
      if (wpts[i].length.length > 0) { setWpts((ws) => ws.map((w, j) => j === i ? { ...w, length: w.length.slice(0, -1) } : w)); return; }
    }
    if (calib.length > 0) { setScaleConfirmed(false); setCalib(c => c.slice(0,-1)); onCalib?.(null); }
  };
  const reset = () => { setScaleConfirmed(false); lastReportedCalibRef.current=null; onCalib?.(null); setCalib([]); setWpts(emptyW()); if (onHumanMeasure) onHumanMeasure(); };

  const mid = (pair) => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const guideText = !cur ? scaleConfirmed ? "측정 완료 — 점을 끌어 옮기고 놓으면 입력값에 반영됩니다." : "눈금 기준 확인 전 — 파란 선 위치와 cm 간격을 먼저 확인하세요."
    : cur.type === "calib" ? MEASURE_STEPS[0].guide
   : cur.type === "length" ? `${nW > 1 ? `상처 ${CIRC[cur.wi]} ` : ""}길이: 실제 상처의 가장 긴 축(최장축)의 양 끝을 탭하세요`
    : `${nW > 1 ? `상처 ${CIRC[cur.wi]} ` : ""}너비: 길이와 직각 방향 최대폭의 양 끝을 탭하세요`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2 text-sm">
        <div className="flex items-center gap-1">
          <button onClick={() => changeZoom(-0.5)} className="w-9 h-9 rounded-lg border border-slate-300 bg-white text-lg font-bold" disabled={zoom <= 1}>−</button>
          <button onClick={resetZoom} className="px-2 h-9 rounded-lg border border-slate-300 bg-white text-xs font-semibold">{Math.round(zoom * 100)}%</button>
          <button onClick={() => changeZoom(0.5)} className="w-9 h-9 rounded-lg border border-slate-300 bg-white text-lg font-bold" disabled={zoom >= 4}>+</button>
        </div>
      </div>

      <p className="text-xs text-slate-500">확대 후 사진을 끌면 이동합니다. 눈금 점과 측정선을 끌면 위치를 수정합니다.</p>
      <div
        ref={boxRef}
        className="relative rounded-xl overflow-hidden border border-slate-300 select-none bg-slate-100"
        onPointerDown={(e) => {
          if (dragRef.current) { downRef.current = null; return; }
          handlePinchPointerDown(e);
          downRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={handlePinchPointerMove}
        onPointerUp={(e) => {
          handlePinchPointerUp(e);
          if (pinchRef.current?.justPinched) {
            downRef.current = null;
            pinchRef.current.justPinched = false;
            return;
          }
          if (dragRef.current) {
            dragRef.current = null;
            downRef.current = null;
            return;
          }
          const s = downRef.current;
          downRef.current = null;
          if (!s || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) return;
          handleTap(e);
        }}
        onPointerCancel={(e) => {
          handlePinchPointerUp(e);
          downRef.current = null;
          dragRef.current = null; setIsDragging(false);
        }}
        style={{ touchAction: "none", cursor: zoom > 1 ? "grab" : "crosshair" }}
      >
        <div
          className="relative"
          style={{
            width: "100%",
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          <img
            src={photo.dataUrl}
            alt="wound"
            className="w-full h-auto block"
            draggable={false}
          />

          <svg
            className="absolute inset-0 w-full h-full"
            viewBox={`0 0 ${photo.w} ${photo.h}`}
            preserveAspectRatio="none"
            style={{ pointerEvents: "auto" }}
          >
            {calib.length === 2 && (
              <>
                <line
                  x1={calib[0].x * photo.w}
                  y1={calib[0].y * photo.h}
                  x2={calib[1].x * photo.w}
                  y2={calib[1].y * photo.h}
                  stroke="transparent"
                  strokeWidth="34"
                  pointerEvents="stroke"
                  onPointerDown={(e) => startDrag(e, "line", 0, "calib", null)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  style={{ cursor: "move", touchAction: "none" }}
                />
                <line
                  x1={calib[0].x * photo.w}
                  y1={calib[0].y * photo.h}
                  x2={calib[1].x * photo.w}
                  y2={calib[1].y * photo.h}
                  stroke="#2563EB"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              </>
            )}

            {wpts.map((w, i) => (
              <g key={i}>
                {w.length.length === 2 && (
                  <>
                    <line
                      x1={w.length[0].x * photo.w}
                      y1={w.length[0].y * photo.h}
                      x2={w.length[1].x * photo.w}
                      y2={w.length[1].y * photo.h}
                      stroke="#000"
                      strokeOpacity="0.001"
                      strokeWidth="30"
                      pointerEvents="none"
                      style={{ cursor: "move", touchAction: "none" }}
                    />
                    <line
                      x1={w.length[0].x * photo.w}
                      y1={w.length[0].y * photo.h}
                      x2={w.length[1].x * photo.w}
                      y2={w.length[1].y * photo.h}
                      stroke="#16A34A"
                      strokeWidth="3"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  </>
                )}

                {w.width.length === 2 && (
                  <>
                    <line
                      x1={w.width[0].x * photo.w}
                      y1={w.width[0].y * photo.h}
                      x2={w.width[1].x * photo.w}
                      y2={w.width[1].y * photo.h}
                      stroke="#000"
                      strokeOpacity="0.001"
                      strokeWidth="30"
                      pointerEvents="none"
                      style={{ cursor: "move", touchAction: "none" }}
                    />
                    <line
                      x1={w.width[0].x * photo.w}
                      y1={w.width[0].y * photo.h}
                      x2={w.width[1].x * photo.w}
                      y2={w.width[1].y * photo.h}
                      stroke="#EA580C"
                      strokeWidth="3"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  </>
                )}
              </g>
            ))}
          </svg>

          {calib.map((p, i) => (
            <div
              key={"c" + i}
              aria-label={"자 기준점 " + (i+1)}
              data-measure-point="true"
              className="absolute flex items-center justify-center"
              onPointerDown={(e) => startDrag(e, "calib", 0, null, i)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{
                left: `${p.x * 100}%`,
                top: `${p.y * 100}%`,
                transform: "translate(-50%,-50%)",
                width: `${20 / zoom}px`,
                height: `${20 / zoom}px`,
                touchAction: "none",
                cursor: "grab",
                zIndex: 5,
              }}
            >
              <div className="rounded-full border-2 border-white shadow" style={{ width: `${7 / zoom}px`, height: `${7 / zoom}px`, backgroundColor: "#2563EB" }} />
            </div>
          ))}

          {wpts.map((w, i) => (
            <React.Fragment key={"wp" + i}>
              {w.length.map((p, j) => (
                <div
                  key={"l" + j}
                  aria-label={"상처 " + (i+1) + " 길이점 " + (j+1)}
                  data-measure-point="true"
                  className="absolute flex items-center justify-center"
                  onPointerDown={(e) => startDrag(e, "wound", i, "length", j)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  style={{
                    left: `${p.x * 100}%`,
                    top: `${p.y * 100}%`,
                    transform: "translate(-50%,-50%)",
                    width: `${28 / zoom}px`,
                    height: `${28 / zoom}px`,
                    touchAction: "none",
                    cursor: "grab",
                    zIndex: 5,
                  }}
                >
                  <div className="rounded-full border-2 border-white shadow" style={{ width: `${7 / zoom}px`, height: `${7 / zoom}px`, backgroundColor: "#16A34A" }} />
                </div>
              ))}

              {w.width.map((p, j) => (
                <div
                  key={"w" + j}
                  aria-label={"상처 " + (i+1) + " 너비점 " + (j+1)}
                  data-measure-point="true"
                  className="absolute flex items-center justify-center"
                  onPointerDown={(e) => startDrag(e, "wound", i, "width", j)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  style={{
                    left: `${p.x * 100}%`,
                    top: `${p.y * 100}%`,
                    transform: "translate(-50%,-50%)",
                    width: `${28 / zoom}px`,
                    height: `${28 / zoom}px`,
                    touchAction: "none",
                    cursor: "grab",
                    zIndex: 5,
                  }}
                >
                  <div className="rounded-full border-2 border-white shadow" style={{ width: `${7 / zoom}px`, height: `${7 / zoom}px`, backgroundColor: "#EA580C" }} />
                </div>
              ))}

            </React.Fragment>
          ))}


          {targets && targets.length ? <TargetRings points={targets} /> : null}
        </div>

        {zoom > 1 && (
          <div className="absolute left-2 bottom-2 z-20 rounded-lg bg-black/60 px-2 py-1 text-[11px] text-white pointer-events-none">
            두 손가락으로 확대 · 이동
          </div>
        )}
      </div>

      <div className="rounded-xl border border-teal-200 p-3 space-y-2">
        <label className="block text-sm font-semibold">파란 선 양 끝 눈금의 실제 간격 (cm)<input aria-label="자 기준 간격 cm" type="number" min="0.01" step="0.1" inputMode="decimal" value={markerCm} onChange={e => {setMarkerCm(e.target.value); setScaleConfirmed(false);}} className="mt-2 w-full rounded-lg border border-slate-300 p-2" /></label>
        <button type="button" disabled={calib.length !== 2 || !mk || isDragging} onClick={() => setScaleConfirmed(true)} className="w-full rounded-xl bg-teal-600 text-white p-3 disabled:opacity-40">{scaleConfirmed ? "눈금 기준 확인됨" : "파란 선 위치와 cm 간격 확인"}</button>
        {!scaleConfirmed && <p className="text-xs text-amber-800">확인 전에는 계산값을 기록에 반영하지 않습니다. AI 좌표는 실제 눈금과 다를 수 있습니다.</p>}
      </div>
      <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800 font-medium">
        {guideText}
      </div>


      <div className="space-y-0.5">
        {vals.map((v, i) => (
          <div key={i} className="flex items-center gap-3 text-sm font-semibold">
            {nW > 1 && <span style={{ color: "#00B8D9" }}>{CIRC[i]}</span>}
            <span style={{ color: "#16A34A" }}>길이 {v.lengthCm != null ? `${v.lengthCm} cm` : "-"}</span>
            <span style={{ color: "#EA580C" }}>너비 {v.widthCm != null ? `${v.widthCm} cm` : "-"}</span>
          </div>
        ))}
        <div className="text-slate-400 font-normal" style={{ fontSize: 11 }}>
          너비는 길이 축에 자동 수직 보정
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={undo} className="flex-1 py-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">한 점 취소</button>
        <button onClick={reset} className="flex-1 py-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700">전체 초기화</button>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">
        정의: Length = 실제 상처의 가장 긴 축(최장축) · Width = Length에 수직인 방향의 최대 폭.
        찍은 점은 끌어서 미세 조정할 수 있습니다.
        {Array.isArray(initCalib) && initCalib.length === 2 ? " 표시된 자 기준은 직접 수정할 수 있습니다 — 다시 지정하려면 전체 초기화하세요." : ""}
      </p>
    </div>
  );
}

function ClinicalStageGuide({ final, setFinal }) {
  const cc = final.clinChecks || {};

  const setStage = (stage) => setFinal((f) => applyClinicalGuide(f,stage));
  const intact = cc.intact;
  const partial = cc.partial;
  const slough = cc.depthObscured;
  const fat = cc.fat;
  const deep = cc.deep;

  let result = null;
  let resultNote = null;
  if (intact === "yes") {
    if (cc.blanching === "blanch") {
      result = "NONE";
      resultNote = "Blanchable erythema — 반응성 충혈 가능성";
    } else if (cc.blanching === "nonblanch") {
      result = "1";
      resultNote = "Intact skin + non-blanchable erythema → Stage 1 후보";
    }
  } else if (intact === "no") {
    if (deep === "yes") {
      result = "4"; resultNote = "심부 구조의 노출·직접 촉지가 확인되어 Stage 4를 검토합니다.";
    } else if (partial === "yes" && slough === "no" && cc.sloughEschar === "no" && fat === "no" && deep === "no") {
      result = "2";
      resultNote = "부분층 손상 + 지방/심부조직/Slough·Eschar 없음 → Stage 2 후보";
    } else if (slough === "yes" && partial !== "yes") {
      result = "U";
      resultNote = "괴사조직이 깊이를 가리는 경우 → Unstageable 검토";
    } else if (deep === "yes") {
      result = "4";
      resultNote = "심부 구조(근막·근육·건·뼈) 노출/촉지 확인 → Stage 4 후보";
    } else if (fat === "yes" && deep === "no" && slough === "no") {
      result = "3";
      resultNote = "전층 손상 + 피하지방 확인, 심부 구조 미확인 → Stage 3 후보";
    }
  }

  const choose = (k,v) => setFinal(f=>updateClinicalGuide(f,k,v));

  const applied=clinicalGuideApplied(final,result);
  return (
    <Card>
      <SectionTitle>임상 확인으로 단계 좁히기</SectionTitle>
      <p className="text-xs text-slate-500 leading-relaxed mb-3">AI 결과를 그대로 확정하지 않고, 직접 확인한 소견을 순서대로 선택합니다. 아래 결과는 <b>판정 보조</b>이며 최종 임상 판단은 사정자가 합니다.</p>

      <div className="space-y-2">
        <TriRow label="① 피부가 온전한가?" value={intact} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("intact", v)} />

        {intact === "yes" && (
          <>
            <TriRow label="② 발적을 눌렀을 때 하얗게 변하는가?" value={cc.blanching} opts={[["blanch","예 · Blanchable"],["nonblanch","아니오 · Non-blanchable"],["na","판단 불가"]]} onChange={(v) => choose("blanching", v)} />
            <p className="text-xs text-slate-500 px-1">Non-blanchable + intact skin이면 Stage 1을 검토합니다. 보라/적갈색 변색이나 혈성 수포가 있으면 DTPI를 별도로 검토하세요.</p>
          </>
        )}

        {intact === "no" && (
          <>
            <TriRow label="② 부분층 피부손상인가?" value={partial} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("partial", v)} />
            <TriRow label="③ 부육·가피가 보이는가?" value={cc.sloughEschar} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("sloughEschar", v)} />
            <TriRow label="③-1 부육·가피 때문에 실제 깊이를 확인할 수 없는가?" value={slough} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("depthObscured", v)} />
            <TriRow label="④ 지방조직이 보이거나 만져지는가?" value={fat} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("fat", v)} />
            <TriRow label="⑤ 근막·근육·건·연골·뼈가 노출/직접 촉지되는가?" value={deep} opts={[["yes","예"],["no","아니오"],["na","판단 불가"]]} onChange={(v) => choose("deep", v)} />
          </>
        )}
      </div>

      {!result&&<p role="status" className="pl-clinical-status">필요한 소견이 미확인 또는 서로 맞지 않아 후보를 정하지 않았습니다. 현재 최종 분류는 {stageLabel(final.stage)}입니다. 직접 재사정하거나 전문가에게 확인하세요.</p>}
      {result && (
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
          <div className="text-xs text-sky-700 font-semibold">확인 결과 · 판정 보조</div>
          <div className="text-base font-bold text-sky-900 mt-0.5">{stageLabel(result)}</div>
          <div className="text-xs text-sky-800 mt-1">{resultNote}</div>
          <button type="button" disabled={applied} onClick={() => setStage(result)} className={"pl-clinical-apply"+(applied?" is-applied":"")} aria-label={applied?"최종 판단 반영 완료":"이 결과를 최종 판단에 반영"}>{applied?"✓ 반영 완료 · "+stageLabel(final.stage):"이 결과를 최종 판단에 반영"}</button>
          <p role="status" aria-live="polite" className="pl-clinical-status">{applied?"최종 분류가 "+stageLabel(final.stage)+"로 반영되었습니다. 사정 저장 시 함께 기록됩니다.":final.clinicalApplied?"사정값 또는 최종 분류가 변경되었습니다. 확인 후 다시 반영하세요.":"현재 최종 분류: "+stageLabel(final.stage)+" · 반영하면 위의 최종 선택도 바뀝니다."}</p>
        </div>
      )}
    </Card>
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

function NewAssessment(props) {
  return <AssessmentDraftGate storage={storage} woundId={props.initFollowWoundId} resumeDraftId={props.resumeDraftId} idx={props.idx} onHome={props.onCancel}>
    {(initialDraft,assessmentDraftKey)=><NewAssessmentForm {...props} initialDraft={initialDraft} assessmentDraftKey={assessmentDraftKey}/>}
  </AssessmentDraftGate>;
}

function NewAssessmentForm({ idx, initFollowWoundId, onSaved, onIdxUpdate, onCancel, initialDraft, assessmentDraftKey }) {
  const initWound = initFollowWoundId && idx.wounds[initFollowWoundId] ? idx.wounds[initFollowWoundId] : null;
  const [step, setStep] = useState(() => draftValue(initialDraft,"step",() => (1)));

  const assessmentTopRef = useRef(null);
  React.useLayoutEffect(() => {
    const root = assessmentTopRef.current;
    const focused = document.activeElement;
    if (root && focused && root.contains(focused) && typeof focused.blur === "function")
      focused.blur();
    const reset = () => {
      for (let node = root; node; node = node.parentElement) node.scrollTop = 0;
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      window.scrollTo({top:0, left:0, behavior:"instant"});
    };
    reset();
    const frame = requestAnimationFrame(reset);
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const [pid, setPid] = useState(() => draftValue(initialDraft,"pid",() => (initWound ? initWound.patientId : "")));
  const [demo, setDemo] = useState(() => draftValue(initialDraft,"demo",() => ({ ward: "", room: "", sex: "", age: "" })));
  const [mode, setMode] = useState(() => draftValue(initialDraft,"mode",() => (initWound ? "follow" : "new"))); // new | follow
  const [selWoundId, setSelWoundId] = useState(() => draftValue(initialDraft,"selWoundId",() => (initWound ? initWound.id : null)));
  const [showWoundPicker,setShowWoundPicker]=useState(false);
  const [draftWoundId, setDraftWoundId] = useState(() => draftValue(initialDraft,"draftWoundId",() => (initWound?.id||null)));
  const [followRecords,setFollowRecords]=useState({});
  useEffect(()=>{let active=true;const wounds=Object.values(idx.wounds).filter(w=>w.patientId===pid.trim());
    Promise.all(wounds.map(async w=>{const latest=orderedWoundAssessments(idx,w.id)[0];return [w.id,{summary:latest,record:latest?await loadFull(latest.id):null}]})).then(rows=>{if(active)setFollowRecords(Object.fromEntries(rows))});return()=>{active=false};
  },[idx,pid]);
  const [location, setLocation] = useState(() => draftValue(initialDraft,"location",() => (null)));
  const [locationSub, setLocationSub] = useState(() => draftValue(initialDraft,"locationSub",() => ("")));
  const [assessDate, setAssessDate] = useState(() => draftValue(initialDraft,"assessDate",() => (dateToInput(new Date()))));

  const [photo, setPhoto] = useState(() => draftValue(initialDraft,"photo",() => (null)));
  const [quality, setQuality] = useState(() => draftValue(initialDraft,"quality",() => (null)));
  const [photoErr, setPhotoErr] = useState("");
  const [photoLoading,setPhotoLoading]=useState(false);
  const [refPhoto, setRefPhoto] = useState(null);
  const [refPhotoError, setRefPhotoError] = useState('');
  const [refPhotoLoading, setRefPhotoLoading] = useState(false);
  const aiRequestRef = useRef(null);
  useEffect(() => () => { aiRequestRef.current?.abort(); aiRequestRef.current = null; }, []);
  const cancelAi = (isBatch = false) => {
    aiRequestRef.current?.abort(); aiRequestRef.current = null;
    if (isBatch) {setBatchStatus('error');setBatchErr('분석을 취소했습니다. 입력값은 유지됩니다.');}
    else {setAiStatus('error');setAiErr('분석을 취소했습니다. 입력값은 유지됩니다.');}
  };
  useEffect(() => { if (step !== 4 && aiRequestRef.current) {aiRequestRef.current.abort();aiRequestRef.current=null;setAiStatus('idle');setBatchStatus('idle');} }, [step]);
  const [multiWound, setMultiWound] = useState(() => draftValue(initialDraft,"multiWound",() => (false)));
  const [targets, setTargets] = useState(() => draftValue(initialDraft,"targets",() => ([])));
  const [calibCarry, setCalibCarry] = useState(() => draftValue(initialDraft,"calibCarry",() => (null)));
  const [savedFlash, setSavedFlash] = useState("");
  const tapRef = useRef(null);
  const [prevFinal, setPrevFinal] = useState(() => draftValue(initialDraft,"prevFinal",() => (null)));
  const [quickMode, setQuickMode] = useState(() => draftValue(initialDraft,"quickMode",() => (false)));
  const [aiBatch, setAiBatch] = useState(() => draftValue(initialDraft,"aiBatch",() => (null)));
  const [batchStatus, setBatchStatus] = useState(() => draftValue(initialDraft,"batchStatus",() => ("idle")));
  const [batchErr, setBatchErr] = useState(() => draftValue(initialDraft,"batchErr",() => ("")));
  const [batchStages, setBatchStages] = useState(() => draftValue(initialDraft,"batchStages",() => ([])));
  const [batchMemo, setBatchMemo] = useState(() => draftValue(initialDraft,"batchMemo",() => ("")));
  const [batchSizes, setBatchSizes] = useState(() => draftValue(initialDraft,"batchSizes",() => ([])));
  const [batchProg, setBatchProg] = useState(() => draftValue(initialDraft,"batchProg",() => (0)));
  const [showDetail, setShowDetail] = useState(false);
  const [measureMode, setMeasureMode] = useState(() => draftValue(initialDraft,"measureMode",() => ("manual")));
  const [autoRulerStatus, setAutoRulerStatus] = useState(() => draftValue(initialDraft,"autoRulerStatus",() => ("idle")));
  const [autoRulerNote, setAutoRulerNote] = useState(() => draftValue(initialDraft,"autoRulerNote",() => ("")));
  const rulerSourceRef = useRef(null);
  const rulerRequestRef = useRef(0);
  const photoRequestRef = useRef(0);
  useEffect(() => () => { rulerRequestRef.current++; photoRequestRef.current++; }, []);
  const [size, setSize] = useState(() => draftValue(initialDraft,"size",() => ({ lengthCm: "", widthCm: "", depthCm: "", undermining: "", tunneling: "", method: "manual" })));

  const [ai, setAi] = useState(() => draftValue(initialDraft,"ai",() => (null)));
  const [aiStatus, setAiStatus] = useState(() => draftValue(initialDraft,"aiStatus",() => ("idle"))); // idle|loading|done|error
  const [aiErr, setAiErr] = useState(() => draftValue(initialDraft,"aiErr",() => ("")));
  const [aiApplied, setAiApplied] = useState(() => draftValue(initialDraft,"aiApplied",() => (false)));

  const [final, setFinal] = useState(() => draftValue(initialDraft,"final",() => (emptyFinal())));
  const [braden, setBraden] = useState(() => draftValue(initialDraft,"braden",() => (emptyBraden())));
  const [showBraden, setShowBraden] = useState(false);
  const [blanchModal, setBlanchModal] = useState(false);
  const [iadModal, setIadModal] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  usePhoneBack(step>1,()=>setStep(v=>v-1),20);
  usePhoneBack(blanchModal||iadModal||showWoundPicker||showDetail,()=>{if(blanchModal)setBlanchModal(false);else if(iadModal)setIadModal(false);else if(showWoundPicker)setShowWoundPicker(false);else setShowDetail(false);},80);
  const [deeperChecked, setDeeperChecked] = useState(() => draftValue(initialDraft,"deeperChecked",() => (false)));
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const draft = useAssessmentDraft({storage,key:assessmentDraftKey,initialDraft,
    values:{step,pid,demo,mode,selWoundId,draftWoundId,location,locationSub,assessDate,photo,quality,multiWound,targets,calibCarry,prevFinal,quickMode,aiBatch,batchStatus,batchErr,batchStages,batchMemo,batchSizes,batchProg,measureMode,autoRulerStatus,autoRulerNote,size,ai,aiStatus,aiErr,aiApplied,final,braden,deeperChecked},meaningful:!!(pid.trim()||photo||location||step>1||final.memo)});
  const leavingDraft = useRef(false);
  const leaveAssessment = async () => {
    if(leavingDraft.current||saving)return;
    leavingDraft.current=true;
    aiRequestRef.current?.abort();
    if(await draft.flush())onCancel();
    else leavingDraft.current=false;
  };
  usePhoneBack(true,leaveAssessment,10);

  const restoredDraftDemo = useRef(!!initialDraft);
  const existing = idx.patients[pid.trim()];
  const patientWounds = Object.values(idx.wounds).filter((w) => w.patientId === pid.trim());

  useEffect(() => {
    if(restoredDraftDemo.current){restoredDraftDemo.current=false;return;}
    if (existing) setDemo({ ward: existing.ward || "", room: existing.room || "", sex: existing.sex || "", age: existing.age || "" });
  }, [pid]);

  // Reference records follow observation date, not insertion order.
  useEffect(() => {
    let active = true; setRefPhoto(null); setRefPhotoError('');
    if (step !== 2 || mode !== 'follow' || !selWoundId) return;
    setRefPhotoLoading(true);
    (async () => {
      try {
        const previous = orderedWoundAssessments(idx,selWoundId,assessDate).find(a => a.hasPhoto);
        if (previous) {
          const full = await loadFull(previous.id);
          if (!full?.photo) throw new Error('이전 사진을 불러오지 못했습니다.');
          if (active) setRefPhoto(full.photo.dataUrl);
        }
      } catch(error) { if(active)setRefPhotoError(error.message); }
      finally {if(active)setRefPhotoLoading(false);}
    })();
    return () => {active=false;};
  }, [step,mode,selWoundId,assessDate,idx]);

  const effLocation = mode === "follow" && selWoundId ? (idx.wounds[selWoundId] || {}).location : location;
  const targetPoint = multiWound && targets.length === 1 ? targets[0] : null;
  const batch = multiWound && targets.length >= 2;
  const previousStage = mode === "follow" && selWoundId
    ? (() => {
        const latest = orderedWoundAssessments(idx,selWoundId,assessDate)[0];
        return latest && latest.stage ? stageLabel(latest.stage) : null;
      })()
    : null;

  useEffect(() => {
    if (!batch) return;
    setBatchSizes((prev) => Array.from({ length: targets.length }, (_, i) => prev[i] || { lengthCm: "", widthCm: "", depthCm: "", location: location || "Sacrum" }));
  }, [batch, targets.length]);

  async function detectRulerScale(source) {
    const prepared = await prepareRulerImage(source, {maxDim:1200, encode:false});
    const pixels = prepared.canvas.getContext("2d", {willReadFrequently:true}).getImageData(0,0,prepared.w,prepared.h).data;
    const detected = detectHospitalRuler(pixels, prepared.w, prepared.h);
    return {scaleVisible: !detected,
      scale: mapScaleToPhoto(detected, prepared.rect, prepared.photoWidth, prepared.photoHeight),
      note: detected ? detected.note : "자의 1mm 눈금 10칸을 확인하지 못했습니다. 사진 속 자의 눈금에 맞춰 두 점을 직접 지정해주세요."};
  }

  async function runRulerProbe(source) {
    const request = ++rulerRequestRef.current;
    setAutoRulerStatus("detecting"); setAutoRulerNote("");
    try {
      const result = await detectRulerScale(source);
      if (request !== rulerRequestRef.current) return;
      setAutoRulerNote(result.note);
      if (result.scale) {
        setMeasureMode("ruler"); setSize(sz => ({...sz, method:"ruler"}));
        setCalibCarry({calib:[result.scale.p1,result.scale.p2],markerCm:String(result.scale.cm)});
        setAutoRulerStatus("candidate");
      } else if (result.scaleVisible) {
        setMeasureMode("ruler"); setAutoRulerStatus("visible");
      } else { setAutoRulerStatus("none"); }
    } catch (e) {
      if (request !== rulerRequestRef.current) return;
      setMeasureMode("ruler"); setAutoRulerStatus("error");
      setAutoRulerNote(e.message || "자 인식 요청 실패");
    }
  }

  const handleFile = async (file) => {
    if (photoLoading) return;
    if (!file) { setPhotoErr("파일이 선택되지 않았습니다. 다시 시도해주세요."); return; }
    const photoRequest = ++photoRequestRef.current;
    rulerRequestRef.current++;
    rulerSourceRef.current = null;
    setCalibCarry(null); setAutoRulerNote(""); setAutoRulerStatus("idle");
    setPhotoErr("");
    if (file.type && !file.type.startsWith("image/")) {
      setPhotoErr("이미지 파일이 아닙니다. 사진 파일(JPG, PNG)을 선택해주세요.");
      return;
    }
    setPhotoLoading(true);
    try {
      await new Promise(resolve=>setTimeout(resolve,30));
      const normalizedFile = await normalizeImageFile(file);
      const p = await fileToResizedDataUrl(normalizedFile);
      if (photoRequest !== photoRequestRef.current) return;
      setPhoto(p);
      setQuality(await checkImageQuality(p.dataUrl));
      if (photoRequest !== photoRequestRef.current) return;
      setPhotoLoading(false);
      setAi(null); setAiStatus("idle"); setAiApplied(false);
      setMultiWound(false); setTargets([]);
      setPrevFinal(null); setQuickMode(false);
      setAiBatch(null); setBatchStatus("idle"); setBatchErr(""); setBatchStages([]); setBatchMemo(""); setBatchSizes([]);
      setMeasureMode("manual");
      try {
        const rulerSource = await fileToResizedDataUrl(normalizedFile, 2400, .95);
        if (photoRequest !== photoRequestRef.current) return;
        rulerSourceRef.current = rulerSource;
        await runRulerProbe(rulerSource);
      } catch (e) {
        if (photoRequest !== photoRequestRef.current) return;
        setMeasureMode("ruler"); setAutoRulerStatus("error"); setAutoRulerNote(e.message || "자 인식용 사진 준비 실패");
      }
    } catch (e) {
      const isHeic = /heic|heif/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
      setPhotoErr(isHeic
        ? "HEIC 형식 사진은 이 브라우저에서 열 수 없습니다. 휴대폰 카메라 설정을 '높은 호환성(JPEG)'으로 바꾸거나, 갤러리에서 JPG로 저장·공유한 뒤 다시 선택해주세요."
        : "사진을 불러오지 못했습니다 (" + (e.message || "알 수 없는 오류") + "). 파일 형식(JPG/PNG)을 확인하고 다시 선택해주세요.");
    } finally { if(photoRequest===photoRequestRef.current) setPhotoLoading(false); }
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

  const runAi = async () => {
    if (!photo || refPhotoLoading) return;
    if (refPhotoError) {setAiErr('이전 사진 읽기 오류입니다. 수동 사정으로 진행하거나 이전 단계에서 다시 시도하세요.');setAiStatus('error');return;}
    aiRequestRef.current?.abort();
    const request = new AbortController(); aiRequestRef.current = request;
    setAi(null); setAiApplied(false);
    setAiStatus("loading"); setAiErr("");
    try {
      const src = multiWound && targetPoint ? await annotateTargets(photo, [targetPoint]) : photo.dataUrl;
      const aiImages = (mode === "follow" && refPhoto) ? [refPhoto, src] : src;
      const r = await analyzeWoundImage(aiImages, {
        location: effLocation,
        lengthCm: size.lengthCm || null, widthCm: size.widthCm || null, depthCm: size.depthCm || null,
        multiTarget: !!(multiWound && targetPoint),
        followUpCompare: mode === "follow" && !!refPhoto,
        previousStage,
      }, {signal:request.signal});
      if (request.signal.aborted || aiRequestRef.current !== request) return;
      setAi(r); setAiStatus("done");
      if (r && r.canAssess !== false && r.blanchingCheckNeeded) setBlanchModal(true);
      else if (r && r.canAssess !== false && r.iadCheckNeeded) {
        setFinal((f) => f.iadCheck ? f : { ...f, iadCheck: { moisture: null, diffuse: null, unclear: null, necrosis: null } });
        setIadModal(true);
      }
    } catch (e) { if(aiRequestRef.current === request){setAiErr(e.message || '오류');setAiStatus('error');} }
    finally {if(aiRequestRef.current === request)aiRequestRef.current=null;}
  };

  const runBatchAi = async () => {
    if (!photo) return;
    aiRequestRef.current?.abort();
    const request = new AbortController(); aiRequestRef.current = request;
    setAiBatch(null); setBatchStatus("loading"); setBatchErr(""); setBatchProg(0);
    try {
      const ws = await runPool(targets, 2, async (pt, i) => {
        const b = batchSizes[i] || {};
        if(request.signal.aborted)throw new Error("분석 취소");
        try {
          const full = await annotateTargets(photo, [pt]);
          const crop = await cropAround(photo, pt);
          const r = await analyzeWoundImage([full, crop], {
            location: b.location || null,
            lengthCm: b.lengthCm || null, widthCm: b.widthCm || null, depthCm: b.depthCm || null,
            multiTarget: true, zoomHint: true,
          }, {signal:request.signal});
          setBatchProg((n) => n + 1);
          return { index: i + 1, ok: true, ...r };
        } catch (e) {
          setBatchProg((n) => n + 1);
          return { index: i + 1, ok: false, error: e.message || "오류" };
        }
      });
      if(request.signal.aborted || aiRequestRef.current !== request)return;
      if (!ws.some((w) => w.ok)) throw new Error(ws[0] && ws[0].error ? ws[0].error : "모든 상처 분석 실패");
      setAiBatch({ wounds: ws });
      setBatchStages(ws.map((w) => mapAiStage(w.ok && w.canAssess !== false ? w.suggestedStage : "미정")));
      setBatchStatus("done");
    } catch (e) {if(aiRequestRef.current === request){setBatchErr(e.message || '오류');setBatchStatus('error');}}
    finally {if(aiRequestRef.current === request)aiRequestRef.current=null;}
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
          size: { lengthCm: L, widthCm: Wd, depthCm: D, undermining: null, tunneling: null, areaCm2: L && Wd ? fmt1(L * Wd) : null, method: "calibrated" },
          braden: bradenTotal(braden) != null ? { scores: braden, total: bradenTotal(braden) } : null,
          clinicalChecks: { depth: !!D, deeperStructure: false, blanching: false, iad: false },
          target: pt, targets: [pt], batch: true, quick: false,
          aiSuggestedStage: w ? mapAiStage(w.suggestedStage) : null,
          clinicianFinalStage: stage,
          ai: aiRec, final: fin,
        };
        nIdx.wounds[wid] = { id: wid, patientId: pid.trim(), location: rec.location, sub: CIRC[i], createdAt: rec.date, assessmentIds: [aid] };
        nIdx.assess[aid] = { draftId: draft.id, id: aid, woundId: wid, date: rec.date, stage, aiStage: rec.aiSuggestedStage, lengthCm: L, widthCm: Wd, areaCm2: rec.size.areaCm2, hasPhoto: true };
        recs.push(rec);
      });
      for (const r of recs) await saveFull(r);
      await saveIndex(nIdx);
      await draft.complete();
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
    const cc = final.clinChecks || {};

    if (final.stage === "IAD") {
      // 사정자가 IAD 감별 후 "IAD 의심"으로 직접 분류한 경우
      // AI가 제안한 Stage(예: Stage 2)가 이를 덮어쓰지 않도록 유지합니다.
      stage = "IAD";
    } else if (stage === "HEALED") {
      // 완전 폐쇄·상피화된 이전 욕창은 Stage 1/2로 역단계화하지 않습니다.
      stage = "HEALED";
    } else if (cc.deep === "yes") {
      stage = "4";
    } else if (final.blanching === "blanch" && ["1", "ND"].includes(stage)) {
      stage = "NONE";
    } else if (
      final.blanching === "nonblanch" &&
      stage === "ND" &&
      ai.blanchingCheckNeeded
    ) {
      stage = "1";
    }

    if (stage === "2" && ["sloughEschar","fat","deep"].some(k=>cc[k]==="yes")) stage="ND";
    setFinal((f) => ({ ...f, stage, ...aiNonStage(f) }));
    setAiApplied(true);
    setStep(5);
  };

  const applyAiExceptStage = () => {
    if (!ai) { setStep(5); return; }

    // 임상 확인에서 심부 구조 노출을 직접 확인했다면 Edit 경로에서도 Stage 4로 반영합니다.
    // 그 외에는 Stage를 직접 선택할 수 있도록 현재 값을 유지합니다.
    const cc = final.clinChecks || {};
    const aiStage = mapAiStage(ai.suggestedStage);
    const clinicalStage = final.stage === "IAD"
      ? "IAD"
      : (aiStage === "HEALED"
        ? "HEALED"
        : (cc.deep === "yes" ? "4" : final.stage));

    setFinal((f) => ({
      ...f,
      stage: clinicalStage,
      ...aiNonStage(f),
    }));
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
        areaCm2, method: size.method,
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
      nIdx.assess[rec.id] = { draftId: draft.id,
        id: rec.id, woundId: rec.woundId, date: rec.date, stage: final.stage, aiStage: rec.aiSuggestedStage,
        lengthCm: rec.size.lengthCm, widthCm: rec.size.widthCm, areaCm2: rec.size.areaCm2,
        hasPhoto: !!photo,
      };
      await saveFull(rec);
      await saveIndex(nIdx);
      await draft.complete();
      if (next) {
        if (onIdxUpdate) onIdxUpdate(nIdx);
        setPrevFinal(JSON.parse(JSON.stringify(final)));
        setSaving(false);
        draft.restart();
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
        <div key={s} className="w-2 h-2 rounded-full" style={{ backgroundColor: s === step ? "#087F83" : s < step ? "#83D4CB" : "#CBD5E1" }} />
      ))}
    </div>
  );

  return (
    <div ref={assessmentTopRef} className="pl-follow-screen pb-6" style={{overflowAnchor:"none"}}>
      <div className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center px-3 py-3 gap-2">
          <button onClick={() => (step > 1 ? setStep(step - 1) : leaveAssessment())} className="p-2 rounded-lg bg-white border border-slate-300">
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="text-base font-bold text-slate-900">{mode === "follow" ? "F/U 사정" : "새 욕창 사정"}</div>
            <div className="text-xs text-slate-500">
              {step === 1 && "1단계 · 환자 정보 및 부위"}
              {step === 2 && "2단계 · 사진 촬영"}
              {step === 3 && "3단계 · 크기 측정"}
              {step === 4 && (batch ? "4단계 · AI 일괄 분석 · 저장" : "4단계 · AI 분석")}
              {step === 5 && "5단계 · 사정 확인·수정"}
              {step === 6 && "6단계 · 요약 및 저장"}
            </div>
          </div>
          <button aria-label="???" onClick={leaveAssessment} className="pl-toolbar-button pl-toolbar-home"><HomeIcon size={21} /></button>
        </div>
        <StepDots />
      </div>
      <DraftStatus status={draft.status}/>
      <AccountCredits compact useBack={usePhoneBack}/>

      {step!==2&&<div className="pl-step-art"><ArtIcon kind={step===2?'camera':step===3?'skin':step===4?'skin':step===6?'records':'braden'} size={62}/><div><strong>{['','사정할 부위를 확인하세요','사진으로 상처를 기록하세요','크기를 측정하세요','분석 내용을 확인하세요','관찰한 상태를 확인하세요','사정 내용을 저장하세요'][step]}</strong><p>사진과 직접 확인한 소견을 함께 기록합니다.</p></div></div>}
      <div className="p-4 space-y-4">
        {/* ---------------- Step 1 ---------------- */}
        {step === 1 && (
          <>
            {savedFlash && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{savedFlash}</div>
            )}
            {existing && patientWounds.length > 0 && (
              <Card>
                {mode==='follow'&&selWoundId&&idx.wounds[selWoundId]?<>
                  <p className="text-xs text-teal-700 bg-teal-50 rounded-xl p-3 mb-3">기존 상처에 이어서 기록합니다.</p>
                  <SectionTitle>현재 연결된 상처</SectionTitle>
                  <div className="flex gap-3 items-center"><div className="w-24 h-24 shrink-0 bg-slate-100 rounded-xl overflow-hidden">{followRecords[selWoundId]?.record?.photo?<img src={followRecords[selWoundId].record.photo.dataUrl} className="w-full h-full object-cover" alt="최근 사정 사진"/>:<span className="text-xs p-2">사진 없음</span>}</div><div>
                    <p className="text-lg font-bold">{idx.wounds[selWoundId].location}{idx.wounds[selWoundId].sub?' · '+idx.wounds[selWoundId].sub:''}</p>
                    <p className="text-xs text-slate-500 mt-1">마지막 사정 {followRecords[selWoundId]?.summary?dateFull(followRecords[selWoundId].summary.date):'기록 없음'}</p>
                    <div className="mt-2"><StageBadge code={followRecords[selWoundId]?.summary?.stage}/> <span className="text-xs">사정 {(idx.wounds[selWoundId].assessmentIds||[]).length}회</span></div>
                  </div></div><button type="button" className="w-full mt-3 rounded-xl border border-teal-600 py-3 text-teal-800 font-bold" onClick={()=>{setDraftWoundId(selWoundId);setShowWoundPicker(true)}}>상처 변경</button>
                </>:<button className="w-full rounded-xl border border-teal-500 p-3 font-bold text-teal-800" onClick={()=>{setDraftWoundId(selWoundId);setShowWoundPicker(true)}}>기존 상처 선택 · F/U 사정</button>}
                {showWoundPicker&&<div className="fixed inset-0 z-[70] bg-slate-900/50 flex items-center justify-center p-4" onClick={()=>setShowWoundPicker(false)}><div className="w-full max-w-md max-h-[85vh] overflow-auto rounded-2xl bg-white p-4" onClick={e=>e.stopPropagation()}><div className="flex justify-between mb-2"><h2 className="font-bold">이어갈 상처 선택</h2><button aria-label="상처 선택 닫기" onClick={()=>setShowWoundPicker(false)}><X size={20}/></button></div><p className="text-xs text-slate-500 mb-3">사진과 최근 사정 정보를 확인하세요.</p><div className="space-y-2">{patientWounds.map((w,i)=><button key={w.id} className={'w-full p-3 border rounded-xl text-left flex gap-3 '+(draftWoundId===w.id?'border-teal-600 bg-teal-50':'border-slate-200')} onClick={()=>setDraftWoundId(w.id)}><div className="w-16 h-20 shrink-0 rounded-lg bg-slate-100 overflow-hidden">{followRecords[w.id]?.record?.photo?<img src={followRecords[w.id].record.photo.dataUrl} alt="상처 사진" className="w-full h-full object-cover"/>:<span className="text-xs">사진 없음</span>}</div><div><p className="font-bold">{w.location}{w.sub?' · '+w.sub:''}</p><p className="text-xs text-slate-500">상처 {i+1} · 시작 {dateShort(w.createdAt)}</p><p className="text-xs mt-1">최근 {followRecords[w.id]?.summary?dateFull(followRecords[w.id].summary.date):'기록 없음'}</p><div className="mt-1"><StageBadge code={followRecords[w.id]?.summary?.stage}/> <span className="text-xs">사정 {(w.assessmentIds||[]).length}회 {draftWoundId===w.id?'· 선택됨':''}</span></div></div></button>)}</div><button disabled={!draftWoundId} className="w-full mt-4 rounded-xl bg-teal-700 text-white py-3 font-bold disabled:opacity-40" onClick={()=>{setMode('follow');setSelWoundId(draftWoundId);setShowWoundPicker(false)}}>이 상처로 변경</button></div></div>}
              </Card>
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
              <SectionTitle>{mode==='follow'?'연결된 환자 ID':'Patient ID'}</SectionTitle>
              <input readOnly={mode==='follow'} value={pid} onChange={(e) => setPid(e.target.value)} placeholder="예: T-0042"
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
              <details><summary className="text-sm font-bold cursor-pointer mb-3">기본 정보 확인</summary>
              <div className="grid grid-cols-2 gap-2">
                <input value={demo.ward} onChange={(e) => setDemo({ ...demo, ward: e.target.value })} placeholder="병동" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
                <input value={demo.room} onChange={(e) => setDemo({ ...demo, room: e.target.value })} placeholder="병실" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
                <select value={demo.sex} onChange={(e) => setDemo({ ...demo, sex: e.target.value })} className="px-3 py-3 rounded-xl border border-slate-300 text-base bg-white">
                  <option value="">성별</option><option value="남">남</option><option value="여">여</option>
                </select>
                <input value={demo.age} onChange={(e) => setDemo({ ...demo, age: e.target.value })} placeholder="연령" type="number" inputMode="numeric" className="px-3 py-3 rounded-xl border border-slate-300 text-base" />
              </div>
            </details>
            </Card>
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
                <span className="text-xs font-semibold" style={{ color: "#087F83" }}>
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
            {mode==='follow'&&<div className="pl-follow-link">{effLocation}에 연결됨 · 기존 상처에 이어서 기록</div>}
            {refPhoto&&<Card><SectionTitle>이전 사정 사진</SectionTitle><p className="text-xs text-slate-500 mb-2">{followRecords[selWoundId]?.summary?dateFull(followRecords[selWoundId].summary.date):''} · {stageLabel(followRecords[selWoundId]?.summary?.stage)}</p><div className="flex items-center gap-4"><img src={refPhoto} alt="이전 사정 사진" className="w-24 h-24 object-cover rounded-xl"/><p className="text-xs text-slate-600">비교 기준으로 자동 연결됩니다.</p></div></Card>}
            {photoLoading ? (<div role="status" aria-live="polite" className="pl-photo-loading"><span className="pl-spinner"/><h3>사진을 불러오고 있어요</h3><p>사진 크기와 품질을 확인하고 있습니다. 잠시만 기다려주세요.</p></div>) : !photo ? (
              <div className="pl-upload-card" onDragOver={e=>e.preventDefault()} onDrop={onDrop}><h3>이번 사정 사진</h3><p>오늘 촬영한 새 사진을 추가하세요.</p><div className="pl-capture-art"><ArtIcon kind="camera" size={118}/></div><div className="grid grid-cols-2 gap-2"><label className="pl-photo-button"><Camera size={16}/>사진 촬영<input type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileInput}/></label><label className="pl-photo-button"><Upload size={16}/>사진 선택<input type="file" accept="image/*" className="hidden" onChange={onFileInput}/></label></div><p className="mt-3">이전 사진과 비슷한 방향·거리로 촬영하세요.</p><details className="mt-2"><summary className="text-xs text-teal-700">촬영·측정 안내</summary><p>상처 전체와 주변 피부를 포함하고, 자는 상처와 같은 평면에 놓으세요. 반사와 그림자를 피하세요.</p></details></div>
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
                  <button onClick={() => { photoRequestRef.current++; rulerRequestRef.current++; rulerSourceRef.current=null; setCalibCarry(null); setAutoRulerNote(""); setAutoRulerStatus("idle"); setPhoto(null); setQuality(null); setPhotoErr(""); }} className="flex-1 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 flex items-center justify-center gap-1"><RefreshCw size={14} /> 다시 선택</button>
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
                {autoRulerStatus === "detecting" ? (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">
                    📏 자 숫자·단위·눈금 확대 인식 중…
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Chip active={measureMode === "manual"} onClick={() => { setMeasureMode("manual"); setSize((sz) => ({ ...sz, method: "manual" })); }}>Manual — 실측값 입력</Chip>
                    <Chip active={measureMode === "ruler"} onClick={() => setMeasureMode("ruler")}>Ruler — 사진 눈금 측정</Chip>
                  </div>
                )}
                {autoRulerStatus !== "detecting" && <div className="mt-3 space-y-2">
                  {autoRulerNote && <p className={"text-xs rounded-lg border p-2 " + (autoRulerStatus === "candidate" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-amber-50 border-amber-200 text-amber-900")}>{autoRulerStatus === "candidate" ? "실제 눈금 후보 · 확인 전: " : autoRulerStatus === "error" ? "자 인식 요청 오류: " : "자 인식 결과: "}{autoRulerNote}</p>}
                  <button type="button" onClick={() => runRulerProbe(rulerSourceRef.current || photo)} className="rounded-xl border border-teal-200 px-3 py-2 text-sm font-semibold text-teal-700">자 눈금 다시 인식</button>
                </div>}
                <p className="text-xs text-slate-500 mt-2">사진에 실제 자가 있으면 자의 연속된 숫자와 눈금을 읽어 실제 간격을 기준으로 pixel→cm 보정을 합니다. 그 보정값으로 상처 크기를 계산하며, 자의 눈금을 확실히 읽지 못하면 두 점을 직접 지정해 보정합니다. 자가 없을 때만 Manual 실측을 사용합니다.</p>
              </Card>
            )}
            {photo && measureMode === "ruler" ? (
              <Card>
                <SectionTitle><span className="flex items-center gap-1.5"><Ruler size={16} /> Ruler 자동 인식 · 측정</span></SectionTitle>
                {autoRulerStatus === "candidate" && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2 mb-2">연속된 눈금 10칸을 찾았습니다. 한 칸이 1mm인지 확인하고, 표시된 두 점이 실제 1cm 간격과 일치하는지 확인해주세요.</p>}
                {autoRulerStatus === "visible" && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-2">자동 기준을 찾지 못했습니다. 사진 속 자의 눈금에 맞춰 두 점을 직접 지정해 보정해주세요.</p>}
                {autoRulerStatus === "error" && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-2">자 인식 요청이 실패했습니다. 위 오류를 확인하고 다시 인식하거나 두 점을 지정해 보정할 수 있습니다.</p>}
                <MeasureTool photo={photo} targets={multiWound ? targets : []} autoRulerStatus={autoRulerStatus}
                  onHumanMeasure={() => {}}
                  initCalib={calibCarry ? calibCarry.calib : null}
                  initMarkerCm={calibCarry ? calibCarry.markerCm : null}
                  onCalib={setCalibCarry}
                  onLive={(r) => {
                    if (r?.calibrationPending) {
                      setSize(prev => prev.method === "calibrated" && (prev.lengthCm || prev.widthCm) ? {...prev,lengthCm:"",widthCm:"",method:"ruler"} : prev);
                      if (batch) setBatchSizes(prev => prev.some(b => b.lengthCm || b.widthCm) ? prev.map(b => ({...b,lengthCm:"",widthCm:""})) : prev);
                      return;
                    }
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
            {!batch ? (
            <SizingPanel size={size} setSize={setSize} areaCm2={areaCm2} onTouched={() => {}} />
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
                  <p className="text-xs mb-3" style={{ color: "#087F83" }}>사진에 상처가 여러 개 — 원으로 표시한 상처만 분석하도록 지시합니다.</p>
                )}
                <PrimaryBtn onClick={runAi}>AI 분석 실행</PrimaryBtn>
                <div className="mt-3"><DisclaimerBox /></div>
              </Card>
            )}
            {aiStatus === "loading" && (
              <Card><GhostBtn onClick={()=>cancelAi(false)}>분석 취소 · 입력 유지</GhostBtn>
                <div className="flex items-center gap-3 py-4">
                  <div className="w-5 h-5 rounded-full border-2 border-slate-300 animate-spin" style={{ borderTopColor: "#087F83" }} />
                  <span className="text-sm text-slate-700">사진을 분석하는 중입니다…</span>
                </div>
              </Card>
            )}
            {aiStatus === "error" && (
              <Card>
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">AI 분석에 실패했습니다({aiErr}). 다시 시도하거나, 수동 사정으로 진행하세요.</div>
                <div className="flex gap-2">
                  <button onClick={runAi} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#087F83" }}>다시 시도</button>
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
                      <button onClick={() => setStep(5)} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#087F83" }}>수동 사정 진행</button>
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
                      <div className="mb-1"><span className="text-xs text-slate-500 mr-2">사진 기반 AI 초기 제안</span><StageBadge code={mapAiStage(ai.suggestedStage)} /></div>
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
                          <div className="text-xs font-bold text-slate-700 mb-1">감별 · 추가 확인</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.differentials.map((d, i) => <p key={i}>· {stageLabel(mapAiStage(d.stage))} — {d.reason}</p>)}
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
                              {sug === "2" && ["sloughEschar","fat","deep"].some(k=>cc[k]==="yes") && <div role="status" className="rounded-xl bg-amber-50 border border-amber-200 p-3 mt-3"><b>임상 확인 반영 · 추가 확인 필요</b><p className="text-xs mt-1">AI 초기 제안 Stage 2와 입력한 소견이 일치하지 않습니다. 다음 화면에서 최종 분류를 직접 선택하세요.</p></div>}{hints.map((h, i) => <p key={i} className="text-xs text-amber-800 mt-1">⚠ {h}</p>)}
                            </>
                          );
                        })()}
                      </div>
                    </Card>
                    <DisclaimerBox />
                    <div className="space-y-2">
                      <button onClick={applyAi} className="w-full py-3 rounded-xl text-white text-sm font-semibold" style={{ backgroundColor: "#087F83" }}>입력한 임상 소견을 반영하여 계속</button>
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
              <Card><GhostBtn onClick={()=>cancelAi(true)}>일괄 분석 취소 · 입력 유지</GhostBtn>
                <div className="flex items-center gap-3 py-4">
                  <div className="w-5 h-5 rounded-full border-2 border-slate-300 animate-spin" style={{ borderTopColor: "#087F83" }} />
                  <span className="text-sm text-slate-700">상처를 하나씩 개별 분석 중… {batchProg}/{targets.length} 완료</span>
                </div>
                <p className="text-xs text-slate-500">정확도를 위해 상처마다 확대 이미지로 별도 분석합니다. 상처 수에 비례해 시간이 걸립니다.</p>
              </Card>
            )}
            {batchStatus === "error" && (
              <Card>
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-3">AI 일괄 분석에 실패했습니다({batchErr}). 다시 시도하거나 단계를 직접 선택하세요.</div>
                <div className="flex gap-2">
                  <button onClick={runBatchAi} className="flex-1 py-2.5 rounded-lg text-white text-sm font-semibold" style={{ backgroundColor: "#087F83" }}>다시 시도</button>
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
                    <div className="rounded-xl border p-3" style={{ backgroundColor: "#E7F5F2", borderColor: "#83D4CB" }}>
                      <div className="text-sm font-bold flex items-center gap-2 flex-wrap" style={{ color: "#17666A" }}>모든 상처가 동일 단계로 보입니다 <StageBadge code={mapAiStage(ws[0].suggestedStage)} /></div>
                      <p className="text-xs mt-1" style={{ color: "#17666A" }}>아래에서 확인하고 한 번에 저장하세요. 판단이 다른 상처만 해당 단계를 바꾸면 됩니다.</p>
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
              <div className="rounded-xl border p-3 text-xs leading-relaxed" style={{ backgroundColor: "#E7F5F2", borderColor: "#83D4CB", color: "#17666A" }}>
                AI 제안이 반영되어 있습니다. 모든 항목을 직접 확인하고 필요 시 수정하세요. 최종 판단은 사정자의 책임입니다.
              </div>
            )}
            <Card>
              <SectionTitle>현재 상태 / Stage (최종 선택)</SectionTitle>
              {final.stage === "HEALED" && (
                <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                  <b>치유됨</b>은 Stage가 아닙니다. 완전히 닫히고 상피화된 이전 욕창의 현재 상태를 기록합니다.
                  {previousStage && <div className="mt-1">이전 사정: <b>{previousStage}</b> · 치유 과정에서 Stage를 낮춰 기록하지 않습니다.</div>}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {STAGES.map((s) => {
                  const aiSug = ai && ai.canAssess !== false && mapAiStage(ai.suggestedStage) === s.code;
                  return (
                    <button key={s.code} onClick={() => setFinal({ ...final, stage: s.code })}
                      className={"text-left px-3 py-2.5 rounded-xl border " + (final.stage === s.code ? "" : "border-slate-300 bg-white")}
                      style={final.stage === s.code ? { backgroundColor: "#E7F5F2", borderColor: "#087F83", borderWidth: 1, borderStyle: "solid" } : {}}>
                      <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">{s.label}
                        {final.stage === s.code && <span className="text-xs text-teal-700">최종 선택</span>}{aiSug && <span className="text-white rounded px-1 py-0.5 font-bold" style={{ backgroundColor: "#087F83", fontSize: 9 }}>AI 초기 제안</span>}
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
            <ClinicalStageGuide final={final} setFinal={setFinal} />
            {ai && ai.canAssess !== false && final.stage !== "ND" && mapAiStage(ai.suggestedStage) !== final.stage && (
              <Card>
                <SectionTitle>Override reason — AI 제안과 다른 단계 선택</SectionTitle>
                <div className="space-y-1.5">
                  {OVERRIDE_REASONS.map(([code, label]) => (
                    <button key={code} onClick={() => setFinal({ ...final, overrideReason: { code, text: (final.overrideReason && final.overrideReason.text) || "" } })}
                      className={"w-full text-left px-3 py-2.5 rounded-xl border text-sm " + (final.overrideReason && final.overrideReason.code === code ? "" : "border-slate-300 bg-white text-slate-700")}
                      style={final.overrideReason && final.overrideReason.code === code ? { backgroundColor: "#E7F5F2", borderColor: "#087F83", borderWidth: 1, borderStyle: "solid" } : {}}>
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
              <SectionTitle>상처 바닥 조직 · Wound bed (복수 선택)</SectionTitle>
              <div className="grid grid-cols-3 gap-2">
                {WB_KEYS.map((w) => (
                  <BilingualChip key={w.k} active={final.woundBed.types.includes(w.k)} onClick={() => toggleWb(w.k)}><BilingualLabel code={w.en} korean={w.l}/></BilingualChip>
                ))}
              </div>
              {final.woundBed.types.length > 1 && (
                <>
                  <div className="text-xs text-slate-500 mt-3 mb-1">주된 조직 · Predominant</div>
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
              <TermGuide/><p className="text-xs text-slate-500 mt-2">정확한 비율(%) 대신 존재하는 조직과 주된 조직만 기록합니다.</p>
                          <div className="mt-3">
                <div className="text-xs font-bold text-slate-700 mb-1">상처 가장자리 · 상피화</div>
                <div className="flex flex-wrap gap-2">
                  <Chip active={final.edge === "present"} onClick={() => setFinal({ ...final, edge: final.edge === "present" ? null : "present" })}>상피화 있음</Chip>
                  <Chip active={final.edge === "absent"} onClick={() => setFinal({ ...final, edge: final.edge === "absent" ? null : "absent" })}>상피화 없음</Chip>
                  <Chip active={final.edge == null} onClick={() => setFinal({ ...final, edge: null })}>판단 불가</Chip>
                </div>
              </div>
            </Card>
            <Card>
              <SectionTitle>삼출물 · Exudate</SectionTitle>
              <div className="text-xs text-slate-500 mb-1">양</div>
              <div className="flex flex-wrap gap-2 mb-3">
                <Chip active={final.exudateAmount == null || final.exudateAmount === ""} onClick={() => setFinal({ ...final, exudateAmount: null })}>미입력</Chip>
                {EXU_AMT.map((a) => <BilingualChip key={a} active={final.exudateAmount === a} onClick={() => setFinal({ ...final, exudateAmount: a })}><BilingualLabel code={a} korean={a==='Moderate'?'중간량':null}/></BilingualChip>)}
              </div>
              <div className="text-xs text-slate-500 mb-1">양상</div>
              <div className="grid grid-cols-2 gap-2">
                {EXU_TYPE.map((t) => <BilingualChip key={t} active={final.exudateType === t} onClick={() => setFinal({ ...final, exudateType: final.exudateType === t ? null : t })}><BilingualLabel code={t}/></BilingualChip>)}
              </div>
            </Card>
            <Card>
              <SectionTitle>상처 주변 피부 · Periwound</SectionTitle><TermGuide/>
              <div className="grid grid-cols-3 gap-2">
                {PERIWOUND.map((p) => (
                  <BilingualChip key={p} active={final.periwound.includes(p)}
                    onClick={() => setFinal({ ...final, periwound: final.periwound.includes(p) ? final.periwound.filter((x) => x !== p) : [...final.periwound, p] })}>
                    <BilingualLabel code={p}/>
                  </BilingualChip>
                ))}
              </div>
            </Card>
            <Card>
              <SectionTitle>감염 관련 소견 (간호사 직접 평가)</SectionTitle>
              <div className="text-xs text-slate-500 mb-1">냄새 · Odor</div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {ODOR.map((o) => <BilingualChip key={o} active={final.infection.odor === o} onClick={() => setFinal({ ...final, infection: { ...final.infection, odor: o } })}><BilingualLabel code={o}/></BilingualChip>)}
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
            <div id="pl-result-summary" className="pl-result-anchor" />
            <Card>
              <ResultHeadline final={final} photo={photo} size={size} areaCm2={areaCm2} ai={ai} patientId={pid.trim()} location={effLocation + (locationSub.trim() ? ` (${locationSub.trim()})` : "")} date={assessDate} />
              <ResultSectionLinks onDetails={() => setShowDetail(true)} />
              <div className="mb-2"><PhotoQualityLine pq={ai ? ai.photoQuality : null} /></div>
              {photo && (<details className="pl-full-photo"><summary>사진 전체 보기</summary>
                <div className="relative rounded-xl overflow-hidden border border-slate-200 mb-3">
                  <img src={photo.dataUrl} alt="wound" className="w-full block" />
                  {multiWound && <TargetRings points={targets} />}
                </div>
              </details>)}
              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <span className="text-slate-500">Length</span><span className="font-semibold text-right">{size.lengthCm ? `${size.lengthCm} cm` : "—"}</span>
                <span className="text-slate-500">Width</span><span className="font-semibold text-right">{size.widthCm ? `${size.widthCm} cm` : "—"}</span>
                <span className="text-slate-500">깊이</span><span className="font-semibold text-right">{size.depthCm ? `${size.depthCm} cm` : "—"}</span>
                <span className="text-slate-500">근사 면적</span><span className="font-semibold text-right">{areaCm2 != null ? `${areaCm2} cm²` : "—"}</span>
                {final.blanching ? (<><span className="text-slate-500">압박 시 색 변화</span><span className="font-semibold text-right">{final.blanching === "blanch" ? "하얗게 변함" : "변하지 않음"}</span></>) : null}
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
            <div id="pl-result-care" className="pl-result-anchor" />
            <NursingCarePlan final={final} location={effLocation} size={size}/>
            <div id="pl-result-dressing" className="pl-result-anchor" />
            <DressingConsiderationCard final={final} depthCm={size.depthCm} location={effLocation} />
            <div id="pl-result-detail" className="pl-result-anchor" />
            <button onClick={() => setShowDetail(!showDetail)}
              className="w-full py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">
              상세 근거·소견 {showDetail ? "접기 ▲" : "보기 ▼"}
            </button>
            {showDetail && (
              <>
                <Card>
                  <SectionTitle>상세 소견</SectionTitle>
                  <div className="grid grid-cols-2 gap-y-2 text-sm">
                    <span className="text-slate-500">상처 바닥</span><span className="font-semibold text-right">{woundBedText(final.woundBed)}</span>
                    <span className="text-slate-500">삼출물</span><span className="font-semibold text-right">{exudateText(final)}</span>
                    <span className="text-slate-500">주변 피부</span><span className="font-semibold text-right">{final.periwound.map(v => TERM_LABELS[v] || v).join(", ") || "—"}</span>
                    <span className="text-slate-500">상처 가장자리</span><span className="font-semibold text-right">{final.edge === "present" ? "상피화 있음" : final.edge === "absent" ? "상피화 없음" : "판단 불가"}</span>
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
                          <div className="text-xs font-bold text-slate-700 mb-1">감별 · 추가 확인</div>
                          <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                            {ai.differentials.map((d, i) => <p key={i}>· {stageLabel(mapAiStage(d.stage))} — {d.reason}</p>)}
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
              <div className="rounded-xl border border-slate-300 bg-slate-100 p-3 text-sm font-semibold text-slate-800 mb-3">
                <div>{iadVerdict}</div>
                {iadVerdict.startsWith("IAD") && (
                  <button
                    onClick={() => { setFinal((f) => ({ ...f, stage: "IAD" })); setIadModal(false); }}
                    className="mt-2 w-full py-2.5 rounded-lg text-white text-sm font-semibold"
                    style={{ backgroundColor: "#087F83" }}
                  >IAD 우세 → 최종 판단에 반영</button>
                )}
              </div>
            )}
            <div className="space-y-2">
              <button onClick={() => { setFinal((f) => ({ ...f, stage: "IAD" })); setIadModal(false); }}
                className="w-full py-3 rounded-xl text-white text-sm font-semibold" style={{ backgroundColor: "#087F83" }}>IAD 의심으로 분류</button>
              <button onClick={() => setIadModal(false)}
                className="w-full py-3 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-700">욕창으로 계속 사정</button>
            </div>
          </div>
        </div>
      )}

      {/* 단계별 다음 버튼 — 화면 하단 고정 대신 콘텐츠 바로 아래에 배치 */}
      <div className="mt-4 px-4 pb-6">
        {step === 1 && <PrimaryBtn onClick={() => setStep(2)} disabled={!canNext1}>다음 · 새 사진 촬영</PrimaryBtn>}
        {step === 2 && (photo
          ? <PrimaryBtn onClick={() => setStep(3)} disabled={multiWound && targets.length === 0}>
              {multiWound && targets.length === 0 ? "사정할 상처를 사진에서 탭하세요" : batch ? `이 사진 사용 · 다음 (상처 ${targets.length}개)` : "이 사진 사용 · 다음"}
            </PrimaryBtn>
          : <GhostBtn onClick={() => setStep(3)}>사진 없이 진행</GhostBtn>
        )}

        {step === 3 && (
          <PrimaryBtn disabled={refPhotoLoading} onClick={() => setStep(4)}>다음 · AI 분석</PrimaryBtn>
        )}

        {refPhotoError && <p role="alert" className="text-sm text-red-700">{refPhotoError} 이전 사진 기반 비교를 사용할 수 없습니다. 수동 사정은 계속할 수 있습니다.</p>}
        {step === 4 && !batch && aiStatus !== "loading" && aiStatus !== "done" && !photo && (
          <PrimaryBtn onClick={() => setStep(5)}>다음 · 사정 입력</PrimaryBtn>
        )}
        {step === 4 && !batch && aiStatus === "idle" && photo && (
          <GhostBtn onClick={() => setStep(5)}>AI 없이 진행</GhostBtn>
        )}
        {step === 4 && batch && (batchStatus === "done" || batchStatus === "manual") && (
          <PrimaryBtn onClick={saveBatch} disabled={saving}>
            {saving ? "저장 중…" : `상처 ${targets.length}개 일괄 저장`}
          </PrimaryBtn>
        )}
        {step === 5 && <PrimaryBtn onClick={() => setStep(6)}>다음 · 요약 확인</PrimaryBtn>}
        {step === 6 && (
          <div className="space-y-2">
            {multiWound && photo && (
              <button
                onClick={() => save(true)}
                disabled={saving}
                className="w-full py-2.5 rounded-xl border bg-white text-sm font-semibold disabled:opacity-40"
                style={{ borderColor: "#087F83", color: "#087F83" }}
              >
                {saving ? "저장 중…" : "저장 후 같은 사진으로 다음 상처 사정"}
              </button>
            )}
            <PrimaryBtn onClick={() => save(false)} disabled={saving}>
              {saving ? "저장 중…" : "결과 저장 · 완료"}
            </PrimaryBtn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 사정 상세 모달                                                       */
/* ------------------------------------------------------------------ */
function WoundCareChecklist({ aid }) {
  const [checked, setChecked] = useState({});

  useEffect(() => {
    (async () => {
      const r = await loadFull(aid);
      setChecked(r?.careChecklist || {});
    })();
  }, [aid]);

  const items = [
    ["location", "욕창 위치 확인"],
    ["stage", "욕창 단계 확인"],
    ["size", "크기 확인"],
    ["status", "욕창 상태 확인"],
    ["exudate", "삼출물 유무 확인"],
    ["treatment", "드레싱 또는 외과적 중재 필요 여부 확인"],
    ["doctor", "담당의에게 보고"],
    ["wocn", "필요 시 WOCN 포함 해당과 협진 의뢰"],
  ];

const [saveMsg, setSaveMsg] = useState("");

const saveChecklist = async () => {
  const r = await loadFull(aid);

  if (!r) {
    setSaveMsg("저장할 기록을 찾지 못했습니다.");
    return;
  }

  r.careChecklist = checked;
  await saveFull(r);

  setSaveMsg("✓ 체크리스트가 저장되었습니다.");
  setTimeout(() => setSaveMsg(""), 2500);
};
  const toggle = async (key, value) => {
    const next = { ...checked, [key]: value };
    setChecked(next);

    const r = await loadFull(aid);
    if (r) {
      r.careChecklist = next;
      await saveFull(r);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="font-bold text-slate-900 mb-1">
        📋 욕창 간호 체크리스트
      </div>

      <div className="text-xs text-slate-500 mb-3">
        욕창 발생 후 필요한 사정 및 보고 항목을 확인하세요.

      </div>
<div className="flex items-center gap-2 mb-3">
  <button
    type="button"
    onClick={saveChecklist}
    className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white"
  >
    체크리스트 저장
  </button>

  {saveMsg && (
    <span className="text-xs font-semibold text-green-600">
      {saveMsg}
    </span>
  )}
</div>

      <div className="space-y-2">
        {items.map(([key, label]) => (
          <label
            key={key}
            className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5"
          >
            <input
              type="checkbox"
              checked={!!checked[key]}
              onChange={(e) => toggle(key, e.target.checked)}
              className="h-5 w-5"
            />

            <span
              className={
                checked[key]
                  ? "text-sm text-slate-400 line-through"
                  : "text-sm text-slate-700"
              }
            >
              {label}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}function RecordEditor({record,onCancel,onSaved}) {
 const [draft,setDraft]=useState(()=>JSON.parse(JSON.stringify(record)));
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const final={...emptyFinal(),...draft.final};
 const setFinal=update=>setDraft(d=>({...d,final:typeof update==='function'?update({...emptyFinal(),...d.final}):update}));
 const save=async()=>{setBusy(true);setError('');try{
  const size={...draft.size};for(const key of ['lengthCm','widthCm','depthCm']){if(size[key]===''||size[key]==null)size[key]=null;else{size[key]=Number(size[key]);if(!Number.isFinite(size[key])||size[key]<0)throw new Error('측정값은 0 이상의 숫자로 입력해주세요.');}}
  if((size.lengthCm==null)!==(size.widthCm==null))throw new Error('길이와 너비를 함께 입력해주세요.');
  size.areaCm2=size.lengthCm!=null&&size.widthCm!=null?Math.round(size.lengthCm*size.widthCm*10)/10:null;
  const next={...draft,size,updatedAt:new Date().toISOString(),revisions:[...(record.revisions||[]),{updatedAt:record.updatedAt||record.date,final:record.final,size:record.size,photo:record.photo}]};
  const idx=await loadIndex();if(!idx.assess[next.id])throw new Error('기록 목록을 다시 불러온 뒤 수정해주세요.');
  const previous=idx.assess[next.id];idx.assess[next.id]={...previous,stage:next.final.stage,lengthCm:size.lengthCm,widthCm:size.widthCm,areaCm2:size.areaCm2,hasPhoto:!!next.photo,updatedAt:next.updatedAt};
  await saveFull(next);try{await saveIndex(idx);}catch(e){await saveFull(record);throw e;}
  onSaved(next);
 }catch(e){setError(e.message||'저장에 실패했습니다.');}finally{setBusy(false);}};
 const photo=async file=>{if(!file||busy)return;setBusy(true);setError('');try{const photo=await fileToResizedDataUrl(await normalizeImageFile(file));setDraft(d=>({...d,photo,photoChanged:true}));}catch(e){setError('사진을 불러오지 못했습니다.');}finally{setBusy(false);}};
 const choices=(key,values)=> <div className="my-3"><p className="font-bold text-sm mb-2">{({exudateAmount:'삼출물 양',exudateType:'삼출물 양상',edge:'상피화'})[key]}</p><select className="w-full border rounded-xl p-3" value={final[key]||''} onChange={e=>setFinal({...final,[key]:e.target.value||null})}><option value="">미입력</option>{values.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>;
 return <Card><SectionTitle>기록 수정</SectionTitle><p className="text-xs text-slate-500 mb-3">사정 날짜와 AI 초기 분석은 유지됩니다. 사진 변경 시 기존 AI 분석은 변경 전 사진의 결과입니다.</p>
 <label className="pl-edit-record">{busy?'처리 중…':'사진 변경'}<input type="file" accept="image/*" disabled={busy} className="hidden" onChange={e=>photo(e.target.files?.[0])}/></label>
 <div className="grid grid-cols-3 gap-2 my-3">{[['lengthCm','길이'],['widthCm','너비'],['depthCm','깊이']].map(([k,l])=><label key={k} className="text-xs">{l} (cm)<input type="number" min="0" step="any" className="w-full border rounded-lg p-2 mt-1" value={draft.size?.[k]??''} onChange={e=>setDraft(d=>({...d,size:{...d.size,[k]:e.target.value}}))}/></label>)}</div>
 <p className="font-bold text-sm">최종 분류</p><div className="grid grid-cols-2 gap-2 my-2">{STAGES.map(t=><button key={t.code} className="border rounded-xl p-2 text-sm" style={{background:final.stage===t.code?'#d7f3ef':'white'}} onClick={()=>setFinal({...final,stage:t.code})}>{t.label}{final.stage===t.code?' ✓':''}</button>)}</div>
 <ClinicalStageGuide final={final} setFinal={setFinal}/>
 <p className="font-bold text-sm mt-3">상처 바닥 · 복수 선택</p><div className="flex flex-wrap gap-2 my-2">{['granulation','slough','eschar','necrotic','dermis','other'].map(v=><button key={v} className="border rounded-xl p-2 text-sm" onClick={()=>{const types=final.woundBed?.types||[];const next=types.includes(v)?types.filter(x=>x!==v):[...types,v];setFinal({...final,woundBed:{types:next,predominant:next.includes(final.woundBed?.predominant)?final.woundBed.predominant:null}})}}>{(final.woundBed?.types||[]).includes(v)?'✓ ':''}{TERM_LABELS[v]||v}</button>)}</div>
 <label className="text-sm">주된 조직<select className="w-full border rounded-xl p-2" value={final.woundBed?.predominant||''} onChange={e=>setFinal({...final,woundBed:{...final.woundBed,predominant:e.target.value||null}})}><option value="">미입력</option>{(final.woundBed?.types||[]).map(v=><option key={v} value={v}>{TERM_LABELS[v]||v}</option>)}</select></label>
 {choices('exudateAmount',[['None','없음'],['Scant','극소량'],['Small','소량'],['Moderate','중간'],['Large','많음']])}{choices('exudateType',[['Serous','장액성'],['Serosanguineous','장액혈성'],['Sanguineous','혈성'],['Purulent','화농성']])}{choices('edge',[['present','상피화 있음'],['absent','상피화 없음']])}
 <p className="font-bold text-sm">주변 피부</p><div className="flex flex-wrap gap-2 my-2">{PERIWOUND.map(v=><button className="border rounded-xl p-2 text-sm" key={v} onClick={()=>setFinal({...final,periwound:final.periwound.includes(v)?final.periwound.filter(x=>x!==v):[...final.periwound,v]})}>{final.periwound.includes(v)?'✓ ':''}{TERM_LABELS[v]||v}</button>)}</div>
 <label className="text-sm">메모<textarea className="w-full border rounded-xl p-3" value={final.memo||''} onChange={e=>setFinal({...final,memo:e.target.value})}/></label>
 {error&&<p role="alert" className="text-red-700 text-sm">{error}</p>}<div className="flex gap-2 mt-3"><button disabled={busy} onClick={onCancel} className="border rounded-xl p-3">취소</button><button disabled={busy} onClick={save} className="pl-edit-record">{busy?'저장 중…':'수정 내용 저장'}</button></div></Card>;
}

function AssessmentDetail({ aid, onClose, onUpdated }) {
 const [editing,setEditing]=useState(false);
 usePhoneBack(true,()=>editing?setEditing(false):onClose(),100);
  const [rec, setRec] = useState(undefined);
  useEffect(() => { (async () => setRec(await loadFull(aid)))(); }, [aid]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: "rgba(15,23,42,0.6)" }} onClick={onClose}>
      <div className="bg-slate-50 w-full rounded-t-2xl overflow-y-auto" style={{ maxWidth: 480, maxHeight: "90dvh" }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div className="text-base font-bold text-slate-900">사정 결과</div>
          <button aria-label="사정 결과 닫기" onClick={onClose} className="p-2 rounded-lg bg-white border border-slate-300"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3 pb-8">

          {rec === undefined && <p className="text-sm text-slate-500">불러오는 중…</p>}
          {rec === null && <p className="text-sm text-red-600">기록을 불러오지 못했습니다.</p>}
          {rec && (
            <>
              {editing ? <RecordEditor record={rec} onCancel={()=>setEditing(false)} onSaved={r=>{setRec(r);setEditing(false);onUpdated?.();}}/> : <button className="pl-edit-record" onClick={()=>setEditing(true)}>기록 수정</button>}
              {rec.updatedAt && <p className="text-xs text-slate-500">마지막 수정 · {dateFull(rec.updatedAt)}</p>}
              <div className="pl-final-classification" style={{"--stage-bg":(STAGE_COLORS[rec.final.stage]||STAGE_COLORS.ND)[0],"--stage-ink":(STAGE_COLORS[rec.final.stage]||STAGE_COLORS.ND)[1]}}>
                <p className="text-xs text-teal-700 mb-2">저장된 최종 분류</p>
                <h2 className="text-4xl font-bold text-teal-800">{stageLabel(rec.final.stage)}</h2>
                {rec.final.stage === 'DTPI' && <p className="font-semibold mt-2">심부조직 압박손상</p>}
                <p className="text-xs text-slate-500 mt-2">사정 당시 저장한 최종 결과</p>
              </div>
              <Card>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-bold text-slate-900">{rec.location}</div>
                    <div className="text-xs text-slate-500">{rec.patientId} · {dateFull(rec.date)}</div>
                  </div>
                  <StageBadge code={rec.final.stage} />
                </div><h3 className="font-bold text-slate-900 mb-3">상처 사진</h3>
                {rec.photo && (
                  <div className="relative rounded-xl overflow-hidden border border-slate-200">
                    <img src={rec.photo.dataUrl} alt="wound" className="w-full block" />
                    <TargetRings points={rec.targets || (rec.target ? [rec.target] : [])} />
                  </div>
                )}
              </Card>
              <Card><SectionTitle>측정값</SectionTitle><div className="pl-saved-metrics"><div><span>길이 × 너비</span><strong>{rec.size.lengthCm!=null&&rec.size.widthCm!=null?rec.size.lengthCm+' × '+rec.size.widthCm+' cm':'미측정'}</strong></div><div><span>근사 면적</span><strong>{rec.size.areaCm2!=null?rec.size.areaCm2+' cm²':'미측정'}</strong></div><div><span>깊이</span><strong>{rec.size.depthCm!=null&&rec.size.depthCm!==''?rec.size.depthCm+' cm':'미측정'}</strong></div></div><p className="text-xs text-slate-500 mt-3">면적은 길이 × 너비 기준입니다.</p></Card>
              <SavedWoundFindings record={rec}/>
              <ClinicalChecksSummary final={rec.final}/>
              <NursingCarePlan final={rec.final} location={rec.location} size={rec.size||{}}/>

              <details open className="pl-final-criteria rounded-2xl bg-white border p-4"><summary className="font-semibold cursor-pointer">최종 분류 기준 · {stageLabel(rec.final.stage)}</summary><StageCriteria code={rec.final.stage} /></details>
              {rec.ai && rec.ai.canAssess !== false && (
                <Card>
                  <details className="pl-initial-ai"><summary className="font-semibold cursor-pointer mb-3">AI 초기 제안 · 판단 이유</summary>{rec.photoChanged && <p className="text-xs text-amber-800 mb-3">사진이 수정되었습니다. 아래 AI 분석은 수정 전 사진의 결과입니다.</p>}
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
                      <div className="text-xs font-bold text-slate-700 mb-1">감별 · 추가 확인</div>
                      <div className="text-xs text-slate-700 leading-relaxed space-y-0.5">
                        {rec.ai.differentials.map((d, i) => <p key={i}>· {stageLabel(mapAiStage(d.stage))} — {d.reason}</p>)}
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

                </details></Card>
              )}
              <details className="rounded-2xl bg-white border border-slate-200 p-4"><summary className="font-bold text-slate-700">간호 체크리스트 · 선택</summary><WoundCareChecklist aid={aid} /></details>
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
function validArea(value){return value!==null && value!==undefined && value!=='' && Number.isFinite(Number(value)) && Number(value)>=0;}
function areaChange(a,b){return validArea(a)&&validArea(b)&&Number(a)>0 ? Math.round((Number(b)-Number(a))/Number(a)*1000)/10 : null;}
function CompareView({idx,woundId,onClose}) {
 const list=orderedWoundAssessments(idx,woundId).slice().reverse();
 const [selA,setSelA]=useState(list[0]?.id || '');
 const [selB,setSelB]=useState(list.at(-1)?.id || '');
 const [records,setRecords]=useState({});const [loading,setLoading]=useState(true);
 const [zoom,setZoom]=useState(null);const [pick,setPick]=useState('A');
 usePhoneBack(true,()=>zoom?setZoom(null):onClose(),150);
 useEffect(()=>{let active=true;setLoading(true);Promise.all(list.map(async a=>[a.id,await loadFull(a.id)])).then(rows=>{if(active){setRecords(Object.fromEntries(rows));setLoading(false)}});return()=>{active=false}},[idx,woundId]);
 const sumA=idx.assess[selA],sumB=idx.assess[selB],recA=records[selA],recB=records[selB];
 const delta=areaChange(sumA?.stage==='HEALED'?null:sumA?.areaCm2,sumB?.stage==='HEALED'?null:sumB?.areaCm2);
 const choose=(a,b)=>{setSelA(a);setSelB(b)};
 const choosePoint=id=>{if(pick==='A'){setSelA(id);setPick('B')}else{setSelB(id);setPick('A')}};
 const text=(rec,field)=> !rec ? '불러오기 실패' : field==='bed'?woundBedText(rec.final?.woundBed):field==='exu'?exudateText(rec.final): (rec.final?.periwound||[]).map(v=>TERM_LABELS[v]||v).join(', ')||'미입력';
 const col=(sum,rec,label)=><div className="min-w-0"><p className="text-xs font-bold mb-2">{label} · {sum?dateFull(sum.date):'—'}</p><button className="w-full aspect-square rounded-xl border overflow-hidden bg-slate-100" disabled={!rec?.photo} onClick={()=>setZoom(rec.photo.dataUrl)}>{rec?.photo?<img src={rec.photo.dataUrl} alt={label+' 사진'} className="w-full h-full object-contain"/>:<span className="text-xs text-slate-500">{loading?'불러오는 중':rec?'사진 없음':'불러오기 실패'}</span>}</button><p className="text-xs mt-1 text-teal-700">사진을 누르면 확대</p><div className="mt-2"><StageBadge code={sum?.stage}/></div></div>;
 return <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60" onClick={onClose}><div className="w-full bg-slate-50 rounded-t-2xl overflow-y-auto" style={{maxWidth:480,maxHeight:'90vh'}} onClick={e=>e.stopPropagation()}><header className="sticky top-0 z-10 bg-white border-b p-4 flex justify-between items-center"><h2 className="font-bold">사정 비교</h2><button aria-label="닫기" onClick={onClose}><X size={20}/></button></header><div className="p-4 space-y-3">
 <div className="flex gap-2 flex-wrap"> <Chip active={selA===list[0]?.id&&selB===list.at(-1)?.id} onClick={()=>choose(list[0]?.id,list.at(-1)?.id)}>처음 ↔ 최신</Chip><Chip active={selA===list.at(-2)?.id&&selB===list.at(-1)?.id} onClick={()=>choose(list.at(-2)?.id||list[0]?.id,list.at(-1)?.id)}>직전 ↔ 최신</Chip><Chip active={pick==='A'} onClick={()=>setPick('A')}>이전 직접 선택</Chip><Chip active={pick==='B'} onClick={()=>setPick('B')}>최근 직접 선택</Chip></div>
 <Card><SectionTitle>전체 기록 흐름 · {list.length}회</SectionTitle><p className="text-xs text-slate-500 mb-2">작은 사진을 누르면 {pick==='A'?'이전':'최근'} 비교 기록으로 선택됩니다.</p><div className="flex gap-2 overflow-x-auto pb-2">{list.map(a=><button key={a.id} onClick={()=>choosePoint(a.id)} className={'shrink-0 w-24 p-2 rounded-xl border '+(selA===a.id||selB===a.id?'border-teal-500 bg-teal-50':'bg-white border-slate-200')}><div className="h-16 bg-slate-100 rounded overflow-hidden">{records[a.id]?.photo?<img src={records[a.id].photo.dataUrl} className="w-full h-full object-contain" alt="기록 사진"/>:<span className="text-xs">{loading?'불러오는 중':'사진 없음'}</span>}</div><p className="text-[10px] mt-1">{dateFull(a.date)}</p><p className="text-xs font-semibold">{a.stage==='HEALED'?'치유됨':validArea(a.areaCm2)?a.areaCm2+' cm²':'미입력'}</p><p className="text-xs text-teal-700">{selA===a.id?'이전 ':''}{selB===a.id?'최근':''}</p></button>)}</div></Card>
 <div className="grid grid-cols-2 gap-2">{[['이전',selA,setSelA],['최근',selB,setSelB]].map(([label,value,set])=><label key={label} className="text-xs">{label}<select className="w-full border rounded-xl p-2 bg-white mt-1 text-xs" value={value} onChange={e=>set(e.target.value)}>{list.map(a=><option key={a.id} value={a.id}>{dateFull(a.date)}</option>)}</select></label>)}</div>
 {selA===selB&&<p className="text-sm text-amber-700">같은 기록을 선택했습니다. 다른 두 기록을 골라주세요.</p>}
 {sumA&&sumB&&<Card><SectionTitle>기록된 면적 변화</SectionTitle><p className="text-2xl font-bold">{sumA.stage!=='HEALED'&&validArea(sumA.areaCm2)?sumA.areaCm2:'—'} → {sumB.stage!=='HEALED'&&validArea(sumB.areaCm2)?sumB.areaCm2:'—'} cm²</p>{delta!==null&&selA!==selB&&<p className="text-teal-700 font-bold mt-2">{Math.abs(delta)}% {delta<0?'감소':delta>0?'증가':'변화 없음'}</p>}<p className="text-xs mt-2">길이 {sumA.lengthCm??'미입력'} → {sumB.lengthCm??'미입력'} cm · 너비 {sumA.widthCm??'미입력'} → {sumB.widthCm??'미입력'} cm</p><p className="text-xs text-slate-500 mt-2">길이 × 너비 근사 면적입니다. 면적 감소만으로 호전·치유를 확정하지 않습니다.</p></Card>}
 <Card><SectionTitle>사진 비교</SectionTitle><div className="grid grid-cols-2 gap-3">{col(sumA,recA,'이전')}{col(sumB,recB,'최근')}</div><p className="text-xs text-slate-500 mt-3">사진 확대율과 촬영 조건은 다를 수 있습니다.</p></Card>
 <Card><SectionTitle>사정 내용 비교</SectionTitle><table className="w-full text-xs table-fixed"><thead><tr><th className="p-2 text-left">항목</th><th>이전</th><th>최근</th></tr></thead><tbody>{[['최종 분류',stageLabel(sumA?.stage),stageLabel(sumB?.stage)],['상처 바닥',text(recA,'bed'),text(recB,'bed')],['삼출물',text(recA,'exu'),text(recB,'exu')],['주변 피부',text(recA,'peri'),text(recB,'peri')]].map(([label,a,b])=><tr key={label} className="border-t"><th className="p-2 text-left font-normal">{label}</th><td className="p-2 break-words">{loading?'불러오는 중':a}</td><td className="p-2 break-words">{loading?'불러오는 중':b}</td></tr>)}</tbody></table><p className="text-xs text-slate-500 mt-2">미입력은 변화 없음이 아닙니다. 분류는 각 사정의 저장값입니다.</p></Card>
 </div></div>{zoom&&<div className="fixed inset-0 z-[60] bg-black/90 flex flex-col p-4" onClick={e=>{e.stopPropagation();setZoom(null)}}><button type="button" aria-label="확대 사진 닫기" className="text-white self-end p-3" onClick={e=>{e.stopPropagation();setZoom(null)}}>닫기 ×</button><img src={zoom} alt="확대한 기록 사진" className="w-full h-full min-h-0 object-contain"/></div>}</div>;
}


/* ------------------------------------------------------------------ */
/* 상처 상세 화면 (추적)                                                */
/* ------------------------------------------------------------------ */
function WoundScreen({ idx, woundId, onBack, onFollowUp, onHome }) {
  const w = idx.wounds[woundId];
  const [detailId, setDetailId] = useState(null);
  const [compare, setCompare] = useState(false);
  const [trendOpen,setTrendOpen]=useState(false);
  const [thumbnails,setThumbnails]=useState({});
  useEffect(()=>{let active=true;setThumbnails({});const ids=idx.wounds[woundId]?.assessmentIds||[];
    Promise.all(ids.map(async id=>{const record=await loadFull(id);return [id,record?.photo?.dataUrl||null]})).then(rows=>{if(active)setThumbnails(Object.fromEntries(rows))});
    return()=>{active=false};
  },[idx,woundId]);
  if (!w) return <div className="p-4 text-sm text-slate-500">상처 기록을 찾을 수 없습니다.</div>;
  const p = idx.patients[w.patientId] || {};
  const list = (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  // 치유됨(HEALED)은 현재 상처가 완전히 폐쇄된 상태이므로
  // 이전에 측정된 크기를 현재 크기처럼 표시하거나 크기 추이에 포함하지 않습니다.
  const chartData = list
    .filter((a) => validArea(a.areaCm2) && a.stage !== "HEALED")
    .map((a) => ({ id:a.id, d:dateFull(a.date).slice(5), area:Number(a.areaCm2) }));

  const latest=list.at(-1);
  const currentArea=latest&&latest.stage!=="HEALED"&&validArea(latest.areaCm2)?Number(latest.areaCm2):null;
  const firstArea=chartData[0]?.area;
  const change=currentArea!=null&&chartData.length>1?areaChange(firstArea,currentArea):null;
  const previousNonHealedStage = (index) => {
    for (let i = index - 1; i >= 0; i--) {
      const prev = list[i];
      if (prev && prev.stage && prev.stage !== "HEALED") return stageLabel(prev.stage);
    }
    return null;
  };

  return (
    <div className="pl-record-screen pb-8 bg-white">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 flex items-center px-4 py-4 gap-3">
        <button aria-label="뒤로가기" onClick={onBack} className="p-2 rounded-xl bg-white"><ChevronLeft size={18} /></button>
        <div className="flex-1">
          <div className="text-base font-bold text-slate-900">{w.location}{w.sub ? ` (${w.sub})` : ""}</div>
          <div className="text-xs text-slate-500">{w.patientId}{p.ward ? ` · ${p.ward}` : ""}{p.room ? ` ${p.room}` : ""} · 사정 {list.length}회</div>
        </div>
        {list.length >= 2 && (
          <button onClick={() => setCompare(true)} className="px-3 py-2 rounded-xl border border-teal-600 text-teal-700 bg-white text-xs font-semibold flex items-center gap-1" >
            <ArrowLeftRight size={14} /> 비교
          </button>
        )}
        <button className="pl-record-home" aria-label="홈으로" onClick={onHome || onBack}><HomeIcon size={21}/></button>
      </div>
      <div className="pl-record-scroll pl-photo-first p-4 space-y-4">
        <button onClick={() => onFollowUp && onFollowUp(w.id)}
          className="pl-follow-action w-full text-white"
          style={{ backgroundColor: "#087F83" }}>
          <span className="pl-follow-camera"><Camera size={26}/></span><span><strong>F/U 사정 시작</strong><small>이 상처의 다음 기록 남기기</small></span><ChevronRight size={22} />
        </button>
        {latest&&<button className="pl-latest-photo" onClick={()=>setDetailId(latest.id)} aria-label="최근 사정 결과 보기">
          <div className="pl-latest-image"><div className="pl-latest-date"><strong>최근 사정</strong><span>{dateFull(latest.date).slice(5).replaceAll('-','.')}</span></div>
          {thumbnails[latest.id]?<img src={thumbnails[latest.id]} alt="최근 사정 당시 상처 사진"/>:<div className="pl-latest-placeholder"><Camera size={36}/><span>{Object.hasOwn(thumbnails,latest.id)?'사진 없는 기록':'사진 불러오는 중…'}</span></div>}</div>
          <div className="pl-latest-info"><div><StageBadge code={latest.stage}/><span>최근 기록의 최종 분류</span></div><strong>{latest.stage==='HEALED'?'현재 개방성 상처 없음':latest.lengthCm!=null&&latest.widthCm!=null?latest.lengthCm+' × '+latest.widthCm+' cm'+(validArea(latest.areaCm2)?' · '+latest.areaCm2+' cm²':''):'크기 미입력'}</strong><ChevronRight size={17}/></div>
        </button>}
        {chartData.length >= 1 && (
          <div className="pl-change-card">
            <div className="pl-change-label">기록된 면적 변화</div>
            <div className="pl-change-values"><strong>{currentArea==null?'최근 면적 미측정':chartData.length>1?firstArea+' → '+currentArea+' cm²':currentArea+' cm²'}</strong>{change!=null&&<span>{Math.abs(change)}% {change<0?'감소':change>0?'증가':'변화 없음'}</span>}</div>
            {currentArea!=null&&chartData.length>1&&<p className="pl-change-period">{dateFull(list.find(a=>a.id===chartData[0].id).date).slice(5)} → {dateFull(latest.date).slice(5)} · 첫 측정 대비</p>}
            <p className="pl-change-note">면적 변화만으로 치유를 판단하지 않습니다.</p>
            <button className="pl-trend-toggle" aria-expanded={trendOpen} aria-controls="record-trend" onClick={()=>setTrendOpen(v=>!v)}><ArrowLeftRight size={18}/><strong>변화 추이 보기</strong><ChevronRight size={18} style={{transform:trendOpen?'rotate(-90deg)':'rotate(90deg)'}}/></button>
            {trendOpen&&<div id="record-trend" className="pl-trend-expanded">
            <div style={{ height: chartData.length > 1 ? 150 : 120 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 22, right: 24, left: -30, bottom: 0 }}>
                  <defs><linearGradient id="recordAreaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0798a7" stopOpacity={0.2}/><stop offset="100%" stopColor="#0798a7" stopOpacity={0.02}/></linearGradient></defs><CartesianGrid stroke="#e8eef2" vertical={false} />
                  <XAxis dataKey="d" height={44} interval="preserveStartEnd" minTickGap={20} tick={({x,y,payload})=><text x={x} y={y} textAnchor="middle" fill="#64748B" fontSize={10}><tspan x={x} dy="12">{payload.value.split(' ')[0]}</tspan><tspan x={x} dy="14">{payload.value.split(' ')[1]}</tspan></text>} />
                  <YAxis domain={[0,"auto"]} tick={{ fontSize: 11, fill: "#64748B" }} />

                  <Area isAnimationActive={false} fill="url(#recordAreaFill)" type="linear" dataKey="area" name="면적 (cm²)" stroke="#087F83" strokeWidth={3} label={{position:"top",fontSize:11,fontWeight:700,fill:"#172f3b"}} dot={{r:4,fill:"#0798a7",strokeWidth:0}} />                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="pl-change-note">길이 × 너비의 근사 면적 · 모든 측정 기록</p>
            </div>}
          </div>
        )}
        <div className="pl-photo-history">
          <div className="pl-history-heading"><h3>이전 기록</h3><span>전체 {list.length}회</span></div>
          {list.length<2&&<p className="pl-history-empty">F/U 사정을 기록하면 이곳에 이전 기록이 쌓여요.</p>}
          {list.slice(0,-1).reverse().map((a) => {
            const originalIndex = list.findIndex((x) => x.id === a.id);
            const prevStage = a.stage === "HEALED" ? previousNonHealedStage(originalIndex) : null;
            return (
              <button key={a.id} onClick={() => setDetailId(a.id)} className={"w-full text-left rounded-xl border border-slate-100 p-3 flex items-center gap-3 "+(a.id===list.at(-1)?.id?"bg-teal-50/70":"bg-white")}>
                <div className="shrink-0 w-16 h-16 rounded-xl bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center">
                  {thumbnails[a.id]?<img src={thumbnails[a.id]} alt="사정 당시 사진" className="w-full h-full object-cover"/>:<span className="text-[10px] text-slate-500">{Object.prototype.hasOwnProperty.call(thumbnails,a.id)?'사진 없음':'불러오는 중'}</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-slate-900">{dateFull(a.date).slice(5).replaceAll("-",".")}</div>
                  {a.stage === "HEALED" ? (
                    <div className="text-xs text-slate-500">
                      {prevStage ? `이전 ${prevStage} · 현재 개방성 상처 없음` : "현재 개방성 상처 없음"}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      {a.lengthCm ? `${a.lengthCm} × ${a.widthCm} cm` : "크기 미입력"}{a.areaCm2 ? ` · ${a.areaCm2} cm²` : ""}
                    </div>
                  )}
                </div>
                <StageBadge code={a.stage} />
                <ChevronRight size={16} className="text-slate-400" />
              </button>
            );
          })}
        </div>
      </div>
      {detailId && <AssessmentDetail aid={detailId} onClose={() => setDetailId(null)} onUpdated={()=>window.dispatchEvent(new Event("pressure-record-updated"))} />}
      {compare && <CompareView idx={idx} woundId={woundId} onClose={() => setCompare(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 기록 화면                                                            */
/* ------------------------------------------------------------------ */
function RecordsScreen({ idx, initialTab, onBack, onOpenWound }) {
  const [query,setQuery]=useState("");
  const [tab, setTab] = useState(initialTab || "patients");
  const wounds = Object.values(idx.wounds);
  const patients = Object.values(idx.patients).sort((a, b) => {
    const latestA = wounds
      .filter((w) => w.patientId === a.id)
      .flatMap((w) => (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean))
      .sort((x, y) => new Date(y.date) - new Date(x.date))[0];
    const latestB = wounds
      .filter((w) => w.patientId === b.id)
      .flatMap((w) => (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean))
      .sort((x, y) => new Date(y.date) - new Date(x.date))[0];
    return (latestB ? new Date(latestB.date).getTime() : 0) - (latestA ? new Date(latestA.date).getTime() : 0);
  });
  const recent = Object.values(idx.assess).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);

  return (
    <div className="pl-content-screen pl-records-screen pb-8">
      <div className="pl-records-header">
        <PageToolbar onBack={onBack}/>
        <PageIntro title="환자 · 욕창 기록" sub="경과와 사정 기록 확인" kind="records"/><div className="px-4 pb-3"><input aria-label="환자 또는 부위 검색" placeholder="환자 또는 부위 검색" value={query} onChange={e=>setQuery(e.target.value)} className="pl-search"/></div><div className="flex gap-2 px-4 pb-3">
          {[{ k: "patients", l: "환자별" }, { k: "recent", l: "최근 사정" }].map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={"px-4 py-1.5 rounded-full text-sm font-semibold border " + (tab === t.k ? "text-white border-transparent" : "bg-white text-slate-600 border-slate-300")}
              style={tab === t.k ? { backgroundColor: "#087F83" } : {}}>{t.l}</button>
          ))}
        </div>
      </div>
      <div className="p-4 space-y-4">
        {patients.length === 0 && (
          <Card><p className="text-sm text-slate-500 text-center py-6">저장된 기록이 없습니다.<br />홈에서 새 욕창 사정을 시작하세요.</p></Card>
        )}
        {tab === "patients" && patients.filter(p=>[p.id,p.ward,p.room,...wounds.filter(w=>w.patientId===p.id).map(w=>w.location)].join(" ").toLowerCase().includes(query.toLowerCase())).map((p) => {
          const pw = wounds.filter((w) => w.patientId === p.id);
          return (
            <div key={p.id}>
              <div className="text-xs font-bold text-slate-500 mb-1.5 px-1">{p.id}{p.ward ? ` · ${p.ward}` : ""}{p.room ? ` ${p.room}` : ""}{p.sex ? ` · ${p.sex}` : ""}{p.age ? ` ${p.age}세` : ""}</div>
              <div className="space-y-2">
                {pw
                  .map((w) => ({
                    w,
                    last: (w.assessmentIds || []).map((id) => idx.assess[id]).filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date))[0],
                  }))
                  .sort((a, b) => (b.last ? new Date(b.last.date).getTime() : 0) - (a.last ? new Date(a.last.date).getTime() : 0))
                  .map(({ w, last }) => {
                  return (
                    <button key={w.id} onClick={() => onOpenWound(w.id)} className="w-full text-left bg-white rounded-2xl border border-slate-200 shadow-sm p-3 flex items-center gap-3">
                      <RecordThumb id={last?.id}/><div className="flex-1 min-w-0">
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
        {tab === "recent" && recent.filter(a=>[idx.wounds[a.woundId]?.patientId,idx.wounds[a.woundId]?.location].join(" ").toLowerCase().includes(query.toLowerCase())).map((a) => {
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
      await removeAllRecords();
      onReset();
    } catch (e) { setInfoErr("삭제를 완료하지 못했습니다. 일부 기록이 삭제되었을 수 있습니다. 다시 시도해주세요."); }
    setBusy(false);
  };
  return (
    <div className="pl-content-screen pl-info-screen pb-8">
      <PageToolbar onBack={onBack}/>
      <PageIntro title="정보 · 설정" sub="사용 안내와 데이터 관리" kind="info"/>
      <AccountCredits useBack={usePhoneBack}/><div className="p-4 space-y-3">
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
            <Trash2 size={16} /> {busy ? "삭제 중…" : confirmDel ? "다시 탭하면 영구 삭제됩니다" : "현재 보관함 기록 삭제"}
          </button>
          {infoErr && <p className="text-xs text-red-600 mt-2">{infoErr}</p>}
        </Card>
        <p className="text-center text-xs text-slate-400">Pressure Lens · MVP v1.0.4 (artifact-safe env)</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 욕창 위험도 평가 (Braden)                                            */
/* ------------------------------------------------------------------ */
function BradenScreen({ onBack }) {
  const recMode = "international";
  const [step,setStep]=useState(0);
  usePhoneBack(step>0,()=>setStep(v=>v-1),20);
  const [v, setV] = useState(emptyBraden());
  const total = bradenTotal(v);
  const risk = bradenRisk(total);
  return (
    <div className="pl-content-screen pl-braden-screen pb-8">
      <PageToolbar onBack={onBack} subtitle="Braden Scale · 표준 위험 분류"/>
      <PageIntro title="욕창 위험도 평가" sub="Braden Scale · 예방 중재" kind="braden"/><div className="p-4 space-y-3">
        <Card>
          <div className="pl-risk-progress"><strong>{step+1} / {BRADEN_ITEMS.length}</strong><progress max={BRADEN_ITEMS.length} value={BRADEN_ITEMS.filter(it=>v[it.k]!=null).length}/></div><div className="pl-risk-question"><h2>{BRADEN_ITEMS[step].l}</h2><div className="pl-risk-options">{BRADEN_ITEMS[step].opts.map((o,i)=><button key={i} aria-pressed={v[BRADEN_ITEMS[step].k]===i+1} onClick={()=>setV({...v,[BRADEN_ITEMS[step].k]:i+1})}><span>{i+1}</span><strong>{o}</strong>{v[BRADEN_ITEMS[step].k]===i+1?<Check size={20}/>:<i/>}</button>)}</div></div><div className="pl-risk-actions"><GhostBtn onClick={()=>setStep(Math.max(0,step-1))}>이전 항목</GhostBtn><PrimaryBtn disabled={v[BRADEN_ITEMS[step].k]==null||step===5} onClick={()=>setStep(step+1)}>{step===5?"평가 완료":"다음 항목"}</PrimaryBtn></div><p className="pl-muted-note">{total!=null?"6개 항목 평가를 완료했어요. 아래 결과를 확인하세요.":"모든 항목을 입력하면 결과를 확인할 수 있어요."}</p>
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
/* 욕창 교육자료                                                        */
/* 공개 가이드라인 기반의 요약 교육자료                                  */
/* ------------------------------------------------------------------ */
function EducationScreen({ onBack }) {
  const [category,setCategory]=useState("stage");
  const [openStage, setOpenStage] = useState(null);
  const [openDressing, setOpenDressing] = useState(null);

  const stageCards = [
    {
      code: "1",
      title: "Stage 1",
      color: "#D96470",
      summary: "피부 온전 + 비창백성 홍반",
      detail: "피부 손상 없이 국소적인 비창백성 홍반이 지속되는 상태입니다. 피부색이 진한 경우 색 변화만으로 판단하지 말고 시진·촉진을 함께 시행합니다."
    },
    {
      code: "2",
      title: "Stage 2",
      color: "#CF941E",
      summary: "부분층 피부손실 + 진피 노출",
      detail: "부분층 피부손실로 노출된 조직은 진피입니다. 지방조직, 육아조직, slough, eschar 또는 깊은 조직이 보이면 Stage 2로 분류하지 않습니다."
    },
    {
      code: "3",
      title: "Stage 3",
      color: "#EF4444",
      summary: "전층 피부손실 + 피하지방 확인",
      detail: "전층 피부손실이며 피하지방이 보일 수 있습니다. undermining이나 tunneling이 동반될 수 있습니다."
    },
    {
      code: "4",
      title: "Stage 4",
      color: "#B91C1C",
      summary: "전층 손상 + 심부 구조 노출/촉지",
      detail: "근막·근육·건·연골·뼈가 노출되거나 직접 촉지될 수 있는 전층 조직손상입니다."
    },
    {
      code: "U",
      title: "Unstageable",
      color: "#64748B",
      summary: "괴사조직으로 깊이 확인 불가",
      detail: "slough 또는 eschar가 전부 또는 일부를 덮어 실제 조직손상의 깊이를 확인할 수 없는 경우입니다."
    },
    {
      code: "DTPI",
      title: "DTPI",
      color: "#7C3AED",
      summary: "심부조직 압력손상 의심",
      detail: "지속되는 비창백성 진한 적색·적갈색·자주색 변색 또는 혈성 수포 등이 나타날 수 있으며 경과에 따라 실제 조직손상이 드러날 수 있습니다."
    }
  ];

  // 독립적으로 작성한 교육용 분류 요약. 특정 환자의 드레싱 처방 알고리즘이 아님.


  // 제조사별 제품명은 분류 학습용 예시이며 병원 채택/국내 유통 여부를 뜻하지 않음.


  const renderDepthDiagram = code => <div className="pl-education-detail-art"><StageIllustration code={code}/></div>;

  return (
    <div className="pl-content-screen pl-education-screen pb-8">
      <PageToolbar onBack={onBack} subtitle="Stage · 사정 · 드레싱 · 추적관리"/>

      <PageIntro title={category==="dress"?"드레싱 종류":"욕창 교육자료"} sub={category==="dress"?"형태와 재질을 한눈에":"단계별 사정과 드레싱"} kind="education"/><div className="p-4 space-y-3"><div className="pl-segments">{[{k:"stage",l:"단계 구분"},{k:"observe",l:"상처 관찰"},{k:"dress",l:"드레싱"}].map(x=><button key={x.k} aria-pressed={category===x.k} onClick={()=>setCategory(x.k)}>{x.l}</button>)}</div>


        {category==="stage"&&(<Card>
          <SectionTitle>그림으로 보는 단계</SectionTitle>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            아래 그림은 실제 상처 사진이 아닌 교육용 단순화 모식도입니다. 카드를 누르면 핵심 판정 기준을 확인할 수 있습니다.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {stageCards.map((s) => (
              <button key={s.code} onClick={() => setOpenStage(openStage === s.code ? null : s.code)}
                className="text-left rounded-xl border border-slate-200 bg-white p-3 active:scale-[0.99]">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-xs font-extrabold"
                    style={{ backgroundColor: s.color }}>
                    {s.code}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-slate-900">{s.title}</div>
                    <div className="text-[10px] text-slate-500 leading-tight">{s.summary}</div>
                  </div>
                </div>
                <div className="pl-stage-art"><StageIllustration code={s.code}/></div>{openStage === s.code && (
                  <>

                    <div className="mt-2 text-xs text-slate-700 leading-relaxed">{s.detail}</div>
                  </>
                )}
              </button>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed">
            <b>중요:</b> IAD는 욕창 Stage가 아닙니다. 둔부·회음부의 습기 관련 미만성 피부손상은 IAD를 감별하고, AI 제안 Stage와 최종 임상 판단을 구분해 기록합니다.
          </div>
        </Card>)}

        {category==="observe"&&(<section className="pl-observe-guide" aria-label="상처 관찰 안내">
          <div className="pl-observe-intro"><strong>무엇을 보고, 어떻게 기록할까요?</strong><p>위치부터 경과까지, 필요한 항목을 순서대로 확인하세요.</p></div>
          {[
            {title:'위치와 피부 상태',sub:'위치 · 발생 시점 · 피부 온전성',items:[['기본 정보','부위, 발생 시점, 과거 단계와 현재 상태를 구분해 기록합니다.'],['직접 관찰','피부 손상과 색 변화, 통증·온도·촉감을 함께 확인합니다. 사진만으로 단계나 원인을 확정하지 않습니다.']]},
            {title:'상처 바닥과 주변 피부',sub:'조직 · 가장자리 · 주변 피부',items:[['상처 바닥 (Wound bed)','육아조직, 부육, 가피와 노출된 조직을 확인합니다.'],['가장자리 (Edge)','상피화, 말림, 잠식·터널을 확인합니다.'],['주변 피부 (Periwound)','홍반, 침연, 피부 벗겨짐, 부종·단단함을 기록합니다.']]},
            {title:'삼출물과 통증',sub:'양 · 양상 · 냄새 · 변화',items:[['삼출물 (Exudate)','양과 양상을 구분합니다. 장액성, 장액혈성, 혈성, 화농성 등 관찰한 내용을 기록합니다.'],['통증과 냄새','새로 생기거나 증가한 변화, 드레싱 교환 시 불편감을 확인합니다. 냄새만으로 감염을 확진하지 않습니다.']]},
            {title:'크기 측정과 F/U',sub:'같은 방법으로 측정 · 비교',items:[['길이 · 너비 · 깊이','기관의 일관된 측정법을 따릅니다. 너비는 길이에 수직인 최대 폭, 깊이는 가장 깊은 지점을 측정합니다. 미측정을 0 cm로 기록하지 않습니다.'],['사진과 비교','가능하면 같은 거리·각도·조명·자세를 유지합니다. 길이 × 너비는 근사 면적이며, 면적 감소만으로 치유를 판단하지 않습니다.'],['단계 기록','치유 중인 욕창을 3 → 2 → 1로 역단계화하지 않습니다. 완전 폐쇄·상피화 여부와 과거 단계를 구분합니다.']]},
            {title:'보고가 필요한 변화',sub:'이전 기록과 달라진 소견',items:[['변화 확인','통증 증가, 발적 확산·열감, 화농성 배액, 발열·전신 상태 변화 등을 종합해 담당 의료진에게 보고합니다.'],['전문 평가','급격한 악화, 깊은 공동·터널, 심부 구조 노출은 전문 평가와 연계합니다.'],['가피 주의','발뒤꿈치 또는 허혈성 사지의 안정적이고 건조하며 단단히 부착된 가피는 임의로 제거·연화하지 않고 관류와 감염 징후를 평가합니다.']]},
            {title:'중재와 다음 사정',sub:'압력 제거 · 드레싱 · 재평가',items:[['중재 확인','압력·전단력 감소, 지지면·체위변경, 영양·혈류, 환자의 목표와 치료 계획을 함께 확인합니다. 드레싱만으로 압력손상을 치료하지 않습니다.'],['재평가','교환 시 누출·포화·침연·출혈·피부손상과 불편감을 확인합니다. 교환 및 추적 간격은 상처 상태와 기관 지침에 따릅니다.']]}
          ].map((item,i)=><details key={item.title} className="pl-observe-step" open={i===0?true:undefined}><summary><span className="pl-observe-number">{String(i+1).padStart(2,'0')}</span><span className="pl-observe-heading"><strong>{item.title}</strong><small>{item.sub}</small></span><ChevronRight size={18}/></summary><div className="pl-observe-body">{item.items.map(([label,text])=><div key={label}><h3>{label}</h3><p>{text}</p></div>)}</div></details>)}
          <p className="pl-observe-footnote">교육용 관찰 안내 · 기관 지침과 직접 사정을 함께 적용하세요.</p>
        </section>)}

        {category==="dress"&&(<section className="pl-dressing-library" aria-label="드레싱 종류">
          <div className="pl-dressing-caption">교육용 예시 · 제품마다 형태가 다를 수 있어요.</div>
          <div className="pl-dressing-list">{dressingCards.map((d,i)=><article key={d.key} className="pl-dressing-card">
            <button type="button" aria-expanded={openDressing===d.key} aria-controls={'dressing-detail-'+d.key} className="pl-dressing-toggle" onClick={()=>setOpenDressing(openDressing===d.key?null:d.key)}>
              <span className={'pl-dressing-art pl-dressing-art-'+i} aria-hidden="true"/>
              <span className="pl-dressing-copy"><strong>{d.title.replace(' (Foam)','').replace(' (Alginate)','')}</strong><small>{['흡수성 패드 · 부드러운 쿠션','얇은 시트 · 겔 형성','투명한 겔 · 수분 공급','흡수성 섬유 · 겔 형성','부드러운 섬유 · 삼출물 흡수','얇고 투명한 보호막','얇은 망 · 취약한 조직 보호','성분과 제품에 따라 형태가 달라요'][i]}</small></span>
              <ChevronRight size={18} className="pl-dressing-chevron" style={{transform:openDressing===d.key?'rotate(90deg)':undefined}}/>
            </button>
            {openDressing===d.key&&<div id={'dressing-detail-'+d.key} className="pl-dressing-detail">                    <div className="text-xs text-slate-700 leading-relaxed">{d.desc}</div>
                    <div className="mt-2 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600 leading-relaxed">
                      <b>선택 시:</b> {d.use}
                    </div>
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 leading-relaxed"><b>주의:</b> {d.caution}</div>
                    <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50 p-2.5 text-xs text-slate-700 leading-relaxed">
                      <b className="text-sky-900">실제 제품명 예시 (교육용)</b>
                      <ul className="mt-1 space-y-1">{(dressingProducts[d.key] || []).map((name) => <li key={name}>• {name}</li>)}</ul>
                      {d.key === "foam" && <p className="mt-2 text-amber-800">Border=테두리형, Non-Adhesive=비접착형, Lite=세부 라인에 따라 얇은/낮은 흡수 용량, Ag=은 함유 항균형입니다. 브랜드 간 성능과 적응증이 동일하다는 뜻은 아닙니다.</p>}
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">제품명은 분류 학습용 예시이며 국내 공급·병원 채택 여부를 보장하지 않습니다. 세부 라인별 적응증, 흡수력, 항균 성분, 교환 주기, 금기는 최신 제조사 사용설명서(IFU) 및 기관 지침을 확인하세요.</p>
</div>}
          </article>)}</div>
          <p className="pl-dressing-footnote">그림은 종류를 이해하기 위한 예시입니다.</p>
          <details className="pl-dressing-principles"><summary>드레싱 선택 원칙</summary><p>단계만으로 드레싱을 정하지 않습니다. 삼출물 양, 상처 바닥, 주변 피부, 감염 소견, 통증과 상처 깊이를 함께 확인합니다.</p></details>
        </section>)}


        {category==="dress"&&<SkinProtectionEducation/>}
        {category==="dress"&&(<Card>
          <SectionTitle>예방적 드레싱은 별도로 보기</SectionTitle>
          <div className="text-sm text-slate-700 leading-relaxed space-y-2">
            <p>· 예방 목적의 드레싱은 이미 생긴 욕창의 치료용 드레싱과 구분합니다.</p>
            <p>· 2026 International Guideline은 욕창 고위험자의 천골·발꿈치에 자원이 허용되는 경우 다층 연질 실리콘 폼 예방적 드레싱을 고려할 수 있다고 제시합니다.</p>
            <p>· 예방적 드레싱을 사용하더라도 체위변경, 압력 재분산, 피부 사정 등 다른 예방 중재를 함께 시행합니다.</p>
          </div>
        </Card>)}



        <details className="pl-source-fold"><summary>공식 자료 · 출처 확인</summary><Card>
          <SectionTitle>공식 자료 · 제품 정보</SectionTitle>
          <div className="space-y-2">
            <a href="https://www.npiap.com/page/PressureInjuryStages" target="_blank" rel="noreferrer"
              className="block rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-bold text-slate-900">NPIAP Pressure Injury Stages</div>
              <div className="text-xs text-slate-500 mt-0.5">공식 Stage 정의·교육용 일러스트·포스터</div>
            </a>
            <a href="https://www.internationalguideline.com/woundhealing" target="_blank" rel="noreferrer"
              className="block rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-bold text-slate-900">International Guideline · Supporting Pressure Injury Healing</div>
              <div className="text-xs text-slate-500 mt-0.5">드레싱 선택 원칙·상처 치유·F/U</div>
            </a>
            <a href="https://www.internationalguideline.com/skincare" target="_blank" rel="noreferrer"
              className="block rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-bold text-slate-900">International Guideline · Preventive Skin Care</div>
              <div className="text-xs text-slate-500 mt-0.5">예방적 피부관리·예방적 드레싱</div>
            </a>
          </div>
        </Card><Card>
          <SectionTitle>공식 가이드라인 기반 교육</SectionTitle>

          <div className="grid grid-cols-2 gap-2 mt-3">
            <a href="https://www.internationalguideline.com/classification" target="_blank" rel="noreferrer"
              className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs font-bold text-sky-800 text-center">
              국제 가이드라인<br />Classification
            </a>
            <a href="https://npiap.com/page/PressureInjuryStages" target="_blank" rel="noreferrer"
              className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs font-bold text-sky-800 text-center">
              NPIAP<br />공식 Stage 자료
            </a>
          </div>
        </Card></details>
      </div>
    </div>
  );
}
/* ------------------------------------------------------------------ */
/* 홈 & 앱 루트                                                         */
/* ------------------------------------------------------------------ */
function ResultHeadline({ final, photo, size = {}, areaCm2, ai, patientId, location, date }) {
  const stage = STAGES.find(s => s.code === final.stage) || STAGES.find(s => s.code === "ND");
  const tone = ["1","2","3","4"].includes(stage.code) ? "peach" : ["U","DTPI"].includes(stage.code) ? "purple" : ["HEALED","NONE"].includes(stage.code) ? "teal" : "neutral";
  const aiStage = ai && ai.canAssess !== false ? mapAiStage(ai.suggestedStage) : null;
  const display = v => v != null && v !== "" ? v : "—";
  const bedNames = {granulation:"육아조직",slough:"부육질",eschar:"가피",necrotic:"괴사조직",dermis:"진피 노출",other:"기타"};
  const bedText = Array.isArray(final.woundBed?.types) ? final.woundBed.types.map(t => bedNames[t] || t).join(" · ") : woundBedText(final.woundBed);
  const amountNames = {None:"없음",Scant:"극소량",Small:"소량",Moderate:"중등량",Large:"다량"};
  const typeNames = {Serous:"장액성",Serosanguineous:"장액혈성",Sanguineous:"혈성",Purulent:"화농성"};
  const exudateSummary = amountNames[final.exudateAmount] ? amountNames[final.exudateAmount] + (final.exudateType ? " · " + (typeNames[final.exudateType] || final.exudateType) : "") : "미입력";
  const skinNames = {Intact:"피부 온전",Erythema:"발적",Maceration:"침연",Excoriation:"표피 손상",Induration:"경결",Edema:"부종"};
  return <section className="pl-result-headline" aria-label="최종 사정 결론">
    <div className="pl-result-meta">{[patientId, location, date].filter(Boolean).join(" · ")}</div>
    <div className={"pl-result-banner " + tone}>
      {photo?.dataUrl ? <img className="pl-result-photo" src={photo.dataUrl} alt="이번 사정의 상처 사진" /> : <div className="pl-result-photo pl-result-no-photo"><Camera size={27} /><span>사진 없음</span></div>}
      <div className="pl-result-verdict"><span>간호사 최종 사정</span><h2>{stage.label}{["1","2","3","4"].includes(stage.code) ? " (" + stage.code + "단계)" : ""}</h2><p>{stage.desc}</p></div>
    </div>
    <div className="pl-result-ai"><Sparkles size={14} /><span>AI 제안: <b>{aiStage ? stageLabel(aiStage) : "미시행"}</b></span>{aiStage && <span className={aiStage === final.stage ? "pl-agreement" : "pl-disagreement"}>{aiStage === final.stage ? "최종 사정과 일치" : "최종 사정과 다름"}</span>}</div>
    <div className="pl-result-metrics"><div><span>길이 × 너비</span><strong>{display(size.lengthCm)} × {display(size.widthCm)}<small> cm</small></strong></div><div><span>면적 (L×W)</span><strong>{display(areaCm2)}<small> cm²</small></strong></div><div><span>깊이</span><strong>{display(size.depthCm)}<small> cm</small></strong></div></div>
    <div className="pl-result-findings"><div><span>상처 바닥</span><strong>{bedText && bedText !== "—" ? bedText : "미입력"}</strong></div><div><span>삼출물</span><strong>{exudateSummary}</strong></div><div><span>주변 피부</span><strong>{(final.periwound || []).map(t => skinNames[t] || t).join(" · ") || "미입력"}</strong></div></div>
    <p className="pl-result-footnote">최종 단계는 간호사가 확인한 사정값입니다. 면적은 길이 × 너비 계산값입니다.</p>
  </section>;
}
function ResultSectionLinks({ onDetails }) {
  const sections = [["pl-result-summary","전체 요약"],["pl-result-detail","상세 소견"],["pl-result-care","간호 중재"],["pl-result-dressing","드레싱 검토"]];
  return <nav className="pl-result-sections" aria-label="결과 항목 바로가기">{sections.map(([id,label]) => <button key={id} onClick={() => { if (id === "pl-result-detail") onDetails?.(); document.getElementById(id)?.scrollIntoView({block:"start",behavior:"smooth"}); }}>{label}</button>)}</nav>;
}

function LensBrand({ splash = false }) {
  return <div className={splash ? "pl-brand pl-brand-splash" : "pl-brand"}>
    <img className="pl-reference-icon" src="/images/home-logo-exact.png" alt="" />
    <div><div className="pl-brand-name">Pressure Lens</div><div className="pl-brand-sub">AI 욕창 사정 및 간호 기록</div></div>
  </div>;
}
function Home({idx,go}) {
 const links=[{name:'info',label:'정보 및 설정',cls:'settings'},{name:'new',label:'새로운 욕창 사정',cls:'start'},{name:'records',label:'환자 · 욕창 기록',cls:'records'},{name:'education',label:'욕창 교육자료',cls:'education'},{name:'braden',label:'욕창 위험도 평가',cls:'braden'},{name:'info',label:'정보 · 설정',cls:'info'}];
 return <main className="pl-approved-home" aria-label="Pressure Lens 홈"><div className="pl-approved-canvas"><img src="/images/home-approved.png" alt="Pressure Lens. AI 욕창 사정 및 간호 기록. 욕창 사정부터 간호 기록까지. 사정과 기록을 한 곳에서 이어가세요." className="pl-approved-art" draggable="false"/>{links.map(x=><button key={x.cls} className={'pl-approved-hit pl-hit-'+x.cls} aria-label={x.label} onClick={()=>go({name:x.name,...(x.name==='records'?{tab:'patients'}:{})})}><span className="sr-only">{x.label}</span></button>)}</div><HomeDraftResume storage={storage} idx={idx} go={go}/></main>;
}
function BottomNav({ screen, go }) {
  const items = [{name:"home", label:"홈", icon:HomeIcon},{name:"records", label:"기록",icon:FolderOpen},{name:"education",label:"교육",icon:BookOpen},{name:"info",label:"설정",icon:Info}];
  return <nav className="pl-bottom-nav" aria-label="주 메뉴">{items.map(t => <button key={t.name} aria-current={screen.name === t.name || (t.name === "records" && screen.name === "wound") ? "page" : undefined} onClick={() => go({name:t.name, ...(t.name === "records" ? {tab:"patients"} : {})})}><t.icon size={21}/><span>{t.label}</span></button>)}</nav>;
}

export default function App() {
  const [idx, setIdx] = useState(null);
  useEffect(()=>{const refresh=()=>loadIndex().then(setIdx).catch(()=>{});window.addEventListener("pressure-record-updated",refresh);return()=>window.removeEventListener("pressure-record-updated",refresh);},[]);
  const [splashDone, setSplashDone] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSplashDone(true), 900); return () => clearTimeout(timer); }, []);
  const [screen, setScreen] = useState({ name: "home" });
  useEffect(()=>{window.pressureLensBack=dispatchPhoneBack;return()=>{delete window.pressureLensBack;};},[]);
  usePhoneBack(screen.name!=="home",()=>setScreen(screen.name==="wound"&&screen.from==="records"?{name:"records"}:screen.name==="new"&&screen.followWoundId?{name:"wound",woundId:screen.followWoundId,from:"records"}:{name:"home"}),0);

  const [loadError,setLoadError]=useState('');
  const [loadAttempt,setLoadAttempt]=useState(0);
  useEffect(() => {
    let active=true; setLoadError('');
    (async()=>{try{const next=await loadIndex();if(active)setIdx(next);}catch(error){if(active)setLoadError('기록을 읽지 못했습니다. 기록이 없는 상태와는 다릅니다. '+(error.message||''));}})();
    return()=>{active=false;};
  },[loadAttempt]);
  if(loadError)return <div className="p-6 space-y-4"><p role="alert" className="text-red-700">{loadError}</p><PrimaryBtn onClick={()=>setLoadAttempt(n=>n+1)}>다시 불러오기</PrimaryBtn><p className="text-sm text-slate-500">기존 기록을 덮어쓰지 않도록 새 사정은 잠시 중단합니다.</p></div>;

  if (!idx || !splashDone) {
    return (
      <div className="pl-splash" role="status">
        <LensBrand splash /><span className="pl-splash-loader" aria-hidden="true" /><span className="text-sm text-slate-500">불러오는 중…</span>
      </div>
    );
  }

  return (
    <div className="pl-app min-h-screen">
      <div className={"pl-shell mx-auto min-h-screen " + (screen.name === "new" ? "pl-assessment" : "pl-with-nav") + (["records","education","braden","info"].includes(screen.name) ? " pl-content-shell" : "")} style={{ maxWidth: 480 }}>
        {storage === memoryStorageAdapter && <p role="alert" className="p-3 text-sm bg-amber-50 text-amber-800">영구 저장소를 사용할 수 없어 임시 모드입니다. 앱을 종료하면 기록이 사라집니다.</p>}
        {screen.name === "home" && <Home idx={idx} go={setScreen} />}
        {screen.name === "new" && (
          <NewAssessment idx={idx} onIdxUpdate={setIdx}
            initFollowWoundId={screen.followWoundId} resumeDraftId={screen.resumeDraftId}
            onCancel={() => setScreen({ name: "home" })}
            onSaved={(nIdx, woundId) => { setIdx(nIdx); setScreen({ name: "wound", woundId }); }} />
        )}
        {screen.name === "records" && (
          <RecordsScreen idx={idx} initialTab={screen.tab}
            onBack={() => setScreen({ name: "home" })}
            onOpenWound={(woundId) => setScreen({ name: "wound", woundId, from: "records" })} />
        )}
        {screen.name === "wound" && (
          <WoundScreen onHome={()=>setScreen({name:"home"})} idx={idx} woundId={screen.woundId}
            onFollowUp={(wid) => setScreen({ name: "new", followWoundId: wid })}
            onBack={() => setScreen(screen.from === "records" ? { name: "records" } : { name: "home" })} />
        )}
        {screen.name === "education" && <EducationScreen onBack={() => setScreen({ name: "home" })} />}
        {screen.name === "braden" && <BradenScreen onBack={() => setScreen({ name: "home" })} />}
        {screen.name === "info" && (
          <InfoScreen
            onBack={() => setScreen({ name: "home" })}
            onReset={() => { setIdx(emptyIndex()); setScreen({ name: "home" }); }} />
        )}

      </div>
    </div>
  );
}
