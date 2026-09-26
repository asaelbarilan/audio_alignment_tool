import {S,$,api} from './state.js';
import {stop} from './audio-engine.js';
import {fitWord,draw} from './canvas-draw.js';
import {buildWords,render,save} from './words.js';

// ---- call-out to the aligner service --------------------------------------
//
// Unlike untangle/reset-baseline (instant, local, free), this is a real network call to a
// GPU worker that can take minutes on a cold start (api-client-guide.md §4), so it gets its
// own spinner, its own cancel path, and disables the other clip-mutating actions while it
// is in flight -- navigating away mid-align would apply the result to the wrong clip, or
// leave a job running nobody is watching.
let alignJobId=null, alignPollTimer=null, alignForKey=null;

function setAlignBusy(busy){
  ['saveonly','save','unmark','prevc','skip','resetBaselineBtn','untangleBtn'].forEach(id=>{
    const el=$(id); if(el) el.disabled=busy;
  });
}

async function startAlign(){
  if(S.sampleMode||S.isReadOnly||alignJobId) return;
  const c=S.clips[S.ci];
  const key=c ? (c.key||c.id) : '';
  // Align using the words (text) from the USER marking, not the baseline
  const userWords = S.gold.map(w => (w.word||'').trim()).filter(Boolean);
  if(!userWords.length){
    finishAlignUI('No words to align');
    return 'No words to align';
  }
  setAlignBusy(true);
  $('alignBtn').textContent='cancel align';
  $('alignBtn').classList.add('on');
  $('alignStatus').innerHTML='<span class="spinner"></span>calling the aligner service'
    +' (can take a couple of minutes on a cold start)&hellip;';
  try{
    const r=await fetch(api('/api/align'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key, words:userWords, text:userWords.join(' ')})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok || j.error){
      const err = j.error || ('HTTP '+r.status);
      finishAlignUI(err);
      return err;
    }
    alignJobId=j.job_id; alignForKey=key;
    pollAlign();
  }catch(err){
    const msg = ''+err;
    finishAlignUI(msg);
    return msg;
  }
}

function pollAlign(){
  alignPollTimer=setTimeout(async ()=>{
    if(!alignJobId) return;
    try{
      const r=await fetch(api('/api/align-status?job='+encodeURIComponent(alignJobId)));
      const j=await r.json().catch(()=>({}));
      if(!r.ok || j.error){
        const err = j.error || ('HTTP '+r.status);
        finishAlignUI(err);
        return err;
      }
      if(j.status==='running'){ pollAlign(); return; }
      if(j.status==='done'){ applyAlignResult(j.words); finishAlignUI('Align complete \u2014 replaced your marks.'); }
      else if(j.status==='cancelled'){ finishAlignUI('Align cancelled.'); }
      else{ finishAlignUI(j.error || 'Align failed'); }
    }catch(err){
      finishAlignUI('Align failed: '+err);
    }
  },1200);
}

function applyAlignResult(words){
  if(!words||!words.length) return;
  const c=S.clips[S.ci];
  // The annotator may have navigated to a different clip while this was in flight (nav is
  // disabled via setAlignBusy, but "back to tagging"/"overview" are not) -- in that case the
  // result belongs to a clip that is no longer on screen, so drop it rather than overwrite
  // whatever is showing now.
  if(!c || (c.key||c.id)!==alignForKey || S.sampleMode || S.isReadOnly) return;
  stop();
  S.gold=words.map((w, i)=>({
    word: w.word,
    start: w.start,
    end: w.end,
    ...(S.gold[i] && S.gold[i].was !== undefined ? {was: S.gold[i].was} : {}),
    ...(S.gold[i] && S.gold[i].added ? {added: true} : {})
  }));
  S.touched=new Set(S.gold.map((_,i)=>i));
  S.wi=0; S.edge='end';
  fitWord();
  buildWords();
  render();
  draw();
  S.clips[S.ci].saved=S.gold.map(w=>({...w}));
  save();
}

async function cancelAlign(){
  if(!alignJobId) return;
  const jobId=alignJobId;
  if(alignPollTimer){ clearTimeout(alignPollTimer); alignPollTimer=null; }
  alignJobId=null; alignForKey=null;
  $('alignStatus').innerHTML='<span class="spinner"></span>cancelling\u2026';
  try{
    // Best effort either way -- the server marks the job cancelled and, on our side,
    // shuts the socket to the aligner out from under whichever call is still blocked on
    // it. Once this resolves (or fails) the annotator's current marks are untouched.
    await fetch(api('/api/align-cancel'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({job_id:jobId})});
  }catch(err){ /* the job is treated as cancelled client-side regardless */ }
  finishAlignUI('Align cancelled.');
}

function finishAlignUI(msg){
  if(alignPollTimer){ clearTimeout(alignPollTimer); alignPollTimer=null; }
  alignJobId=null; alignForKey=null;
  setAlignBusy(false);
  const btn=$('alignBtn');
  btn.textContent='align'; btn.classList.remove('on');
  btn.value = msg || '';
  btn.dataset.status = msg || '';
  if(msg==='Aligner disabled') btn.title='Aligner disabled';
  $('alignStatus').textContent=msg||'';
  if(msg) setTimeout(()=>{ if($('alignStatus').textContent===msg) $('alignStatus').textContent=''; },5000);
  if(!S.sampleMode&&!S.isReadOnly) render();  // re-sync button states (e.g. "unmark") after the forced-enable above
}

$('alignBtn').onclick=()=>{ return alignJobId?cancelAlign():startAlign(); };
window.align = startAlign;

export {startAlign,cancelAlign,pollAlign};
