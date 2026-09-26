import {S,$} from './state.js';
import {tmin,total,now,moveHead,mark,loopSpan,start} from './audio-engine.js';
import {modified,setMark,createWordAt,editBarWord,pushWord,scheduleWordPlay,render,buildWords} from './words.js';
import {freqToY} from './spectrogram.js';

const MARGIN=0.35;                    // seconds of context shown either side of the word
const ov=document.getElementById('ov'),og=ov.getContext('2d');
const wave=document.getElementById('wave'),wg=wave.getContext('2d');
const zm=document.getElementById('zm'),zg=zm.getContext('2d');

// ---- aligner lanes -------------------------------------------------------------------
// Every aligner's own word boundaries for this clip, each in its own thin lane under your
// marks, so where each one disagrees with you -- and with each other -- is visible directly
// instead of only as a number on the eval page. Which lanes are on is remembered per browser.
const ALN_COLORS={mms:'#4ec98a','ivrit-ai':'#d8a13a','whisper-stable-ts':'#c678dd',
  'wav2vec2-hebrew':'#e06c6c','mwa-buckeye':'#56b6c2'};
const ALN_FALLBACK=['#e5c07b','#61afef','#98c379','#be5046','#abb2bf'];
function alnColor(src,i){ return ALN_COLORS[src]||ALN_FALLBACK[i%ALN_FALLBACK.length]; }
function saveAln(){ try{ localStorage.setItem('alnShown',JSON.stringify([...S.alnShown])); }catch(e){} }

function clipLabels(){
  const d=(S.currentClipDetail&&S.currentClipDetail.labels)?S.currentClipDetail:(S.clips&&S.clips[S.ci]);
  return (d&&d.labels)||[];
}
// Rebuilt only when the set of aligners changes, so it can be called from draw() cheaply.
function renderAlnToggles(){
  const labels=clipLabels();
  const sig=labels.map(l=>l.source).join('|');
  if(sig===S.alnSig) return;
  S.alnSig=sig;
  if(S.alnForceAll){ labels.forEach(l=>S.alnShown.add(l.source)); S.alnForceAll=false; saveAln(); }
  $('alnBar').hidden=!labels.length;
  $('alnToggles').innerHTML=labels.map((l,i)=>'<label class="alnT"><input type="checkbox" data-src="'
    +l.source+'"'+(S.alnShown.has(l.source)?' checked':'')+'><i class="alnSw" style="background:'
    +alnColor(l.source,i)+'"></i>'+l.source+'</label>').join('');
  $('alnToggles').querySelectorAll('input').forEach(cb=>{
    cb.onchange=()=>{ cb.checked?S.alnShown.add(cb.dataset.src):S.alnShown.delete(cb.dataset.src); saveAln(); draw(); };
  });
  renderAlnMainSelect(labels);
}
function setAllAln(on){
  clipLabels().forEach(l=>on?S.alnShown.add(l.source):S.alnShown.delete(l.source));
  saveAln(); S.alnSig=null; renderAlnToggles(); draw();
}

// The "playback uses" dropdown: golden marks by default, or any aligner lane, so a model's
// own timings can actually be listened to and stepped through instead of read off the
// picture only. Rebuilt alongside the toggles since it lists the same aligners.
function renderAlnMainSelect(labels){
  const sel=$('alnMainSelect');
  if(!sel) return;
  const opts=['<option value="">golden marks</option>']
    .concat(labels.map(l=>'<option value="'+l.source+'">'+l.source+'</option>'));
  sel.innerHTML=opts.join('');
  sel.value=S.alnMain||'';
  sel.onchange=()=>setMainAln(sel.value||null);
}

// Swap which timings actually drive the word list: playback, stepping, editing, all of it.
// The aligner lanes are otherwise a picture only -- this is what makes the dropdown useful
// for actually listening to where a model thinks a word starts and ends. Picking "golden
// marks" again puts back whatever S.gold held right before the switch.
// Read-only only: swapping S.gold mid-edit would risk a real tagging save pushing an
// aligner's own output back out as if it were a human mark.
function setMainAln(source){
  if(!S.isReadOnly) return;
  if(!source){
    S.alnMain=null;
    if(S.alnMainGolden){ S.gold=S.alnMainGolden.map(w=>({...w})); S.alnMainGolden=null; }
  }else{
    const lane=clipLabels().find(l=>l.source===source);
    if(!lane||!lane.words||!lane.words.length) return;
    if(!S.alnMainGolden) S.alnMainGolden=S.gold.map(w=>({...w}));
    S.alnMain=source;
    S.gold=lane.words.map(w=>({word:w.word,start:w.start,end:w.end}));
  }
  S.touched=new Set();
  S.wi=Math.min(S.wi,S.gold.length-1);
  if(S.wi<0) S.wi=0;
  S.edge='end';
  fitWord();
  buildWords();
  render();
  draw();
}

// Paint the enabled lanes into the band [y0, y1) of a canvas, using its own time->x map.
function paintAlnLanes(g,X,y0,y1,w,withNames){
  const lanes=clipLabels().map((l,i)=>({l,i})).filter(o=>S.alnShown.has(o.l.source));
  if(!lanes.length) return;
  const laneH=(y1-y0)/lanes.length;
  lanes.forEach(({l,i},k)=>{
    const col=alnColor(l.source,i), top=y0+k*laneH, bh=Math.max(2,laneH-2);
    g.globalAlpha=.55; g.fillStyle=col;
    l.words.forEach(wd=>{ const a=X(wd.start), b=X(wd.end); if(b<0||a>w) return;
      g.fillRect(a,top,Math.max(1,b-a),bh); });
    g.globalAlpha=1;
    // bright ticks at every boundary, so start and end read exactly
    l.words.forEach(wd=>{ [wd.start,wd.end].forEach(t=>{ const x=X(t); if(x>=0&&x<=w) g.fillRect(Math.round(x),top,1,bh); }); });
    if(withNames&&laneH>=8){
      g.font='10px system-ui,sans-serif'; g.textBaseline='middle';
      const tw=g.measureText(l.source).width+8;
      g.fillStyle='rgba(20,22,26,.85)'; g.fillRect(w-tw-2,top,tw,bh);
      g.fillStyle=col; g.fillText(l.source,w-tw+2,top+bh/2);
    }
  });
  g.globalAlpha=1;
}

function buildPeaks(w){
  const d=S.buf.getChannelData(0),n=d.length; S.peaks=new Float32Array(w*2);
  for(let x=0;x<w;x++){let lo=1,hi=-1;const s=Math.floor(x*n/w),e=Math.floor((x+1)*n/w);
    for(let i=s;i<e;i++){const v=d[i];if(v<lo)lo=v;if(v>hi)hi=v;}
    S.peaks[x*2]=lo;S.peaks[x*2+1]=hi;}
}

function drawOverview(){
  const w=ov.clientWidth,h=90; ov.width=w*devicePixelRatio; ov.height=h*devicePixelRatio;
  og.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); og.clearRect(0,0,w,h);
  if(!S.buf)return;
  if(!S.peaks||S.peaks.length!==w*2) buildPeaks(w);
  const dur=S.buf.duration, X=t=>(t+S.lead)/dur*w;
  renderAlnToggles();
  paintAlnLanes(og,X,h*.80,h,w,false);
  S.gold.forEach((wd,i)=>{ og.fillStyle=(i===S.wi)?'rgba(61,111,214,.30)':'rgba(255,255,255,.03)';
    og.fillRect(X(wd.start),0,Math.max(1,X(wd.end)-X(wd.start)),h); });
  og.fillStyle='#2f3540';
  for(let x=0;x<w;x++){const lo=S.peaks[x*2],hi=S.peaks[x*2+1];
    og.fillRect(x,h/2+lo*h/2.2,1,Math.max(1,(hi-lo)*h/2.2));}
  // Snap points (green lines) drawn under word marks
  if(S.snapShow&&S.snapPoints&&S.snapPoints.length){
    og.fillStyle='rgba(134,239,172,.65)';
    S.snapPoints.forEach(t=>{ og.fillRect(Math.round(X(t)),h*.08,1,h*.84); });
  }
  // Non-active marks (grey)
  S.gold.forEach((wd,i)=>{
    if(i!==S.wi){ og.fillStyle='#48505e'; og.fillRect(Math.round(X(wd.end)),0,1,h); }
  });
  // Active mark (blue) - on top of green lines and grey marks
  if(S.gold[S.wi]){ og.fillStyle='#6aa0ff'; og.fillRect(Math.round(X(S.gold[S.wi].end)),0,1,h); }
  og.fillStyle='#ff5f56'; og.fillRect(X(now()),h*.15,2,h*.7);
}
// the zoom window always contains the WHOLE current word, so start and end are both reachable
// The zoom window is explicit state, not a function of the word, so it can be dragged and
// zoomed. It is refitted to the word whenever the word or clip changes, and nudged along by
// ensureVisible when a mark is dragged past its edge.
let dragging=false;
let createDrag=null;   // {s,e} in-progress Ctrl+drag "create new word" span, in app time
function fitWord(){
  if(!S.gold||!S.gold.length||!S.gold[S.wi]){ S.view=[tmin(), Math.max(tmin()+0.12, total())]; return; }
  S.view=[Math.max(tmin(),S.gold[S.wi].start-MARGIN), Math.min(total(),S.gold[S.wi].end+MARGIN)];
  if(S.view[1]-S.view[0]<0.12) S.view[1]=S.view[0]+0.12;
}
function zwin(){ if(!S.view) fitWord(); return S.view || [tmin(), Math.max(tmin()+0.12, total())]; }
function panBy(dt){
  const [lo,hi]=S.view, span=hi-lo;
  let a=lo+dt, b=hi+dt;
  if(a<tmin()){a=tmin();b=a+span;}
  if(b>total()){b=total();a=b-span;}
  S.view=[a,b]; draw();
}
function zoomAt(t,f){
  const [lo,hi]=S.view; let span=(hi-lo)*f;
  span=Math.max(0.06,Math.min(span,total()-tmin()));
  const frac=(t-lo)/(hi-lo);
  let a=t-frac*span, b=a+span;
  if(a<tmin()){a=tmin();b=a+span;}
  if(b>total()){b=total();a=Math.max(tmin(),b-span);}
  S.view=[a,b]; draw();
}
function ensureVisible(t){
  // Never while a mark is being dragged. Panning there moves the window that the pointer
  // position is converted through, so the mark chases its own new coordinates and sticks.
  // During a drag only the edge timer pans, by a fixed step that does not depend on the
  // pointer, which cannot feed back.
  if(dragging) return;
  const [lo,hi]=S.view, pad=(hi-lo)*0.12;
  if(t<lo+pad) panBy(t-(lo+pad)); else if(t>hi-pad) panBy(t-(hi-pad));
}

function drawWave(){
  const w=wave.clientWidth||800, h=wave.clientHeight||85;
  wave.width=w*devicePixelRatio; wave.height=h*devicePixelRatio;
  wg.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  wg.clearRect(0,0,w,h);
  if(!S.buf) return;
  const [lo,hi]=zwin(), X=t=>(t-lo)/(hi-lo)*w;

  // word span backgrounds
  S.gold.forEach((wd,i)=>{
    wg.fillStyle=(i===S.wi)?'rgba(61,111,214,.18)'
      : modified(i)?'rgba(78,201,138,.07)':'rgba(255,255,255,.035)';
    wg.fillRect(X(wd.start),0,Math.max(1,X(wd.end)-X(wd.start)),h);
  });

  // waveform samples
  const d=S.buf.getChannelData(0), sr=S.buf.sampleRate;
  wg.fillStyle='#70b5ff';
  for(let x=0; x<w; x++){
    const a=lo+(x/w)*(hi-lo), b=lo+((x+1)/w)*(hi-lo);
    const s=Math.floor((a+S.lead)*sr), e=Math.floor((b+S.lead)*sr);
    let mn=1, mx=-1, any=false;
    for(let i=Math.max(0,s); i<Math.min(d.length,e); i++){
      const v=d[i]; if(v<mn) mn=v; if(v>mx) mx=v; any=true;
    }
    if(any) wg.fillRect(x, h/2+mn*h/2.3, 1, Math.max(1, (mx-mn)*h/2.3));
  }

  // snap points (green lines) - drawn under word marks, lighter green
  if(S.snapShow&&S.snapPoints&&S.snapPoints.length){
    wg.fillStyle='#86efac';
    S.snapPoints.forEach(t=>{
      if(t>=lo&&t<=hi) wg.fillRect(Math.round(X(t)),0,1,h);
    });
  }

  // non-active word marks (grey) - on top of green lines
  S.gold.forEach((wd,i)=>{
    if(i===S.wi) return;
    [['start',wd.start],['end',wd.end]].forEach(([which,t])=>{
      if(X(t)<-4||X(t)>w+4) return;
      wg.fillStyle='#4a5872';
      wg.fillRect(Math.round(X(t)),0,1,h);
    });
  });

  // active word marks (blue) - on top of green lines and grey marks
  if(S.gold[S.wi]){
    const wd=S.gold[S.wi];
    [['start',wd.start],['end',wd.end]].forEach(([which,t])=>{
      if(X(t)<-4||X(t)>w+4) return;
      const on=(which===S.edge);
      wg.fillStyle='#6aa0ff';
      wg.fillRect(X(t)-(on?2:0),0,on?4:2,h);
    });
  }

  // in-progress Ctrl+drag "create word" span
  if(createDrag){
    const x0=X(createDrag.s), x1=X(createDrag.e);
    wg.fillStyle='rgba(78,201,138,.28)';
    wg.fillRect(Math.min(x0,x1),0,Math.max(1,Math.abs(x1-x0)),h);
    wg.strokeStyle='#4ec98a'; wg.lineWidth=1;
    wg.strokeRect(Math.min(x0,x1)+0.5,0.5,Math.max(1,Math.abs(x1-x0))-1,h-1);
  }

  // playhead visible ONLY in top 20% of the bar
  const p=now();
  if(p>=lo&&p<=hi){
    wg.fillStyle='#ff5f56';
    wg.fillRect(X(p)-1,0,2,h*0.20);
  }

  // corner badge
  wg.font='10px system-ui,sans-serif';
  wg.fillStyle='rgba(255,255,255,0.4)';
  wg.textAlign='right';
  wg.fillText('waveform', w-8, 12);
  wg.textAlign='left';
}

function drawZoom(){
  const w=zm.clientWidth||800, h=zm.clientHeight||215;
  zm.width=w*devicePixelRatio; zm.height=h*devicePixelRatio;
  zg.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  zg.clearRect(0,0,w,h);
  if(!S.buf) return;
  const [lo,hi]=zwin(), X=t=>(t-lo)/(hi-lo)*w;

  // 1. Mel spectrogram
  if(S.specCanvas){
    const dur=S.buf.duration;
    const maxF=Math.max(1,S.specCanvas.width-1);
    const tStart=Math.max(-S.lead,lo), tEnd=Math.min(dur-S.lead,hi);
    if(tEnd>tStart){
      const sx0=((tStart+S.lead)/dur)*maxF;
      const sx1=((tEnd+S.lead)/dur)*maxF;
      const dx0=X(tStart);
      const dx1=X(tEnd);
      zg.imageSmoothingEnabled=true;
      zg.drawImage(S.specCanvas,sx0,0,Math.max(0.001,sx1-sx0),S.specCanvas.height,
                   dx0,0,Math.max(0.001,dx1-dx0),h);
    }
  }

  // 2. Word span backgrounds (mid 40% of the bar) with top/bottom 1px 50% white borders
  const yTop = h * 0.30, hSpan = h * 0.40;
  S.gold.forEach((wd,i)=>{
    const x0 = X(wd.start), wSpan = Math.max(1, X(wd.end) - x0);
    zg.fillStyle = (i===S.wi)?'rgba(61,111,214,.38)'
      : modified(i)?'rgba(78,201,138,.24)':'rgba(255,255,255,.20)';
    zg.fillRect(x0, yTop, wSpan, hSpan);
    zg.fillStyle = 'rgba(255,255,255,0.5)';
    zg.fillRect(x0, yTop, wSpan, 1);
    zg.fillRect(x0, yTop + hSpan - 1, wSpan, 1);
  });

  // 2b. In-progress Ctrl+drag "create word" span
  if(createDrag){
    const x0=X(createDrag.s), x1=X(createDrag.e);
    zg.fillStyle='rgba(78,201,138,.28)';
    zg.fillRect(Math.min(x0,x1),0,Math.max(1,Math.abs(x1-x0)),h);
    zg.strokeStyle='#4ec98a'; zg.lineWidth=1;
    zg.strokeRect(Math.min(x0,x1)+0.5,0.5,Math.max(1,Math.abs(x1-x0))-1,h-1);
  }

  // 2c. Aligner lanes, below your marks and above the time ticks
  paintAlnLanes(zg,X,h*0.72,h-12,w,true);

  // 3. Time ticks at bottom
  zg.fillStyle='#2b303a';
  for(let t=Math.ceil(lo*10)/10; t<hi; t+=0.1) zg.fillRect(X(t),h-10,1,10);

  // 4. Frequency grid lines and labels on the left
  const maxHz=(S.specCanvas&&S.specCanvas.maxHz)||5000;
  const guideFreqs = maxHz >= 4500 ? [3000, 2000, 1000, 500] : [maxHz * 0.75, maxHz * 0.5, maxHz * 0.25];
  zg.setLineDash([2,4]);
  zg.strokeStyle='rgba(255,255,255,0.14)';
  zg.lineWidth=1;
  guideFreqs.forEach(f => {
    const y = freqToY(f, h, maxHz);
    zg.beginPath(); zg.moveTo(28, y); zg.lineTo(w, y); zg.stroke();
  });
  zg.setLineDash([]);

  zg.font='9px system-ui,sans-serif';
  zg.fillStyle='rgba(255,255,255,0.7)';
  zg.shadowColor='rgba(0,0,0,0.85)';
  zg.shadowBlur=3;
  guideFreqs.forEach(f => {
    const y = freqToY(f, h, maxHz);
    const lbl = f >= 1000 ? (f / 1000) + 'k' : f + '';
    zg.fillText(lbl, 3, y + 3);
  });
  zg.fillText((maxHz / 1000).toFixed(maxHz % 1000 ? 1 : 0) + ' kHz', 3, 10);
  zg.fillText('0 Hz', 3, h - 3);

  // 5. Snap points (green lines) - 50% high from the bottom, 50% transparent
  if(S.snapShow&&S.snapPoints&&S.snapPoints.length){
    zg.fillStyle='#86efac';
    S.snapPoints.forEach(t=>{
      if(t>=lo&&t<=hi) zg.fillRect(Math.round(X(t)),h*0.70,1,h*0.30);
    });
  }

  // 6. Non-active word marks (grey) - overlay height (mid 40% centered)
  S.gold.forEach((wd,i)=>{
    if(i===S.wi) return;
    [['start',wd.start],['end',wd.end]].forEach(([which,t])=>{
      if(X(t)<-4||X(t)>w+4) return;
      zg.fillStyle='#4a5872';
      zg.fillRect(Math.round(X(t)),yTop,1,hSpan);
    });
  });

  // 7. Active word marks (blue) - overlay height (mid 40% centered)
  if(S.gold[S.wi]){
    const wd=S.gold[S.wi];
    [['start',wd.start],['end',wd.end]].forEach(([which,t])=>{
      if(X(t)<-4||X(t)>w+4) return;
      const on=(which===S.edge);
      zg.fillStyle='#6aa0ff';
      zg.fillRect(X(t)-(on?2:0),yTop,on?4:2,hSpan);
    });
  }

  // 8. Word text labels - white with shadow, centered vertically and horizontally in the word segment
  zg.shadowColor='rgba(0,0,0,0.85)';
  zg.shadowBlur=3;
  zg.textAlign='center';
  zg.textBaseline='middle';
  S.gold.forEach((wd,i)=>{
    const cur=(i===S.wi);
    const mid=(X(wd.start)+X(wd.end))/2;
    if(mid>-40&&mid<w+40){
      zg.font=(cur?'bold 13px':'normal 12px')+' system-ui';
      zg.fillStyle='#ffffff';
      zg.fillText(wd.word,mid,h*0.50);
    }
  });
  zg.textBaseline='alphabetic';

  // 9. Active edge label (START / END)
  zg.font='bold 11px system-ui';
  zg.fillStyle='#cfe0ff';
  zg.fillText(S.edge.toUpperCase(),X(S.edge==='end'?S.gold[S.wi].end:S.gold[S.wi].start)
    +(S.edge==='start'?6:-34),h-16);
  zg.textAlign='left';
  zg.shadowColor='transparent';
  zg.shadowBlur=0;

  // 8. Playhead visible ONLY in top 20% of the bar
  const p=now();
  if(p>=lo&&p<=hi){
    zg.fillStyle='#ff5f56';
    zg.fillRect(X(p)-1,0,2,h*0.20);
  }

  // Top-right readout
  zg.textAlign='right';
  zg.font='10px system-ui,sans-serif';
  zg.fillStyle='rgba(255,255,255,0.55)';
  zg.fillText('0–' + Math.round(maxHz) + ' Hz mel-spec' + (S.snapShow && S.snapPoints.length ? ' (' + S.snapPoints.length + ' snaps)' : ''), w - 8, 12);
  zg.textAlign='left';
  zg.shadowColor='transparent';
  zg.shadowBlur=0;

  $('zlab').firstChild.textContent='current word "'+S.gold[S.wi].word+'"  —  editing the '
    +S.edge.toUpperCase()+'   (ticks 100 ms)   ';
}
function drawScroll(){
  const lo=tmin(), hi=total(), span=hi-lo;
  const [a,b]=zwin(), el=$('scroll'), th=$('thumb');
  th.style.left=((a-lo)/span*100)+'%';
  th.style.width=Math.max(2,(b-a)/span*100)+'%';
}
function draw(){ drawOverview(); drawWave(); drawZoom(); drawScroll(); }

// ---- pointer -------------------------------------------------------------
ov.onmousedown=e=>{
  const r=ov.getBoundingClientRect();
  const at=x=>(x-r.left)/r.width*S.buf.duration-S.lead;
  moveHead(at(e.clientX));
  const mv=ev=>moveHead(at(ev.clientX));          // drag to scrub
  const up=()=>{removeEventListener('mousemove',mv);removeEventListener('mouseup',up);};
  addEventListener('mousemove',mv); addEventListener('mouseup',up);
};
function attachZoomEvents(canvas){
  canvas.onmousedown=e=>{
    const r=canvas.getBoundingClientRect();
    const at=x=>{const [lo,hi]=zwin(); return lo+((x-r.left)/r.width)*(hi-lo);};
    const px=t=>{const [lo,hi]=zwin(); return (t-lo)/(hi-lo)*r.width+r.left;};

    // Ctrl/Cmd+drag over a stretch with no existing word draws out a brand new one. The
    // drag is clamped to the surrounding silence so it can never eat into a neighbour.
    if((e.ctrlKey||e.metaKey)&&S.buf){
      const t0=at(e.clientX);
      const overlapsWord=S.gold.some(wd=>t0>wd.start-1e-6&&t0<wd.end+1e-6);
      if(!overlapsWord){
        e.preventDefault();
        let glo=tmin(), ghi=total();
        S.gold.forEach(wd=>{
          if(wd.end<=t0+1e-9&&wd.end>glo) glo=wd.end;
          if(wd.start>=t0-1e-9&&wd.start<ghi) ghi=wd.start;
        });
        let a=t0,b=t0;
        createDrag={s:a,e:b}; draw();
        canvas.classList.add('grabbing');
        const mv=ev=>{
          b=Math.max(glo,Math.min(at(ev.clientX),ghi));
          createDrag={s:Math.min(a,b),e:Math.max(a,b)};
          draw();
        };
        const up=()=>{
          canvas.classList.remove('grabbing');
          removeEventListener('mousemove',mv); removeEventListener('mouseup',up);
          const MIN_LEN=0.02;
          let s=createDrag.s, en=createDrag.e;
          createDrag=null;
          if(en-s<MIN_LEN){ en=Math.min(ghi,s+MIN_LEN); if(en-s<MIN_LEN) s=Math.max(glo,en-MIN_LEN); }
          if(en-s<0.005){ draw(); return; }
          createWordAt(s,en);
        };
        addEventListener('mousemove',mv); addEventListener('mouseup',up);
        return;
      }
    }

    // Playhead is grabbable ONLY in top 20% of the bar; remaining 80% left for interactions
    const inPlayheadZone=e.clientY<=r.top+r.height*0.20;
    if(Math.abs(px(now())-e.clientX)<9 && inPlayheadZone){
      canvas.classList.add('grabbing');
      const mv=ev=>moveHead(at(ev.clientX));
      const up=()=>{canvas.classList.remove('grabbing');
        removeEventListener('mousemove',mv);removeEventListener('mouseup',up);};
      addEventListener('mousemove',mv); addEventListener('mouseup',up); return;
    }
    const inOverlayZone = (canvas !== zm) || (e.clientY >= r.top + r.height * 0.30 && e.clientY <= r.top + r.height * 0.70);
    if(inOverlayZone){
      // nearest mark across ALL words, so any of them can be grabbed without switching first.
      // When two marks land on (essentially) the same pixel -- words flush with no gap between
      // them -- always prefer the already-selected word's own marker over its neighbour's: the
      // user selected that word to work on it, and iteration order over `gold` shouldn't
      // silently hand the drag to whichever neighbour happens to be touching it instead.
      const TIE_PX=1;                     // marks within this many px count as "same place"
      let best=null;
      S.gold.forEach((wd,i)=>{
        [['start',wd.start],['end',wd.end]].forEach(([which,t])=>{
          const d=Math.abs(px(t)-e.clientX);
          const tie=best&&Math.abs(d-best.d)<=TIE_PX;
          if(!best||d<best.d-TIE_PX||(tie&&i===S.wi&&best.i!==S.wi)) best={d,i,which};
        });
      });
      // inside a word, away from its marks: drag the whole word, both marks together
      if(!(best&&best.d<9)){
        const t=at(e.clientX);
        const inside=S.gold.findIndex(wd=>t>wd.start&&t<wd.end);
        if(inside>=0){
          S.wi=inside; render();
          const w=S.gold[S.wi], len=w.end-w.start, grab=t-w.start, downX=e.clientX;
          let moved=false;
          const mv=ev=>{
            if(!moved){ if(Math.abs(ev.clientX-downX)<=3) return;
              moved=true; dragging=true; canvas.classList.add('grabbing'); }
            let a=at(ev.clientX)-grab;
            a=Math.max(tmin(),Math.min(a,total()-len));
            w.start=a; w.end=a+len; S.touched.add(S.wi);
            pushWord(S.wi);
            draw(); render();
            if(S.loopKind){const sp=loopSpan(); start(sp[0],sp[1]);}
            else scheduleWordPlay();
          };
          const up=()=>{ if(!moved) moveHead(t);
            dragging=false; canvas.classList.remove('grabbing');
            removeEventListener('mousemove',mv); removeEventListener('mouseup',up);};
          addEventListener('mousemove',mv); addEventListener('mouseup',up); return;
        }
      }
      if(best&&best.d<9){                          // grabbed a mark: drag it (mouse never snaps)
        S.wi=best.i; const which=best.which; S.edge=which; dragging=true; render();
        canvas.classList.add('grabbing');
        let last=e.clientX;
        setMark(at(e.clientX),which);
        const mv=ev=>{ last=ev.clientX; setMark(at(ev.clientX),which); };
        const timer=setInterval(()=>{
          const [lo,hi]=zwin(), span=hi-lo;
          if(last<r.left+6){ panBy(-span*0.05); setMark(mark()-span*0.05,which); }
          else if(last>r.right-6){ panBy(span*0.05); setMark(mark()+span*0.05,which); }
        },50);
        const up=()=>{clearInterval(timer); dragging=false; canvas.classList.remove('grabbing');
          removeEventListener('mousemove',mv);removeEventListener('mouseup',up);};
        addEventListener('mousemove',mv); addEventListener('mouseup',up); return;
      }
    }
    // Outside word overlays or marks: drag to pan/scroll the view, or click without dragging to move the playhead.
    const t0x=e.clientX, tAtDown=at(e.clientX); let moved=false;
    let prev=t0x;
    const mv2=ev=>{
      if(Math.abs(ev.clientX-t0x)>3){ moved=true; dragging=true; }
      if(!moved){prev=ev.clientX; return;}
      const [lo,hi]=zwin();
      panBy(-(ev.clientX-prev)/r.width*(hi-lo));
      prev=ev.clientX;
    };
    canvas.classList.add('grabbing');
    const up=()=>{ canvas.classList.remove('grabbing'); dragging=false; if(!moved) moveHead(tAtDown);
      removeEventListener('mousemove',mv2); removeEventListener('mouseup',up); };
    addEventListener('mousemove',mv2); addEventListener('mouseup',up);
  };
  canvas.addEventListener('mousemove',e=>{
    if(!S.buf||canvas.classList.contains('grabbing'))return;
    const r=canvas.getBoundingClientRect(),[lo,hi]=zwin();
    const px=t=>(t-lo)/(hi-lo)*r.width+r.left;
    let near=(e.clientY<=r.top+r.height*0.20)?Math.abs(px(now())-e.clientX):999;
    const inOverlay=(canvas!==zm)||(e.clientY>=r.top+r.height*0.30&&e.clientY<=r.top+r.height*0.70);
    if(inOverlay){
      S.gold.forEach(wd=>{ near=Math.min(near,Math.abs(px(wd.start)-e.clientX),Math.abs(px(wd.end)-e.clientX)); });
    }
    canvas.classList.toggle('onmark',near<9);
  });
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();
    const r=canvas.getBoundingClientRect(), [lo,hi]=zwin();
    const t=lo+((e.clientX-r.left)/r.width)*(hi-lo);
    if(e.shiftKey) panBy((e.deltaY!==0?e.deltaY:e.deltaX)/500*(hi-lo));
    else zoomAt(t, e.deltaY>0?1.25:0.8);
  },{passive:false});
}
attachZoomEvents(zm);
attachZoomEvents(wave);

// Double-click a word's label in the "current word" bar's highlight band (the mid 40%
// overlay where word spans and their text are drawn) to edit that word's text in place.
zm.addEventListener('dblclick',e=>{
  if(!S.buf) return;
  const r=zm.getBoundingClientRect();
  if(e.clientY<r.top+r.height*0.30||e.clientY>r.top+r.height*0.70) return;
  const [lo,hi]=zwin();
  const t=lo+((e.clientX-r.left)/r.width)*(hi-lo);
  const idx=S.gold.findIndex(wd=>t>=wd.start&&t<=wd.end);
  if(idx<0) return;
  e.preventDefault();
  editBarWord(idx);
});

(function(){
  const el=$('scroll'), th=$('thumb');
  const spanNow=()=>{const [a,b]=zwin(); return b-a;};
  function centreOn(clientX){
    const r=el.getBoundingClientRect(), lo=tmin(), hi=total();
    const t=lo+((clientX-r.left)/r.width)*(hi-lo), s=spanNow();
    let a=t-s/2, b=a+s;
    if(a<lo){a=lo;b=a+s;} if(b>hi){b=hi;a=Math.max(lo,b-s);}
    S.view=[a,b]; draw();
  }
  th.onmousedown=e=>{
    e.stopPropagation();
    const r=el.getBoundingClientRect(), lo=tmin(), hi=total();
    const grab=e.clientX-th.getBoundingClientRect().left, s=spanNow();
    const mv=ev=>{
      let a=lo+((ev.clientX-grab-r.left)/r.width)*(hi-lo), b=a+s;
      if(a<lo){a=lo;b=a+s;} if(b>hi){b=hi;a=Math.max(lo,b-s);}
      S.view=[a,b]; draw();
    };
    const up=()=>{removeEventListener('mousemove',mv);removeEventListener('mouseup',up);};
    addEventListener('mousemove',mv); addEventListener('mouseup',up);
  };
  el.onmousedown=e=>{ if(e.target===th)return; centreOn(e.clientX); };
})();

export {ov,wave,zm,fitWord,zwin,panBy,ensureVisible,draw,drawOverview,drawWave,drawZoom,drawScroll,
  renderAlnToggles,setAllAln,paintAlnLanes,setMainAln};
