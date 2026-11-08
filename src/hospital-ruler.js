// Local detector for the hospital's blue-on-white, dual CM / 1/16-inch ruler.
// No wound boundaries, cloud calls, or assumed physical ruler width.
const median=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)];};
function components(p,w,h) {
  const mask=new Uint8Array(w*h),q=new Int32Array(w*h);
  for(let i=0;i<w*h;i++) {const r=p[i*4],g=p[i*4+1],b=p[i*4+2]; if(b-r>24&&b-g>6&&b>r*1.2&&r<200&&b<g*1.95) mask[i]=1;}
  const ink=mask.slice(),out=[];
  for(let i=0;i<mask.length;i++) {
    if(!mask[i])continue; let head=0,tail=1,n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0; const indexes=[];q[0]=i;mask[i]=0;
    while(head<tail) {
      const j=q[head++],x=j%w,y=Math.floor(j/w);n++;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;if(n<=4000)indexes.push(j);
      for(const d of [-w-1,-w,-w+1,-1,1,w-1,w,w+1]) {const k=j+d;if(k>=0&&k<mask.length&&Math.abs(k%w-x)<=1&&mask[k]){mask[k]=0;q[tail++]=k;}}
    }
    if(n<3)continue; const x=sx/n,y=sy/n,xx=sxx/n-x*x,yy=syy/n-y*y,xy=sxy/n-x*y;
    const diff=Math.hypot(xx-yy,2*xy),angle=.5*Math.atan2(2*xy,xx-yy);
    out.push({n,x,y,angle,length:Math.sqrt(Math.max(0,(xx+yy+diff)*6)),thin:Math.sqrt(Math.max(0,(xx+yy-diff)*6)),indexes:n<=4000?indexes:[]});
  }
  return {out,ink};
}

function fitGrid(points) {
  if(points.length<12)return null;
  const sorted=[...points].sort((a,b)=>a.u-b.u);
  const gaps=sorted.slice(1).map((p,i)=>p.u-sorted[i].u).filter(d=>d>2);
  if(gaps.length<10)return null;
  const low=median([...gaps].sort((a,b)=>a-b).slice(0,Math.ceil(gaps.length*.6)));
  const near=gaps.filter(d=>d>low*.7&&d<low*1.3);
  let pitch=median(near); if(!Number.isFinite(pitch)||pitch<3||pitch>40)return null;
  let k=0;
  let indexed=[{...sorted[0],k}];
  for(let i=1;i<sorted.length;i++) {
    const gap=sorted[i].u-indexed.at(-1).u;
    const steps=Math.round(gap/pitch);
    if(steps<1 || Math.abs(gap/steps-pitch)>pitch*.28)continue;
    k+=steps; indexed.push({...sorted[i],k});
  }
  if(indexed.length<12)return null;
  const span=indexed.at(-1).k-indexed[0].k;
  if(span<18 || indexed.length/(span+1)<.55)return null;
  // Fit the printed edge independently, allowing a tilted photograph.
  const mu=indexed.reduce((a,p)=>a+p.u,0)/indexed.length,mv=indexed.reduce((a,p)=>a+p.v,0)/indexed.length;
  const denom=indexed.reduce((a,p)=>a+(p.u-mu)**2,0);
  const slope=indexed.reduce((a,p)=>a+(p.u-mu)*(p.v-mv),0)/denom;
  const intercept=mv-slope*mu;
  const residual=median(indexed.map(p=>Math.abs(p.v-slope*p.u-intercept)));
  if(residual>Math.max(2,pitch*.4))return null;
  return {points:indexed,pitch,slope,intercept,span,residual};
}

function detectCore(p,w,h,{debug=false}={}) {
  if(!p||p.length!==w*h*4)return null;
  const {out,ink}=components(p,w,h);
  const baselines=out.filter(c=>c.n>150&&c.length>Math.min(w,h)*.18&&c.length/Math.max(1,c.thin)>7).sort((a,b)=>b.length-a.length).slice(0,6);
  const candidates=[];
  for(const baseline of baselines) {
    const theta=baseline.angle,ux=Math.cos(theta),uy=Math.sin(theta),nx=-uy,ny=ux;
    const strokes=out.filter(c=>c.n<=500&&c.length>=2.3&&c.length<Math.min(w,h)*.08&&c.length/Math.max(1,c.thin)>1.7&&c.thin<7&&Math.abs(Math.cos(c.angle-theta))<.34);
    const ends=[];
    for(const c of strokes) {
      let lo=Infinity,hi=-Infinity,lp=null,hp=null;
      for(const i of c.indexes) {const x=i%w,y=Math.floor(i/w),v=x*nx+y*ny;if(v<lo){lo=v;lp={x,y};}if(v>hi){hi=v;hp={x,y};}}
      for(const [point,v,sign] of [[lp,lo,1],[hp,hi,-1]]) if(point)ends.push({...point,u:point.x*ux+point.y*uy,v,sign,length:c.length});
    }
    for(const sign of [1,-1]) {
      const edge=ends.filter(p=>p.sign===sign).sort((a,b)=>a.v-b.v);
      const seen=new Set();
      for(const seed of edge) {
        const tolerance=Math.max(3,Math.min(12,median(strokes.map(c=>c.length))*.5));
        const group=edge.filter(e=>Math.abs(e.v-seed.v)<tolerance);
        const grid=fitGrid(group);if(!grid)continue;
        const key=Math.round(grid.intercept/5)+':'+Math.round(grid.pitch*2);
        if(seen.has(key))continue; seen.add(key);
        candidates.push({...grid,theta,ux,uy,nx,ny,sign});
      }
    }
  }
  const pairs=[];
  for(const a of candidates)for(const b of candidates) {
    if(b.pitch<=a.pitch || Math.abs(Math.sin(a.theta-b.theta))>.1)continue;
    const ratio=b.pitch/a.pitch;
    if(Math.abs(ratio-1.5875)> .18)continue;
    const middle=(a.points[0].u+a.points.at(-1).u)/2;
    const separation=Math.abs((a.slope*middle+a.intercept)-(b.slope*middle+b.intercept));
    if(separation<a.pitch*4||separation>a.pitch*35)continue;
    const overlap=Math.min(a.points.at(-1).u,b.points.at(-1).u)-Math.max(a.points[0].u,b.points[0].u);
    if(overlap<a.pitch*18)continue;
    // Either end of a short printed stroke may survive blur; verify the actual grid below.

    pairs.push({a,b,score:a.points.length+b.points.length-20*Math.abs(ratio-1.5875)});
  }
  pairs.sort((a,b)=>b.score-a.score);
  if(debug) return {candidates:candidates.map(c=>({pitch:c.pitch,n:c.points.length,span:c.span,edge:c.intercept,angle:c.theta*180/Math.PI,sign:c.sign})),pairs:pairs.map(p=>({metric:p.a.pitch,inch:p.b.pitch,score:p.score}))};
  if(!pairs.length)return null;
  for(const {a,b} of pairs) {
    // Scan the outside edge so connected major marks are counted too.
    const hits=[]; const first=a.points[0].u,last=a.points.at(-1).u;
    for(let u=first;u<=last;u+=.5) {
      let found=false;
      for(let depth=1;depth<=4;depth++) {
        const v=a.slope*u+a.intercept+a.sign*depth;
        const x=Math.round(u*a.ux+v*a.nx),y=Math.round(u*a.uy+v*a.ny);
        if(x>=0&&x<w&&y>=0&&y<h&&ink[y*w+x])found=true;
      }
      if(found)hits.push(u);
    }
    const runs=[];
    for(const u of hits) {if(!runs.length||u-runs.at(-1).last>1.5)runs.push({first:u,last:u});else runs.at(-1).last=u;}
    const peaks=runs.filter(r=>r.last-r.first<a.pitch*.65).map(r=>(r.first+r.last)/2);
    const spans=[];
    for(let i=0;i+10<peaks.length;i++) {
      const seq=peaks.slice(i,i+11),gaps=seq.slice(1).map((u,j)=>u-seq[j]),mean=(seq[10]-seq[0])/10;
      if(gaps.every(g=>g>mean*.65&&g<mean*1.35)&&mean>a.pitch*.8&&mean<a.pitch*1.2)spans.push(seq);
    }
    if(!spans.length)continue;
    const seq=spans[Math.floor(spans.length/2)];
    const point=u=>{const v=a.slope*u+a.intercept;return {x:u*a.ux+v*a.nx,y:u*a.uy+v*a.ny};};
    const t=point(seq[0]),end=point(seq[10]);
  const p1={x:t.x/w,y:t.y/h},p2={x:end.x/w,y:end.y/h};
  return {p1,p2,cm:1,note:'연속된 눈금 10칸을 찾았습니다. 한 칸이 1mm인지 확인하고, 표시된 두 점이 실제 1cm 간격과 일치하는지 확인해주세요.',method:'local-hospital-ruler',evidence:{metricPitch:a.pitch,inchPitch:b.pitch,metricTicks:a.points.length,inchTicks:b.points.length,ratio:b.pitch/a.pitch,observedIntervals:10}};
  }
  return null;
}


export function detectHospitalRuler(p,w,h,options={}) {
  const direct=detectCore(p,w,h,options);
  if(direct || options.debug || !p || p.length!==w*h*4)return direct;
  // Retry quarter-turn sampling orientations without relaxing grid verification.
  let data=p,rw=w,rh=h;const prior=[];
  for(let turn=1;turn<=3;turn++) {
    const rotated=new Uint8Array(data.length);
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++) {
      const from=(y*rw+x)*4,to=(x*rh+rh-1-y)*4;
      rotated[to]=data[from];rotated[to+1]=data[from+1];rotated[to+2]=data[from+2];rotated[to+3]=data[from+3];
    }
    prior.push({w:rw,h:rh});data=rotated;[rw,rh]=[rh,rw];
    const result=detectCore(data,rw,rh);
    if(result) {
      const back=point=>{let q=point;for(let i=prior.length-1;i>=0;i--)q={x:q.y,y:1-1/prior[i].h-q.x};return q;};
      return {...result,p1:back(result.p1),p2:back(result.p2)};
    }
  }
  return null;
}
