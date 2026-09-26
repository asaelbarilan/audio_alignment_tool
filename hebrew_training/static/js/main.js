import {S,$,PARAMS,api,fail,checkBuild,mmss,setUrlParam} from './state.js';
import {total,tmin,mark,now,stop,start,setLoop,toggle,moveHead,
  playWord,playBefore,playAfter,stretched,setRate} from './audio-engine.js';
import {fitWord,draw,setAllAln} from './canvas-draw.js';
import {buildMelSpec, refreshSnapPoints} from './spectrogram.js';
import {updatePlayingChip,buildWords,render,editActiveTime,
  addWord,addWordBefore,untangleWords,resetToBaseline,delWord,setMark,goWord,stepMark,
  save,saveNext,getPlayOnMark,setPlayOnMark} from './words.js';
import {cancelAlign} from './align-client.js';
import {showOverview,claimClip} from './screens/overview.js';
import {showEval,evalLanes} from './screens/eval.js';
import {showApprovals} from './screens/approvals.js';
import {showWaiting,started,signIn,showMigrate,gate} from './screens/gate.js';

const NAME=/^[A-Za-z0-9_-]{1,32}$/;

async function openClip(key, forceReadOnly, extraLanes){
  stop(); cancelAlign();
  const r=await fetch(api('/api/clip-marks?key='+encodeURIComponent(key)));
  if(!r.ok){
    alert('Could not load clip ('+r.status+')');
    return;
  }
  const data=await r.json();
  // Opened from the eval screen: what is on screen has to be what was scored, not
  // whatever the live dataset happens to hold right now -- those can have drifted apart
  // since the result was computed. This also means nobody's marks and no claim state
  // decide anything here; it is a read of a frozen result, never a tagging session.
  const evalMode=Boolean(extraLanes&&extraLanes.length);
  const evalClip=evalMode&&S.evalData&&S.evalData.clip_data&&S.evalData.clip_data[data.id];
  const evalHuman=(evalClip&&evalClip.human)||null;
  if(extraLanes&&extraLanes.length){
    // An eval result's alignment replaces the dataset's label of the same name: it is the
    // one the numbers on the eval screen were computed from.
    const over=new Set(extraLanes.map(l=>l.source));
    data.labels=[...(data.labels||[]).filter(l=>!over.has(l.source)),...extraLanes];
  }
  S.currentClipDetail=data;

  const isMine=Boolean(data.claim&&data.claim.claimed_by_me);
  S.isReadOnly=evalMode||(forceReadOnly || !isMine);

  $('overviewScreen').classList.remove('on');
  $('evalScreen').classList.remove('on');
  $('evalLink').classList.remove('cur');
  $('workspace').style.display='block';
  $('overviewLink').classList.remove('cur');
  $('taggingLink').style.display='';
  setUrlParam('clip', key);
  setUrlParam('view', null);

  if(S.isReadOnly){
    $('readOnlyBanner').style.display='flex';
    const select=$('roMarksSelect');
    select.innerHTML='';

    if(evalMode&&evalHuman&&Object.keys(evalHuman).length){
      $('readOnlyClaimInfo').textContent='Eval result'+(S.evalData.title?': '+S.evalData.title:'')
        +' &middot; golden (human) marks';
      const humanKeys=Object.keys(evalHuman).sort();
      humanKeys.forEach(ann=>{
        const opt=document.createElement('option');
        opt.value=ann;
        opt.textContent=ann+' (golden)';
        select.appendChild(opt);
      });
      select.value=humanKeys[0];
      select.onchange=()=>{
        const wordsToUse=evalHuman[select.value]||[];
        S.alnMain=null; S.alnMainGolden=null;  // switching the golden pick drops any aligner override
        S.gold=wordsToUse.map(w=>({word:w.word,start:w.start,end:w.end,was:w.was,added:w.added}));
        S.touched=new Set();
        buildWords();
        draw();
        render();
      };
      // Claiming or saving from an eval view would write to the live dataset while
      // looking at a frozen result -- neither belongs here, so both stay hidden rather
      // than merely disabled.
      $('roClaimBtn').style.display='none';
    }else{
      let claimText='Unclaimed';
      if(data.claim&&data.claim.claimant){
        claimText='Claimed by '+(data.claim.claimed_by_me?'you':data.claim.claimant)
          +(data.claim.done?' (done)':'');
      }
      $('readOnlyClaimInfo').textContent=claimText;

      const baseOpt=document.createElement('option');
      baseOpt.value='__baseline__';
      baseOpt.textContent='Baseline (aligner)';
      select.appendChild(baseOpt);

      const markKeys=Object.keys(data.marks||{});
      markKeys.forEach(ann=>{
        const opt=document.createElement('option');
        opt.value=ann;
        opt.textContent=ann+(ann===S.WHO?' (your marks)':'');
        select.appendChild(opt);
      });

      let defaultChoice='__baseline__';
      if(data.claim&&data.claim.claimant&&data.marks&&data.marks[data.claim.claimant]){
        defaultChoice=data.claim.claimant;
      }else if(markKeys.length){
        defaultChoice=markKeys[0];
      }
      select.value=defaultChoice;

      select.onchange=()=>{
        const choice=select.value;
        let wordsToUse=data.words;
        if(choice!=='__baseline__'&&data.marks&&data.marks[choice]){
          wordsToUse=data.marks[choice];
        }
        S.alnMain=null; S.alnMainGolden=null;  // switching the golden pick drops any aligner override
        S.gold=wordsToUse.map(w=>({word:w.word,start:w.start,end:w.end,was:w.was,added:w.added}));
        S.touched=new Set();
        buildWords();
        draw();
        render();
      };

      if(data.claim&&data.claim.claimable){
        $('roClaimBtn').style.display='';
        $('roClaimBtn').onclick=()=>claimClip(key);
      }else{
        $('roClaimBtn').style.display='none';
      }
    }

    if(!evalMode&&isMine){
      $('roEditBtn').style.display='';
      $('roEditBtn').onclick=()=>openClip(key, false);
    }else{
      $('roEditBtn').style.display='none';
    }

    $('roBackOvBtn').onclick=evalMode?showEval:showOverview;
    setClipActionsVisible(false);
  }else{
    $('readOnlyBanner').style.display='none';
    setClipActionsVisible(true);
  }

  let existingIndex=S.clips.findIndex(x=>(x.key||x.id)===key);
  let initialSaved=null;
  if(evalMode&&evalHuman&&Object.keys(evalHuman).length){
    initialSaved=evalHuman[$('roMarksSelect').value];
  }else if(S.isReadOnly){
    const choice=$('roMarksSelect').value;
    if(choice!=='__baseline__'&&data.marks&&data.marks[choice]){
      initialSaved=data.marks[choice];
    }
  }else{
    initialSaved=(data.marks&&data.marks[S.WHO])||data.words;
  }

  if(existingIndex<0){
    S.clips.push({
      id: data.id,
      key: data.id,
      metadata: data.metadata||{},
      text: data.text,
      duration: data.duration,
      words: data.words,
      labels: data.labels,
      saved: initialSaved,
      done: data.claim?data.claim.done:false,
      isExternal: true
    });
    S.ci=S.clips.length-1;
  }else{
    S.ci=existingIndex;
    if(initialSaved) S.clips[S.ci].saved=initialSaved;
  }

  await loadClip();
  startTick();
}

async function backToTagging(){
  stop(); cancelAlign();
  S.isReadOnly=false;
  S.currentClipDetail=null;
  $('readOnlyBanner').style.display='none';
  $('overviewScreen').classList.remove('on');
  $('evalScreen').classList.remove('on');
  $('approveScreen').classList.remove('on');
  $('evalLink').classList.remove('cur');
  $('workspace').style.display='block';
  $('overviewLink').classList.remove('cur');
  $('taggingLink').style.display='none';
  setClipActionsVisible(true);
  setUrlParam('view', null);
  setUrlParam('clip', null);
  await load();
}

async function boot(){
  if(await checkBuild()) return;   // an old copy; the reload is already on its way
  let r;
  try{ r=await fetch(api('/api/me')); }
  catch(e){ return fail('Could not reach the server: '+e.message); }
  if(!r.ok) return fail('The server refused the page ('+r.status+'). Try signing in again.');
  try{ S.ME=await r.json(); }
  catch(e){ return fail('The server sent something unreadable instead of your account.'); }
  if(S.ME.migrate) return showMigrate();
  if(S.ME.auth){
    if(!S.ME.logged_in) return signIn();
    // Signed in but no annotator name yet. The marks made before sign-in existed are filed
    // under short names, so the first login gets to claim one rather than orphan the work.
    if(!S.ME.name) return gate(true);
    S.WHO=S.ME.name; return started();
  }
  const meta=await (await fetch(api('/api/meta'))).json();
  if(meta.multi && !NAME.test(S.WHO)) return gate(false);
  if(meta.multi) $('me').textContent='marking as '+S.WHO;
  return load();
}

async function load(){
  try{
    const meta=await (await fetch(api('/api/meta'))).json();
    if(meta && meta.aligner===false) $('alignBtn').title='Aligner disabled';
  }catch(e){}
  const v=PARAMS.get('view');
  const cl=PARAMS.get('clip');
  // The evaluation and the overview do not need the annotator's clip list, and a clip
  // opened by id fetches its own. Letting this one call decide whether the page appears at
  // all is what turned a slow dataset listing into a blank screen.
  try{
    const r=await fetch(api('/api/clips'));
    if(!r.ok) throw new Error('/api/clips answered '+r.status);
    S.clips=await r.json();
  }catch(e){
    S.clips=[];
    if(v!=='overview' && v!=='eval' && !cl){ fail('The clip list did not load: '+e.message); return; }
    fail('The clip list did not load ('+e.message+'); the rest of this page is unaffected.');
  }
  if(v==='overview'){
    PARAMS.delete('view');
    return showOverview();
  }
  if(v==='eval'){
    PARAMS.delete('view');
    return showEval();
  }
  if(v==='approvals'){
    PARAMS.delete('view');
    return showApprovals();
  }
  if(cl){
    PARAMS.delete('clip');
    const rid=PARAMS.get('result');
    if(rid){
      try{
        const rr=await fetch(api('/api/eval-results/'+encodeURIComponent(rid)));
        if(rr.ok){ S.evalData=await rr.json(); S.evalCur=rid; }
      }catch(e){}
      return openClip(cl, false, evalLanes(cl));
    }
    return openClip(cl);
  }
  // Land on the clip last worked on but not finished: the most recent one the annotator
  // saved without marking done. Fall back to the first clip with no marks at all.
  S.ci=-1;
  for(let i=0;i<S.clips.length;i++) if(S.clips[i].saved && !S.clips[i].done) S.ci=i;
  if(S.ci<0) S.ci=S.clips.findIndex(c=>!c.saved);
  if(S.ci<0) S.ci=0;
  await loadClip(); startTick();
}
async function loadClip(){
  stop();
  const c=S.clips[S.ci];
  if(!c) return;
  S.gold=(c.saved||c.words).map(w=>({word:w.word,start:w.start,end:w.end,was:w.was,added:w.added}));
  S.touched=new Set(c.saved?S.gold.map((_,i)=>i):[]);
  S.alnMain=null; S.alnMainGolden=null;  // a new clip starts back on its own golden marks
  S.alnSig=null;  // force the aligner toggles/select to rebuild even if the same names recur
  S.wi=0; S.edge='end'; S.head=0;
  S.specCanvas=null; S.snapPoints=[];
  const r=await fetch(api('/api/audio/'+encodeURIComponent(c.key||c.id||S.ci))); S.lead=parseFloat(r.headers.get('X-Lead')||'0');
  const ab=await r.arrayBuffer();
  S.ctx=S.ctx||new (window.AudioContext||window.webkitAudioContext)();
  S.buf=await S.ctx.decodeAudioData(ab);
  S.specCanvas=buildMelSpec(S.buf);
  S.snapPoints=S.specCanvas?(S.specCanvas.snapPoints||[]):[];
  S.peaks=null; S.view=null; S.stretchCache.clear(); draw(); render();
}

let playingIdx=-1;
// The loop that moves the playhead. It used to be started only by the tagging path, so a
// clip opened straight from the overview or the eval table never animated: the audio played
// and the red line sat still. Guarded, so entering a clip twice does not run two loops.
let ticking=false;
function startTick(){ if(ticking) return; ticking=true; tick(); }
function tick(){ if(S.playing)draw();
  $('clock').textContent=mmss(now())+' / '+mmss(total()); updatePlayingChip();
  requestAnimationFrame(tick); }

function nudgeWithSnap(delta){
  const cur=mark();
  let target=cur+delta;
  if(S.snapShow && S.snapPoints && S.snapPoints.length){
    let closest=null, minD=Infinity;
    for(let i=0;i<S.snapPoints.length;i++){
      const s=S.snapPoints[i];
      // When marker is exactly on a segmentation line, ignore it so user can escape;
      // Also do not snap backwards against the nudge direction
      if(delta>0 && s<=cur+0.0015) continue;
      if(delta<0 && s>=cur-0.0015) continue;
      const d=Math.abs(target-s);
      if(d<minD){ minD=d; closest=s; }
    }
    if(closest!==null && minD<=0.010) target=closest;
  }
  setMark(target);
}

// ---- experimental: view a local CSV+WAV sample, no server involved --------
// A drag-in preview: the CSV supplies word boundaries, the WAV supplies audio, and both
// are decoded entirely client-side. `save`/`saveNext` already no-op under sampleMode, so
// every edit made while inspecting a sample stays in memory and is never sent anywhere.
function setClipActionsVisible(v){
  $('clipNav').style.display=v?'inline-flex':'none'; $('saveRow').style.display=v?'':'none';
  // Calling the aligner service costs real time and GPU money, unlike the local-only
  // untangle/reset-baseline actions -- keep it out of read-only and sample-mode entirely
  // rather than just no-op'ing its save like those do.
  if(!v) cancelAlign();
  $('alignBtn').style.display=v?'':'none'; $('alignStatus').style.display=v?'':'none';
}
function parseSampleCsv(text){
  const lines=text.split(/\r\n|\n|\r/).map(l=>l.trim()).filter(l=>l.length);
  if(!lines.length) throw new Error('file is empty');
  let start=0;
  const head=lines[0].split(',').map(s=>s.trim().toLowerCase());
  if(head[0]==='word'&&head.length>=3) start=1;         // an optional header row
  const words=[];
  for(let i=start;i<lines.length;i++){
    const parts=lines[i].split(',');
    if(parts.length<3) throw new Error('row '+(i+1)+' is not Word,Start_Time,End_Time');
    const word=parts[0].trim(), s=parseFloat(parts[1]), e=parseFloat(parts[2]);
    if(!word) throw new Error('row '+(i+1)+' has no word');
    if(!isFinite(s)||!isFinite(e)) throw new Error('row '+(i+1)+' has a non-numeric time');
    if(e<=s) throw new Error('row '+(i+1)+': End_Time must be after Start_Time');
    words.push({word,start:s,end:e});
  }
  if(!words.length) throw new Error('no data rows found');
  return words;
}
const readAsText=file=>new Promise((res,rej)=>{
  const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsText(file);});
const readAsArrayBuffer=file=>new Promise((res,rej)=>{
  const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsArrayBuffer(file);});
async function tryLoadSample(){
  if(!S.sampleCsv||!S.sampleWav) return;             // wait for both drops before doing anything
  $('sampleErr').textContent='';
  try{
    const words=parseSampleCsv(S.sampleCsv.text);
    S.ctx=S.ctx||new (window.AudioContext||window.webkitAudioContext)();
    const decoded=await S.ctx.decodeAudioData(S.sampleWav.buf.slice(0));
    stop();
    S.sampleMode=true;
    S.sampleBaseline=words.map(w=>({...w}));
    S.gold=words.map(w=>({...w})); S.touched=new Set();
    S.wi=0; S.edge='end'; S.head=0; S.lead=0;              // local wav has no server-side pre-roll
    S.buf=decoded; S.specCanvas=buildMelSpec(S.buf); S.snapPoints=S.specCanvas?(S.specCanvas.snapPoints||[]):[];
    S.peaks=null; S.view=null; S.stretchCache.clear();
    $('sampleUpload').style.display='none';
    $('uploadSampleBtn').style.display='none';
    $('removeSampleBtn').style.display='';
    $('sampleBadge').style.display='';
    setClipActionsVisible(false);
    draw(); render();
  }catch(err){
    $('sampleErr').textContent='Could not load sample: '+err.message;
  }
}
function resetDropzone(el,label){ el.classList.remove('loaded'); el.innerHTML=label; }
const CSV_LABEL='Drop CSV file here<small>Word,Start_Time,End_Time</small>';
const WAV_LABEL='Drop WAV file here<small>audio for the CSV above</small>';
function wireDrop(zone,picker,onFile){
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragover');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('dragover'));
  zone.addEventListener('drop',e=>{
    e.preventDefault(); zone.classList.remove('dragover');
    const f=e.dataTransfer.files&&e.dataTransfer.files[0];
    if(f) onFile(f);
  });
  zone.addEventListener('click',()=>picker.click());
  picker.addEventListener('change',()=>{ if(picker.files[0]) onFile(picker.files[0]); picker.value=''; });
}
wireDrop($('csvDrop'),$('csvPick'),async f=>{
  try{
    S.sampleCsv={name:f.name,text:await readAsText(f)};
    $('csvDrop').classList.add('loaded'); $('csvDrop').innerHTML='&#10003; '+f.name;
    await tryLoadSample();
  }catch(err){ $('sampleErr').textContent='Could not read CSV: '+err.message; }
});
wireDrop($('wavDrop'),$('wavPick'),async f=>{
  try{
    S.sampleWav={name:f.name,buf:await readAsArrayBuffer(f)};
    $('wavDrop').classList.add('loaded'); $('wavDrop').innerHTML='&#10003; '+f.name;
    await tryLoadSample();
  }catch(err){ $('sampleErr').textContent='Could not read WAV: '+err.message; }
});
$('uploadSampleBtn').onclick=()=>{
  $('sampleUpload').style.display='block';
  $('uploadSampleBtn').style.display='none';
};
$('removeSampleBtn').onclick=async ()=>{
  stop();
  S.sampleMode=false; S.sampleCsv=null; S.sampleWav=null; S.sampleBaseline=null;
  resetDropzone($('csvDrop'),CSV_LABEL); resetDropzone($('wavDrop'),WAV_LABEL);
  $('sampleErr').textContent='';
  $('sampleUpload').style.display='none';
  $('removeSampleBtn').style.display='none';
  $('sampleBadge').style.display='none';
  $('uploadSampleBtn').style.display='';
  setClipActionsVisible(true);
  if(S.clips.length) await loadClip(); else draw();   // back to the normal tagging queue
};

function showSaved(){
  const box=$('savedItems'); box.innerHTML='';
  $('savedCount').textContent='('+S.clips.length+')';
  if(!S.clips.length){
    box.innerHTML='<p>No clips assigned to you yet.</p>';
  }else{
    S.clips.forEach((c,i)=>{
      const row=document.createElement('div');
      row.className='savedItem'+(i===S.ci?' cur':'');
      row.onclick=()=>{ S.ci=i; closeSaved(); loadClip(); };

      const idx=document.createElement('span');
      idx.className='savedIdx'; idx.textContent=(i+1)+'.';

      const text=document.createElement('span');
      text.className='savedText'; text.textContent=c.text||c.id||'';
      text.title=c.id||'';

      const saved=document.createElement('span');
      saved.className='savedBadge'+(c.saved?' on':'');
      saved.textContent=c.saved?'saved':'not saved';

      const done=document.createElement('span');
      done.className='savedBadge done'+(c.done?' on':'');
      done.textContent=c.done?'done':'not done';

      row.append(idx,text,saved,done);
      box.appendChild(row);
    });
  }
  $('savedlist').classList.add('on');
}
function closeSaved(){ $('savedlist').classList.remove('on'); }
$('savedClose').onclick=closeSaved;
$('savedlist').onclick=e=>{ if(e.target===$('savedlist')) closeSaved(); };

$('play').onclick=toggle;
$('stopb').onclick=()=>{S.loopKind=null;$('loopWord').classList.remove('on');$('loopMark').classList.remove('on');stop();S.head=0;S.seg=null;draw();};
$('tostart').onclick=()=>moveHead(0);
$('pbefore').onclick=playBefore; $('pword').onclick=playWord; $('pafter').onclick=playAfter;
$('loopWord').onclick=()=>setLoop('word');
$('loopMark').onclick=()=>setLoop('mark');
$('rate').onchange=e=>{
  const was=S.playing, at=now(), span=S.seg;
  setRate(parseFloat(e.target.value));
  // Build it now. Stretching a clip takes about as long as playing a word, and paying that
  // on the first press of play reads as the transport being broken.
  if(S.buf) stretched(parseFloat(e.target.value));
  if(was) start(at, span?span[1]:null);
};
$('edStart').onclick=()=>{S.edge='start';draw();render();};
$('edEnd').onclick=()=>{S.edge='end';draw();render();};
$('edStart').ondblclick=e=>{e.stopPropagation();const ls=$('lblStart');if(ls)editActiveTime('start',ls);};
$('edEnd').ondblclick=e=>{e.stopPropagation();const le=$('lblEnd');if(le)editActiveTime('end',le);};
$('playMark').checked=localStorage.getItem('tagPlayMark')!=='0';
setPlayOnMark($('playMark').checked);
$('playMark').onchange=e=>{setPlayOnMark(e.target.checked);
  localStorage.setItem('tagPlayMark',getPlayOnMark()?'1':'0');};
function updateSnapVisibility(){
  if($('snapControls')) $('snapControls').style.display = S.snapShow ? 'inline-flex' : 'none';
  if($('snapLegendKey')) $('snapLegendKey').style.display = S.snapShow ? 'inline-block' : 'none';
  if($('snapOvLegendKey')) $('snapOvLegendKey').style.display = S.snapShow ? 'inline-block' : 'none';
}
if($('snapThresh')){
  $('snapThresh').value=S.snapThreshRatio;
  $('snapThreshVal').textContent=S.snapThreshRatio.toFixed(2);
  $('snapThresh').oninput=e=>{
    S.snapThreshRatio=parseFloat(e.target.value);
    $('snapThreshVal').textContent=S.snapThreshRatio.toFixed(2);
    localStorage.setItem('tagSnapThresh',S.snapThreshRatio);
    refreshSnapPoints(true);
  };
}
if($('snapMinSep')){
  $('snapMinSep').value=S.snapMinSepMs;
  $('snapMinSep').onchange=e=>{
    S.snapMinSepMs=parseInt(e.target.value,10);
    localStorage.setItem('tagSnapMinSep',S.snapMinSepMs);
    refreshSnapPoints(true);
  };
}
if($('snapShow')){
  $('snapShow').checked=S.snapShow;
  updateSnapVisibility();
  const toggleSnap=()=>{
    S.snapShow=$('snapShow').checked;
    localStorage.setItem('tagSnapShow',S.snapShow?'1':'0');
    updateSnapVisibility();
    draw();
  };
  $('snapShow').onchange=toggleSnap;
  $('snapShow').onclick=toggleSnap;
}
$('setb').onclick=()=>setMark(now());
$('m5').onclick=()=>nudgeWithSnap(-0.005); $('p5').onclick=()=>nudgeWithSnap(+0.005);
$('fit').onclick=()=>{fitWord();draw();};
$('fitall').onclick=()=>{S.view=[Math.max(tmin(),S.gold[0].start-0.2),
  Math.min(total(),S.gold[S.gold.length-1].end+0.2)];draw();};
$('addwb').onclick=addWordBefore; $('addw').onclick=addWord; $('delw').onclick=()=>delWord();
$('untangleBtn').onclick=untangleWords;
$('resetBaselineBtn').onclick=resetToBaseline;
$('prevw').onclick=()=>goWord(S.wi-1); $('nextw').onclick=()=>goWord(S.wi+1);
$('prevc').onclick=()=>{if(S.ci>0){S.ci--;loadClip();}};
$('saveonly').onclick=save;
$('save').onclick=saveNext;
$('skip').onclick=()=>{if(S.ci<S.clips.length-1){S.ci++;loadClip();}};
$('unmark').onclick=async ()=>{
  if(S.sampleMode||S.isReadOnly) return;
  await fetch(api('/api/unmark'),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:S.clips[S.ci].key})});
  S.clips[S.ci].done=false;
  render();
};

addEventListener('keydown',async e=>{
  // Never let the transport shortcuts fire while someone is typing: every letter of a
  // name is also a shortcut here, so the name box would play, seek and re-mark as it
  // was filled in.
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)||e.target.isContentEditable)return;
  if($('gate').classList.contains('on')||$('mgate').classList.contains('on'))return;
  if($('savedlist').classList.contains('on')){ if(e.key==='Escape')closeSaved(); return; }
  if(e.code==='Space'){e.preventDefault();toggle();return;}
  if(e.key==='Escape'){S.loopKind=null;$('loopWord').classList.remove('on');$('loopMark').classList.remove('on');stop();S.head=0;S.seg=null;draw();return;}
  if(e.key==='Tab'){e.preventDefault();(e.shiftKey?goWord(S.wi-1):goWord(S.wi+1));return;}
  if(e.key==='q'){playBefore();return;}
  if(e.key==='w'){playWord();return;}
  if(e.key==='e'){playAfter();return;}
  if(e.key==='l'){setLoop('mark');return;}
  if(e.key==='L'){setLoop('word');return;}
  if(e.key==='Home'){moveHead(0);return;}
  // Ctrl+Shift+arrow nudges 5ms; Shift+arrow nudges 25ms (up/down 125ms); snaps within 10ms if enabled
  if(e.key==='ArrowLeft'&&(e.ctrlKey||e.metaKey)&&e.shiftKey){e.preventDefault();nudgeWithSnap(-0.005);return;}
  if(e.key==='ArrowRight'&&(e.ctrlKey||e.metaKey)&&e.shiftKey){e.preventDefault();nudgeWithSnap(+0.005);return;}
  if(e.key==='ArrowLeft'&&e.shiftKey){e.preventDefault();nudgeWithSnap(-0.025);return;}
  if(e.key==='ArrowRight'&&e.shiftKey){e.preventDefault();nudgeWithSnap(+0.025);return;}
  if(e.key==='ArrowDown'&&e.shiftKey){e.preventDefault();nudgeWithSnap(-0.125);return;}
  if(e.key==='ArrowUp'&&e.shiftKey){e.preventDefault();nudgeWithSnap(+0.125);return;}
  if(e.key==='ArrowLeft'){e.preventDefault();stepMark(-1);return;}
  if(e.key==='ArrowRight'){e.preventDefault();stepMark(1);return;}
  if(e.key==='f'){setMark(now());return;}
  if(S.isReadOnly && (e.key==='Enter'||((e.ctrlKey||e.metaKey)&&e.key==='s'))){
    e.preventDefault(); return;
  }
  if(e.key==='Enter'){e.preventDefault();
    if(e.ctrlKey||e.metaKey) await saveNext(); else await save(); return;}
  if(e.key==='s'){if(e.ctrlKey||e.metaKey){e.preventDefault();await save();return;}
    if(!S.sampleMode&&!S.isReadOnly&&S.ci<S.clips.length-1){S.ci++;await loadClip();}return;}
});
addEventListener('resize',()=>{S.peaks=null;draw();});
$('overviewLink').onclick=e=>{ e.preventDefault(); showOverview(); };
$('alnAll').onclick=()=>setAllAln(true);
$('alnNone').onclick=()=>setAllAln(false);
$('evalLink').onclick=e=>{ e.preventDefault(); showEval(); };
$('taggingLink').onclick=e=>{ e.preventDefault(); backToTagging(); };
addEventListener('popstate',()=>{
  const p=new URLSearchParams(location.search);
  const v=p.get('view');
  const c=p.get('clip');
  if(v==='overview') showOverview();
  else if(v==='eval') showEval();
  else if(c) openClip(c);
  else backToTagging();
});

// words.js and the screen modules need these too, but importing this file from there
// would give main.js two distinct module instances -- one for this entry script's own
// URL and one for the bare specifier they'd import -- and the second copy evaluates
// mid-way through the circular chain, before audio-engine.js has finished defining what
// this file's own top imports. Routing through S sidesteps the import entirely.
S.openClip=openClip; S.backToTagging=backToTagging; S.load=load; S.loadClip=loadClip; S.showSaved=showSaved;

boot().catch(e=>fail('The page could not start: '+(e&&e.message||e)));
