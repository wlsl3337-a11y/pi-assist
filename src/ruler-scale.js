// Ruler image preparation and response validation. Wound boundaries are never inferred here.
export function findContentRect(pixels, width, height) {
  const blackRow = y => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i] > 3 || pixels[i + 1] > 3 || pixels[i + 2] > 3) return false;
    }
    return true;
  };
  let top = 0, bottom = height - 1;
  while (top < bottom && blackRow(top)) top++;
  while (bottom > top && blackRow(bottom)) bottom--;
  // Only remove substantial, uniformly black letterboxing, never arbitrary dark skin.
  if (bottom - top < height * .15 || (top < 8 && height - bottom - 1 < 8)) return { x: 0, y: 0, w: width, h: height };
  return { x: 0, y: top, w: width, h: bottom - top + 1 };
}

export function validRulerBox(box) {
  if (!box || !['xMin','yMin','xMax','yMax'].every(k => Number.isFinite(box[k]) && box[k] >= 0 && box[k] <= 1)) return null;
  if (box.xMax - box.xMin < .025 || box.yMax - box.yMin < .015) return null;
  return box;
}

export function scaleFromTicks(result, width, height) {
  if (result?.readable !== true || !Array.isArray(result.ticks) || result.ticks.length < 3) return null;
  const label = String(result.unitLabel || '').trim().toLowerCase();
  const unit = result.unit;
  const factor = unit === 'cm' && /^(cm|centimet(?:er|re)s?)$/.test(label) ? 1
    : unit === 'mm' && /^(mm|millimet(?:er|re)s?)$/.test(label) ? .1
    : unit === 'inch' && /^(inches|inch|in)$/.test(label) ? 2.54 : null;
  if (!factor || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ticks = result.ticks;
  if (!ticks.every(t => Number.isFinite(t.value) && Number.isFinite(t.x) && Number.isFinite(t.y) && t.x >= 0 && t.x <= 1 && t.y >= 0 && t.y <= 1)) return null;
  const ordered = [...ticks].sort((a,b) => a.value - b.value);
  const a = ordered[0], b = ordered.at(-1);
  const cm = (b.value - a.value) * factor;
  const dx = (b.x - a.x) * width, dy = (b.y - a.y) * height;
  const span = Math.hypot(dx, dy);
  if (cm <= 0 || cm > 30 || span < 12) return null;
  const pxPerCm = span / cm;
  for (let i = 1; i < ordered.length; i++) {
    const p = ordered[i - 1], q = ordered[i];
    const actualCm = (q.value - p.value) * factor;
    if (actualCm <= 0) return null;
    const segment = Math.hypot((q.x-p.x)*width, (q.y-p.y)*height);
    if (Math.abs(segment / actualCm / pxPerCm - 1) > .18) return null;
    const qx = (q.x-a.x)*width, qy=(q.y-a.y)*height;
    const along = (qx*dx + qy*dy) / (span*span);
    const perpendicular = Math.abs(qx*dy - qy*dx) / span;
    if (along < -.02 || along > 1.02 || perpendicular > Math.max(3, span*.025)) return null;
  }
  return {p1:{x:a.x,y:a.y},p2:{x:b.x,y:b.y},cm:Number(cm.toFixed(4)),note:`${result.unitLabel}: ${a.value} → ${b.value} (${Number(cm.toFixed(4))} cm)`, unit};
}

export function mapScaleToPhoto(scale, rect, photoWidth, photoHeight) {
  if (!scale) return null;
  const map = p => ({x:(rect.x+p.x*rect.w)/photoWidth,y:(rect.y+p.y*rect.h)/photoHeight});
  return {...scale,p1:map(scale.p1),p2:map(scale.p2)};
}

// A geometrically plausible AI line is insufficient: verify printed ticks in the actual pixels.
export function verifyTickPixels(result, pixels, width, height) {
  const scale=scaleFromTicks(result,width,height);
  if (!scale || !pixels || pixels.length !== width*height*4 || !['cm','mm'].includes(result.unit)) return false;
  const ordered=[...result.ticks].sort((a,b)=>a.value-b.value);
  const a=ordered[0],b=ordered.at(-1);
  const dx=(b.x-a.x)*width,dy=(b.y-a.y)*height,span=Math.hypot(dx,dy);
  const ux=dx/span,uy=dy/span,nx=-uy,ny=ux;
  const minorCount=Math.round(scale.cm*10),minorPx=span/minorCount;
  if (minorCount<10 || minorCount>150 || minorPx<3) return false;
  const rgb=(x,y)=>{
    const ix=Math.round(x),iy=Math.round(y);
    if(ix<0||iy<0||ix>=width||iy>=height) return null;
    const i=(iy*width+ix)*4;
    return [pixels[i],pixels[i+1],pixels[i+2]];
  };
  const paper=c=>c && Math.min(...c)>150 && Math.max(...c)-Math.min(...c)<65;
  const ink=c=>c && ((c[2]-c[0]>12 && c[2]>c[0]*1.1 && c[0]<180) || Math.max(...c)<95);
  function strokeAt(x,y) {
    const radius=Math.max(1,Math.min(3,minorPx*.18));
    const extent=Math.max(6,Math.min(36,minorPx*2.5));
    for(let offset=-radius;offset<=radius;offset++) {
      const px=x+ux*offset,py=y+uy*offset;
      for(const sign of [-1,1]) {
        let run=0,maxRun=0,paperSides=0;
        for(let d=-3;d<=extent;d++) {
          const sx=px+nx*d*sign,sy=py+ny*d*sign;
          if(ink(rgb(sx,sy))) {
            run++;maxRun=Math.max(maxRun,run);
            if(paper(rgb(sx+ux*Math.max(2,minorPx*.35),sy+uy*Math.max(2,minorPx*.35))) && paper(rgb(sx-ux*Math.max(2,minorPx*.35),sy-uy*Math.max(2,minorPx*.35)))) paperSides++;
          } else run=0;
        }
        if(maxRun>=Math.max(4,minorPx*.35) && paperSides>=3) return true;
      }
    }
    return false;
  }
  if (!ordered.every(t=>strokeAt(t.x*width,t.y*height))) return false;
  let matching=0;
  for(let i=0;i<=minorCount;i++) if(strokeAt(a.x*width+ux*minorPx*i,a.y*height+uy*minorPx*i)) matching++;
  // Printed millimetre ticks must exist at the predicted spacing, beyond the AI's three guesses.
  return matching/(minorCount+1)>=.8;
}

function loadImage(dataUrl) {
  return new Promise((resolve,reject) => { const img=new Image(); img.onload=()=>resolve(img); img.onerror=()=>reject(new Error('자 인식용 사진을 열지 못했습니다.')); img.src=dataUrl; });
}

function jpeg(canvas) {
  for (const quality of [.92,.85,.75,.65]) {
    const url=canvas.toDataURL('image/jpeg',quality);
    if (url.length < 3_900_000) return url;
  }
  throw new Error('자 인식용 사진 용량이 너무 큽니다.');
}

export async function prepareRulerImage(photo, {maxDim=Infinity, encode=true}={}) {
  const img=await loadImage(photo.dataUrl);
  const full=document.createElement('canvas'); full.width=photo.w; full.height=photo.h;
  const ctx=full.getContext('2d',{willReadFrequently:true}); ctx.drawImage(img,0,0,full.width,full.height);
  const rect=findContentRect(ctx.getImageData(0,0,full.width,full.height).data,full.width,full.height);
  const ratio=Math.min(1,maxDim/Math.max(rect.w,rect.h));
  const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(rect.w*ratio)); canvas.height=Math.max(1,Math.round(rect.h*ratio));
  canvas.getContext('2d').drawImage(full,rect.x,rect.y,rect.w,rect.h,0,0,canvas.width,canvas.height);
  return {dataUrl:encode?jpeg(canvas):null,w:canvas.width,h:canvas.height,rect,canvas,photoWidth:photo.w,photoHeight:photo.h};
}

export function zoomRulerImage(prepared, box) {
  const margin=.025;
  const x=Math.max(0,Math.floor((box.xMin-margin)*prepared.w)), y=Math.max(0,Math.floor((box.yMin-margin)*prepared.h));
  const w=Math.min(prepared.w-x,Math.ceil((box.xMax+margin)*prepared.w)-x);
  const h=Math.min(prepared.h-y,Math.ceil((box.yMax+margin)*prepared.h)-y);
  const zoom=Math.min(3,1600/Math.max(w,h));
  const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(w*zoom)); canvas.height=Math.max(1,Math.round(h*zoom));
  canvas.getContext('2d').drawImage(prepared.canvas,x,y,w,h,0,0,canvas.width,canvas.height);
  return {dataUrl:jpeg(canvas),w:canvas.width,h:canvas.height,canvas,rect:{x:prepared.rect.x+x,y:prepared.rect.y+y,w,h},photoWidth:prepared.photoWidth,photoHeight:prepared.photoHeight};
}

export const RULER_PROMPT = `상처 사정이 아니라 사진 속 자의 인쇄 숫자·단위·눈금만 읽으세요. 상처 경계·상처 크기는 절대 추정하지 마세요.
CM와 INCHES가 함께 있으면 CM 눈금 줄을 우선 선택하세요. 두 줄의 숫자/눈금을 섞지 마세요. cm가 없을 때만 mm 또는 명시된 inch 줄을 사용하세요.
숫자 중심이 아니라 해당 숫자가 가리키는 긴 눈금이 자 바깥쪽 가장자리와 만나는 같은 위치를 좌표로 사용하세요. 최소 3개의 인쇄된 숫자와 각각의 실제 눈금을 읽으세요. 기울어진 자는 기울기 그대로 처리하고, 손가락으로 가려지지 않은 숫자 구간을 선택하세요. 0이 가려져도 1,2,3 등 보이는 숫자 구간을 사용하세요. 반드시 1cm 한 구간만 고집하지 말고 확인 가능한 여러 cm 구간을 사용하세요.
숫자·단위를 확실히 읽지 못하면 readable=false로 하고 ticks=[]로 하세요. 존재 여부(scaleVisible)와 읽기 실패(readable)는 구분하세요. unitLabel에는 실제로 인쇄된 단위 문자열(CM, MM, INCHES)을 적으세요. cm/mm/inch를 임의 추정하지 마세요.
사진에서 자 전체의 위치(단위 표시 포함)를 rulerBox에 기록하세요. 좌표는 이 첨부 이미지 기준 좌상단(0,0), 우하단(1,1)의 비율입니다.
JSON만 출력: {"scaleVisible":boolean,"readable":boolean,"unit":"cm"|"mm"|"inch"|null,"unitLabel":string|null,"ticks":[{"value":number,"x":number,"y":number}],"rulerBox":{"xMin":number,"yMin":number,"xMax":number,"yMax":number}|null,"note":string}`;
