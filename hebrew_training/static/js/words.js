import {S,$,f3,api} from './state.js';
import {tmin,total,now,stop,start,loopSpan,playWord} from './audio-engine.js';
import {fitWord,zwin,ensureVisible,draw} from './canvas-draw.js';
// main.js is not imported here: see the comment by its own S.showSaved= assignment.

// Whether a word actually differs from what the source clip carried. Compared against the
// original aligner values rather than a "was touched" flag, so a mark dragged and dragged
// back reads as unmodified again, and a saved clip only shows green where it really moved.
const srcWord=i=>{const s=S.clips[S.ci]&&S.clips[S.ci].words;return (s&&s[i])||null;};
const modified=i=>{
  const w=S.gold[i];
  if(w.added) return true;
  if(w.was!==undefined && w.was!==w.word) return true;
  const s=srcWord(i);
  if(!s) return true;
  return Math.abs(w.start-s.start)>0.0005||Math.abs(w.end-s.end)>0.0005;
};
// Debounced "play the word whose mark just moved". Repeated nudges (shift+arrows, drag,
// +-10ms) each touch the mark, so the word only plays once the marks settle -- a pause in
// the motion means "done moving, now hear it".
let playOnMark=true, markPlayTimer=null;
function scheduleWordPlay(){
  clearTimeout(markPlayTimer);
  if(!playOnMark||S.loopKind) return;
  markPlayTimer=setTimeout(()=>{ if(playOnMark&&S.gold.length) playWord(); },250);
}
function getPlayOnMark(){ return playOnMark; }
function setPlayOnMark(v){ playOnMark=v; }

let playingIdx=-1;
function updatePlayingChip(){
  const p=now(); let idx=-1;
  if(S.playing){ for(let i=0;i<S.gold.length;i++) if(p>=S.gold[i].start&&p<=S.gold[i].end){idx=i;break;} }
  if(idx===playingIdx) return;
  if(playingIdx>=0&&chips[playingIdx]) chips[playingIdx].classList.remove('playing');
  playingIdx=idx;
  if(idx>=0&&chips[idx]) chips[idx].classList.add('playing');
}

// The chips are built once and then only updated. They used to be recreated on every
// render, which silently broke double-click: the first click of the gesture calls render,
// the node under the pointer is destroyed and replaced, and the second click lands on a
// different element, so the browser never reads a double-click at all.
let chips=[];
function buildWords(){
  const ws=$('words'); hideGapBtn(); ws.innerHTML=''; chips=[]; playingIdx=-1;
  S.gold.forEach((wd,i)=>{
    const s=document.createElement('span');
    s.dir='auto';
    s.title='double-click to correct the word';
    s.onclick=()=>{S.wi=i;fitWord();draw();render();playWord();};
    s.ondblclick=e=>{e.stopPropagation();editWord(i,s);};
    ws.appendChild(s); chips.push(s);
  });
}
// idx is the array position to insert BEFORE (idx===gold.length means "after the last word").
// Delegates to the existing addWordBefore/addWord so the space-stealing/push-neighbour
// behaviour (and the "jump straight into typing" UX) stays identical everywhere.
function insertWordAt(idx){
  if(!S.gold||!S.gold.length) return;
  if(idx>=S.gold.length){ S.wi=S.gold.length-1; addWord(); }
  else{ S.wi=Math.max(0,idx); addWordBefore(); }
}

// No space is reserved between words at rest. Instead, hovering near a chip's edge (or
// past the first/last chip -- the sentence's own edges) injects a real "+" flex item into
// the row right at that boundary, which pushes the neighbouring words apart to make room;
// moving away removes it and the words settle back together. The button is anchored off
// whichever neighbouring chip's edge is closest, so once inserted it stays stable even
// though the OTHER chip gets pushed away by its own width.
let gapBtn=null, gapBtnIdx=null;
const GAP_HOVER_PX=4;
function hideGapBtn(){
  if(gapBtn&&gapBtn.parentNode) gapBtn.parentNode.removeChild(gapBtn);
  gapBtn=null; gapBtnIdx=null;
}
function showGapBtn(idx){
  if(gapBtnIdx===idx&&gapBtn&&gapBtn.parentNode) return;   // already showing this exact gap
  hideGapBtn();
  const ws=$('words');
  const btn=document.createElement('button');
  btn.type='button'; btn.className='wgap-add'; btn.textContent='+';
  btn.title='insert word here'; btn.tabIndex=-1;
  btn.onmousedown=e=>e.stopPropagation();
  btn.onclick=e=>{ e.stopPropagation(); hideGapBtn(); insertWordAt(idx); };
  if(idx>=chips.length) ws.appendChild(btn); else ws.insertBefore(btn,chips[idx]);
  gapBtn=btn; gapBtnIdx=idx;
}
$('words').addEventListener('mousemove',e=>{
  if(!chips.length) return;
  let best=null;
  chips.forEach((c,i)=>{
    const cr=c.getBoundingClientRect();
    if(e.clientY<cr.top-8||e.clientY>cr.bottom+8) return;   // different row
    const dRight=Math.abs(e.clientX-cr.right);   // near this chip's right edge -> before it
    const dLeft=Math.abs(e.clientX-cr.left);      // near this chip's left edge -> after it
    if(dRight<=GAP_HOVER_PX&&(!best||dRight<best.d)) best={idx:i,d:dRight};
    if(dLeft<=GAP_HOVER_PX&&(!best||dLeft<best.d)) best={idx:i+1,d:dLeft};
  });
  if(!best&&gapBtn){
    // Cursor may now sit over the button itself (the neighbour it pushed away moved out
    // of threshold range) -- keep it shown rather than flicker it away.
    const br=gapBtn.getBoundingClientRect();
    if(e.clientX>=br.left-4&&e.clientX<=br.right+4&&e.clientY>=br.top-4&&e.clientY<=br.bottom+4) return;
  }
  if(best) showGapBtn(best.idx); else hideGapBtn();
});
$('words').addEventListener('mouseleave',hideGapBtn);

function render(){
  if(S.sampleMode){
    $('bar').innerHTML='local sample &nbsp;·&nbsp; word '+(S.wi+1)+'/'+S.gold.length;
  }else if(S.isReadOnly){
    const c=S.clips[S.ci]||{};
    $('bar').innerHTML='clip '+(c.id||(S.ci+1))+' &nbsp;·&nbsp; word '+(S.wi+1)+'/'+S.gold.length
      +' &nbsp;·&nbsp; <span style="color:#6aa0ff;font-weight:600">view only</span>';
  }else{
    const savedN=S.clips.filter(x=>x.saved).length;
    const doneN=S.clips.filter(x=>x.done).length;
    $('bar').innerHTML='clip '+(S.ci+1)+'/'+S.clips.length+' &nbsp;·&nbsp; word '+(S.wi+1)+'/'+S.gold.length
      +' &nbsp;·&nbsp; <a id="savedLink" href="#" title="all clips assigned to you, with their status">'+savedN+' saved</a>'
      +' &nbsp;·&nbsp; <span id="done">'+doneN+' done</span>';
    const sl=$('savedLink'); if(sl) sl.onclick=e=>{e.preventDefault();S.showSaved();};
    const un=$('unmark'); if(un) un.disabled=!(S.clips[S.ci]&&S.clips[S.ci].done);
  }
  if(chips.length!==S.gold.length || !chips.every(c=>c.parentNode)) buildWords();
  S.gold.forEach((wd,i)=>{const s=chips[i];
    s.textContent=wd.word;
    s.className='w'+(i===S.wi?' cur':(modified(i)?' ok':''))
      +((wd.was!==undefined && wd.was!==wd.word)?' fixed':'')
      +(wd.added?' added':'');});
  const me=S.gold[S.wi];
  if(!me){ $('cmp').innerHTML=''; return; }
  const prevGap=(S.wi>0)?me.start-S.gold[S.wi-1].end:null;
  const p=[
    '<span class="pill" id="lblStart" title="double-click to manually edit start" style="cursor:pointer;user-select:none"><span style="color:#8a8f98">start:</span> <b style="color:#6aa0ff">'+f3(me.start)+'</b></span>',
    '<span class="pill" id="lblEnd" title="double-click to manually edit end" style="cursor:pointer;user-select:none"><span style="color:#8a8f98">end:</span> <b style="color:#6aa0ff">'+f3(me.end)+'</b></span>',
    '<span class="pill"><span style="color:#8a8f98">length:</span> <b>'+Math.round((me.end-me.start)*1000)+' ms</b></span>'
  ];
  if(prevGap!==null){
    if(prevGap<-0.0005){
      p.push('<span class="pill" style="background:#5c2424;color:#ffaaaa;font-weight:bold" title="Words overlap! Click untangle words to fix">overlap before '+Math.round(-prevGap*1000)+' ms</span>');
    }else{
      p.push('<span class="pill">gap before '+Math.round(prevGap*1000)+' ms</span>');
    }
  }
  $('cmp').innerHTML=p.join('');
  const ls=$('lblStart'), le=$('lblEnd');
  if(ls) ls.ondblclick=e=>{e.stopPropagation();editActiveTime('start',ls);};
  if(le) le.ondblclick=e=>{e.stopPropagation();editActiveTime('end',le);};
  $('edStart').classList.toggle('on',S.edge==='start');
  $('edEnd').classList.toggle('on',S.edge==='end');
}

// The transcript is ASR output and is sometimes simply wrong -- a boundary marked around
// the wrong word is worse than no boundary at all, because it reads as ground truth. The
// original is kept in `was` so a corrected clip can be told apart from one that was right
// to begin with; a benchmark cannot mix the two without saying so.
function editWord(i,span){
  stop();                       // the click that opened this also started playback
  const before=S.gold[i].word;
  const inp=document.createElement('input');
  inp.className='wedit'; inp.value=before; inp.dir='auto';
  span.replaceWith(inp); inp.focus(); inp.select();
  const done=keep=>{
    const v=inp.value.trim();
    if(keep && !v){ buildWords(); render(); delWord(); return; }   // emptied = delete
    if(keep && v && v!==before){
      if(S.gold[i].was===undefined && !S.gold[i].added) S.gold[i].was=before;
      S.gold[i].word=v;
      S.touched.add(i);
      save();                       // a text fix is worth keeping even if the clip is not finished
    }
    buildWords(); render(); draw();
  };
  inp.onkeydown=e=>{
    e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();done(true);}
    if(e.key==='Escape'){e.preventDefault();done(false);}
  };
  inp.onblur=()=>done(true);
}

let editingTime=false;
function editActiveTime(which,el){
  if(editingTime||!S.gold||!S.gold[S.wi]) return;
  stop();
  editingTime=true;
  const isStart=(which==='start');
  const val=isStart?S.gold[S.wi].start:S.gold[S.wi].end;
  const inp=document.createElement('input');
  inp.type='text';
  inp.value=f3(val);
  inp.className='wedit';
  inp.style.minWidth='75px';
  inp.style.width='75px';
  inp.style.direction='ltr';
  inp.style.textAlign='center';
  inp.style.color='#6aa0ff';
  inp.style.fontWeight='bold';
  el.replaceWith(inp);
  inp.focus();
  inp.select();

  let finished=false;
  const finish=commit=>{
    if(finished) return;
    finished=true;
    editingTime=false;
    if(commit){
      const parsed=parseFloat(inp.value.trim());
      if(!isNaN(parsed)&&isFinite(parsed)){
        if(isStart){
          S.gold[S.wi].start=parsed;
          if(S.gold[S.wi].end<parsed) S.gold[S.wi].end=parsed;
        }else{
          S.gold[S.wi].end=parsed;
          if(S.gold[S.wi].start>parsed) S.gold[S.wi].start=parsed;
        }
        S.touched.add(S.wi);
        save();
      }
    }
    render(); draw();
  };

  inp.onkeydown=e=>{
    e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();finish(true);}
    if(e.key==='Escape'){e.preventDefault();finish(false);}
  };
  inp.onblur=()=>finish(true);
}

// In-place text edit triggered by double-clicking a word's label inside the "current word"
// visualization bar (the mid-height highlight band), rather than the chip in the preview
// row above. Mirrors editWord()'s save/was/delete-on-empty behaviour, but floats a plain
// <input> over the canvas at the word's on-screen position instead of swapping a DOM span.
let barEditing=false;
function editBarWord(idx){
  if(barEditing||!S.gold||!S.gold[idx]) return;
  stop();
  barEditing=true;
  const before=S.gold[idx].word;
  const zm=$('zm');
  const r=zm.getBoundingClientRect();
  const [lo,hi]=zwin();
  const X=t=>(t-lo)/(hi-lo)*r.width;
  const wd=S.gold[idx];
  const midX=r.left+(X(wd.start)+X(wd.end))/2;
  const midY=r.top+r.height*0.50;
  const inp=document.createElement('input');
  inp.className='wedit'; inp.value=before; inp.dir='auto';
  inp.style.position='fixed'; inp.style.left=midX+'px'; inp.style.top=midY+'px';
  inp.style.transform='translate(-50%,-50%)'; inp.style.textAlign='center'; inp.style.zIndex=100;
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  const done=keep=>{
    if(!barEditing) return;              // already finished (e.g. resize cancelled it)
    barEditing=false; inp.remove();
    const v=inp.value.trim();
    if(keep && !v){ delWord(idx); return; }         // emptied = delete
    if(keep && v && v!==before){
      if(S.gold[idx].was===undefined && !S.gold[idx].added) S.gold[idx].was=before;
      S.gold[idx].word=v;
      S.touched.add(idx);
      save();
    }
    buildWords(); render(); draw();
  };
  inp.onkeydown=e=>{
    e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();done(true);}
    if(e.key==='Escape'){e.preventDefault();done(false);}
  };
  inp.onblur=()=>done(true);
  const cancelOnResize=()=>done(false);
  addEventListener('resize',cancelOnResize,{once:true});
}

// `touched` is a set of positions, so inserting or removing a word renumbers every entry
// after it. Left unshifted, the green "done" marks would silently slide onto the wrong
// words.
function shiftTouched(set,at,by){
  const out=new Set();
  set.forEach(i=>{
    if(i<at) out.add(i);
    else if(by>0) out.add(i+by);
    else if(i>at) out.add(i-1);
  });
  return out;
}

// A word the ASR missed entirely. Added after the currently selected word.
async function addWord(){
  if(!S.gold||!S.gold.length) return;
  const MIN_LEN=0.020;    // 20ms minimal word length
  const TARGET_LEN=0.500; // 500ms target length if space permits
  const maxAudio=total();

  const cur=S.gold[S.wi];
  const next=(S.wi+1<S.gold.length)?S.gold[S.wi+1]:null;
  const newStart=cur.end;

  let space=next?(next.start-newStart):(maxAudio-newStart);
  let newEnd;
  let pushed=false;

  if(next){
    if(space>=TARGET_LEN){
      newEnd=newStart+TARGET_LEN;
    }else if(space>=MIN_LEN){
      newEnd=next.start;
    }else{
      newEnd=newStart+MIN_LEN;
      next.start=newEnd;
      pushed=true;
    }
  }else{
    newEnd=Math.min(newStart+TARGET_LEN,maxAudio);
  }

  if(newStart>maxAudio) newStart=maxAudio;
  if(newEnd>maxAudio) newEnd=maxAudio;
  if(newEnd<newStart) newEnd=newStart;

  const newWord={word:'?',start:newStart,end:newEnd,added:true};
  const insertIndex=S.wi+1;
  S.gold.splice(insertIndex,0,newWord);
  S.touched=shiftTouched(S.touched,insertIndex,1);
  S.touched.add(insertIndex);

  if(pushed){
    for(let k=insertIndex+1;k<S.gold.length;k++){
      if(S.gold[k].start>maxAudio) S.gold[k].start=maxAudio;
      if(S.gold[k].end-S.gold[k].start<MIN_LEN){
        S.gold[k].end=S.gold[k].start+MIN_LEN;
      }
      if(S.gold[k].end>maxAudio) S.gold[k].end=maxAudio;

      S.touched.add(k);

      if(k<S.gold.length-1){
        if(S.gold[k+1].start<S.gold[k].end){
          S.gold[k+1].start=S.gold[k].end;
        }else{
          break;
        }
      }
    }
  }

  S.wi=insertIndex;
  fitWord();
  buildWords();
  render();
  draw();
  // Await the save before opening the editor: save()'s completion calls render(), and
  // render() rebuilds every chip from scratch whenever one is detached (which the editor's
  // input-for-span swap does). Editing before that render lands means the rebuild replaces
  // the freshly-focused input with a plain span out from under the user's cursor.
  await save();
  editWord(S.wi,chips[S.wi]);        // straight into typing; a word called "?" helps nobody
}

// Same as addWord, mirrored backwards: inserted before the currently selected word,
// stealing space from whatever precedes it instead of whatever follows it.
async function addWordBefore(){
  if(!S.gold||!S.gold.length) return;
  const MIN_LEN=0.020;    // 20ms minimal word length
  const TARGET_LEN=0.500; // 500ms target length if space permits
  const minAudio=tmin();

  const cur=S.gold[S.wi];
  const prev=(S.wi-1>=0)?S.gold[S.wi-1]:null;
  const newEnd=cur.start;

  let space=prev?(newEnd-prev.end):(newEnd-minAudio);
  let newStart;
  let pushed=false;

  if(prev){
    if(space>=TARGET_LEN){
      newStart=newEnd-TARGET_LEN;
    }else if(space>=MIN_LEN){
      newStart=prev.end;
    }else{
      newStart=newEnd-MIN_LEN;
      prev.end=newStart;
      pushed=true;
    }
  }else{
    newStart=Math.max(newEnd-TARGET_LEN,minAudio);
  }

  if(newStart<minAudio) newStart=minAudio;
  if(newStart>newEnd) newStart=newEnd;

  const newWord={word:'?',start:newStart,end:newEnd,added:true};
  const insertIndex=S.wi;
  S.gold.splice(insertIndex,0,newWord);
  S.touched=shiftTouched(S.touched,insertIndex,1);
  S.touched.add(insertIndex);

  if(pushed){
    for(let k=insertIndex-1;k>=0;k--){
      if(S.gold[k].start<minAudio) S.gold[k].start=minAudio;
      if(S.gold[k].end-S.gold[k].start<MIN_LEN){
        S.gold[k].start=S.gold[k].end-MIN_LEN;
      }
      if(S.gold[k].start<minAudio) S.gold[k].start=minAudio;

      S.touched.add(k);

      if(k>0){
        if(S.gold[k-1].end>S.gold[k].start){
          S.gold[k-1].end=S.gold[k].start;
        }else{
          break;
        }
      }
    }
  }

  S.wi=insertIndex;
  fitWord();
  buildWords();
  render();
  draw();
  // Await the save before opening the editor: save()'s completion calls render(), and
  // render() rebuilds every chip from scratch whenever one is detached (which the editor's
  // input-for-span swap does). Editing before that render lands means the rebuild replaces
  // the freshly-focused input with a plain span out from under the user's cursor.
  await save();
  editWord(S.wi,chips[S.wi]);        // straight into typing; a word called "?" helps nobody
}

// Ctrl+drag over a stretch of the bar with no existing word creates one spanning exactly
// the dragged range. Insertion position is derived from the times themselves (not from
// `wi`), since the drag can happen anywhere -- including before the first or after the
// last word.
async function createWordAt(s,e){
  if(!(e>s)) return;
  let idx=S.gold.findIndex(wd=>wd.start>=e-1e-9);
  if(idx<0) idx=S.gold.length;
  S.gold.splice(idx,0,{word:'?',start:s,end:e,added:true});
  S.touched=shiftTouched(S.touched,idx,1); S.touched.add(idx);
  S.wi=idx; S.edge='end';
  fitWord(); buildWords(); render(); draw();
  await save();
  editBarWord(S.wi);        // straight into typing, same as the +before/+after buttons
}

function untangleWords(){
  if(!S.gold||S.gold.length<=1) return;
  if(!confirm("Untangle words will change any overlapping word timings regardless of original values. Continue?")) return;

  const MIN_LEN = 0.020;  // 20ms minimal word length
  const EPS = 1e-4;
  const minAudio = (typeof tmin === 'function') ? tmin() : 0;
  const maxAudio = (typeof total === 'function' && total() > minAudio) ? total() : Infinity;

  let changed = false;

  // 1. Sanitize every word: ensure valid numeric values, end > start, and min duration
  for (let i = 0; i < S.gold.length; i++) {
    let s = Number(S.gold[i].start);
    let e = Number(S.gold[i].end);
    if (isNaN(s) || !isFinite(s)) s = minAudio;
    if (isNaN(e) || !isFinite(e)) e = s + MIN_LEN;
    if (e < s) { const tmp = s; s = e; e = tmp; changed = true; }
    if (e - s < MIN_LEN) { e = s + MIN_LEN; changed = true; }
    if (S.gold[i].start !== s || S.gold[i].end !== e) changed = true;
    S.gold[i].start = s;
    S.gold[i].end = e;
  }

  // 2. Cluster overlapping and out-of-order words along sentence order
  const groups = S.gold.map(w => ({
    words: [w],
    start: w.start,
    end: Math.max(w.end, w.start + MIN_LEN)
  }));

  const merged = [];
  for (const g of groups) {
    let cur = g;
    while (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (cur.start < prev.end - EPS) {
        merged.pop();
        const totalWords = prev.words.length + cur.words.length;
        const minS = Math.min(prev.start, cur.start);
        const maxE = Math.max(prev.end, cur.end, minS + totalWords * MIN_LEN);
        cur = {
          words: prev.words.concat(cur.words),
          start: minS,
          end: maxE
        };
      } else {
        break;
      }
    }
    merged.push(cur);
  }

  // 3. Shift backwards from audio ceiling if needed, merging backwards if pushed into previous group
  if (isFinite(maxAudio)) {
    for (let i = merged.length - 1; i >= 0; i--) {
      const g = merged[i];
      if (g.end > maxAudio) {
        const diff = g.end - maxAudio;
        g.end = maxAudio;
        g.start = Math.max(minAudio, g.start - diff);
        if (i > 0 && g.start < merged[i - 1].end - EPS) {
          const prev = merged[i - 1];
          merged.splice(i - 1, 2, {
            words: prev.words.concat(g.words),
            start: Math.min(prev.start, g.start),
            end: Math.max(prev.end, g.end)
          });
          i = merged.length;
        }
      }
    }
  }

  // 4. Untangle each multi-word group: split shared space equally among words in sentence order
  for (const g of merged) {
    if (g.words.length > 1) {
      changed = true;
      const span = Math.max(g.words.length * MIN_LEN, g.end - g.start);
      const step = span / g.words.length;
      for (let k = 0; k < g.words.length; k++) {
        g.words[k].start = g.start + k * step;
        g.words[k].end = (k === g.words.length - 1) ? g.end : (g.start + (k + 1) * step);
      }
    }
  }

  if (changed) {
    S.gold.forEach((_, i) => S.touched.add(i));
    save();
  }

  buildWords();
  render();
  draw();
}

function resetToBaseline(){
  const base=S.sampleMode?S.sampleBaseline:(S.clips[S.ci]&&S.clips[S.ci].words);
  if(!base||!base.length) return;
  if(!confirm("Reset all words to dataset baseline? This will restore original words and timings.")) return;
  stop();
  S.gold=base.map(w=>({word:w.word,start:w.start,end:w.end}));
  S.touched=new Set();
  S.wi=0;
  S.edge='end';
  fitWord();
  buildWords();
  render();
  draw();
  save();
}

// A word the ASR invented. The clip keeps its original `transcript`, so a word missing from
// `words` is still recoverable downstream -- deletion needs no flag of its own.
function delWord(idx){
  if(S.gold.length<=1) return;
  idx=(idx===undefined)?S.wi:idx;
  S.gold.splice(idx,1);
  S.touched=shiftTouched(S.touched,idx,-1);
  if(S.wi>idx) S.wi--;
  S.wi=Math.min(S.wi,S.gold.length-1);
  buildWords(); render(); draw(); save();
}

// Marks stay ordered, but only against their immediate neighbours -- clamping a word's end
// against the NEXT word's end would silently refuse "take aligner B" whenever B places this
// word later than A placed the following one, which is exactly the disagreement being judged.
// A real gap between two words is silence and is left alone: pushing a mark into it just
// stops at the neighbour's mark, same as before. But when two marks are already flush (no
// gap -- the split between the words is what's misplaced, not any silence), pushing one PAST
// its neighbour carries the neighbour's mark along too, and the chain continues into further
// flush words. Without this, closing a wrongly-placed split meant shoving the far mark all the
// way over to touch its neighbour first, then dragging both back the other way -- pure
// friction for what is really just "this one boundary is in the wrong place."
const ADJ_EPS=0.001;                  // "touching, no gap" tolerance, in seconds

// Move word idx's END toward t, carrying the next word's START along when they're flush.
function pushEnd(idx,t){
  t=Math.max(t,S.gold[idx].start+.005);
  if(idx<S.gold.length-1){
    const nextStart=S.gold[idx+1].start;
    if(t>nextStart+1e-9){
      if(Math.abs(S.gold[idx].end-nextStart)<ADJ_EPS){ pushStart(idx+1,t); t=Math.min(t,S.gold[idx+1].start); }
      else t=nextStart;
    }
  }else t=Math.min(t,total());
  S.gold[idx].end=t; S.touched.add(idx);
}
// Move word idx's START toward t, carrying the previous word's END along when they're flush.
function pushStart(idx,t){
  t=Math.min(t,S.gold[idx].end-.005);
  if(idx>0){
    const prevEnd=S.gold[idx-1].end;
    if(t<prevEnd-1e-9){
      if(Math.abs(S.gold[idx].start-prevEnd)<ADJ_EPS){ pushEnd(idx-1,t); t=Math.max(t,S.gold[idx-1].end); }
      else t=prevEnd;
    }
  }else t=Math.max(t,tmin());
  S.gold[idx].start=t; S.touched.add(idx);
}
// Dragging a whole word (both marks together, length fixed) is the same "push, don't clamp"
// idea as pushEnd/pushStart, just simpler: since the dragged word's length never changes,
// contact with a neighbour is just end>start (no flush check needed -- a real gap is consumed
// first, and only once the edge actually reaches the neighbour does it start moving). The
// cascade cannot run out of neighbours to push forever, so after cascading the whole chain
// is pulled back inside [tmin(),total()] as one block if it ran past either edge -- that
// includes the word being dragged, which is how the drag itself ends up clamped at the ends
// of the clip instead of at the first neighbour it touches.
function pushWord(idx){
  for(let i=idx;i<S.gold.length-1;i++){
    const delta=S.gold[i].end-S.gold[i+1].start;
    if(delta<=1e-9) break;
    S.gold[i+1].start+=delta; S.gold[i+1].end+=delta; S.touched.add(i+1);
  }
  for(let i=idx;i>0;i--){
    const delta=S.gold[i-1].end-S.gold[i].start;
    if(delta<=1e-9) break;
    S.gold[i-1].start-=delta; S.gold[i-1].end-=delta; S.touched.add(i-1);
  }
  const over=S.gold[S.gold.length-1].end-total();
  if(over>0) for(let i=idx;i<S.gold.length;i++){ S.gold[i].start-=over; S.gold[i].end-=over; }
  const under=tmin()-S.gold[0].start;
  if(under>0) for(let i=0;i<=idx;i++){ S.gold[i].start+=under; S.gold[i].end+=under; }
}
function setMark(t,which){
  which=which||S.edge;
  if(which==='start') pushStart(S.wi,t); else pushEnd(S.wi,t);
  S.touched.add(S.wi); ensureVisible(which==='start'?S.gold[S.wi].start:S.gold[S.wi].end);
  draw(); render();
  if(S.loopKind){ const sp=loopSpan(); start(sp[0],sp[1]); }
  else scheduleWordPlay();
}
const goWord=i=>{ const old=S.wi; S.wi=Math.max(0,Math.min(i,S.gold.length-1));
  if(S.wi>old) S.edge='start'; else if(S.wi<old) S.edge='end';
  fitWord(); draw(); render();
  if(S.loopKind){const sp=loopSpan(); start(sp[0],sp[1]);}
  else playWord();
};
const stepMark=dir=>{
  if(dir>0){
    if(S.edge==='start') S.edge='end';
    else if(S.wi<S.gold.length-1){S.wi++;S.edge='start';}
  }else{
    if(S.edge==='end') S.edge='start';
    else if(S.wi>0){S.wi--;S.edge='end';}
  }
  fitWord(); draw(); render();
  if(S.loopKind){const sp=loopSpan(); start(sp[0],sp[1]);}
  else playWord();
};

// Persist without advancing: a text correction is worth keeping the moment it is made,
// even on a clip whose boundaries are not finished.
async function save(){
  if(S.sampleMode||S.isReadOnly){ render(); return; }   // view-only: never tag, never call the server
  await fetch(api('/api/gold'),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({index:S.ci,key:S.clips[S.ci].key,words:S.gold,next:false})});
  S.clips[S.ci].saved=S.gold.map(w=>({...w}));
  render();
}

async function saveNext(){
  if(S.sampleMode||S.isReadOnly){ render(); return; }
  await fetch(api('/api/gold'),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({index:S.ci,key:S.clips[S.ci].key,words:S.gold,next:true})});
  S.clips[S.ci].saved=S.gold.map(w=>({...w}));
  S.clips[S.ci].done=true;
  if(S.ci<S.clips.length-1){S.ci++;await S.loadClip();} else render();
}

export {modified,srcWord,scheduleWordPlay,getPlayOnMark,setPlayOnMark,updatePlayingChip,
  chips,buildWords,insertWordAt,hideGapBtn,render,editWord,editActiveTime,editBarWord,
  shiftTouched,addWord,addWordBefore,createWordAt,untangleWords,resetToBaseline,delWord,
  pushWord,setMark,goWord,stepMark,save,saveNext};
