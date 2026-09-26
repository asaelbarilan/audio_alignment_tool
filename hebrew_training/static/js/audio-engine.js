import {S,$} from './state.js';
import {draw} from './canvas-draw.js';

const total=()=>S.buf?S.buf.duration-S.lead:0;
// The served audio starts `lead` seconds BEFORE the row, so time -lead is the first sample
// that exists. Clamping marks at 0 made the leading context visible but unreachable, which
// is wrong twice over: the row's own start came from the same aligner being judged, so the
// true word start can genuinely lie before it. Everything drawn is now reachable.
const tmin=()=>-S.lead;
const mark=()=>S.edge==='end'?S.gold[S.wi].end:S.gold[S.wi].start;

// ---- transport -----------------------------------------------------------
// Playback runs on the Web Audio clock, not on an <audio> element.
//
// The element reported exact times -- seeks landed to the microsecond and currentTime
// advanced in ~6ms steps -- but a bounded region still took 50ms longer than it should at
// 1x and 100ms at 0.5x, because play() and pause() are not instant. That slop is audible at
// exactly the moment it matters: asking to hear "up to the mark" played past the mark, so
// the boundary you are trying to judge is not the boundary you hear.
//
// A buffer source is scheduled instead: start(when, offset, duration) begins and ends in
// the audio thread, sample-accurate, with nothing polling and no start-up cost per region.
let srcNode=null, ctxT0=0, headT0=0;
let rate=1;

// Slower speeds still must not drop the pitch, and Web Audio has no time-stretch of its own
// (playbackRate resamples, which is the pitch drop we removed earlier). So the buffer is
// stretched once per speed, overlap-add with a short correlation search to keep successive
// windows in phase, and then played at 1x. Cached: a clip is a few seconds and there are
// four non-unity speeds.
function stretched(r){
  if(r===1) return S.buf;
  const key=r+'@'+S.ci;
  if(S.stretchCache.has(key)) return S.stretchCache.get(key);
  const sr=S.buf.sampleRate, inp=S.buf.getChannelData(0);
  const N=Math.round(0.046*sr), Hs=N>>1, Ha=Math.max(1,Math.round(Hs*r));
  const search=Math.round(0.008*sr);
  const outLen=Math.ceil(inp.length/r)+N;
  const out=new Float32Array(outLen);
  const win=new Float32Array(N);
  for(let i=0;i<N;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));
  let ai=0, si=0, prev=null;
  while(ai+N<inp.length && si+N<outLen){
    let at=Math.round(ai);
    if(prev){
      let bestScore=-Infinity, best=at;
      const lo=Math.max(0,at-search), hi=Math.min(inp.length-N,at+search);
      for(let c=lo;c<=hi;c+=2){
        let acc=0;
        for(let k=0;k<Hs;k+=4) acc+=inp[c+k]*prev[k];
        if(acc>bestScore){bestScore=acc;best=c;}
      }
      at=best;
    }
    for(let k=0;k<N;k++) out[si+k]+=inp[at+k]*win[k];
    prev=inp.subarray(at+Hs, at+Hs+Hs);
    ai+=Ha; si+=Hs;
  }
  const b=S.ctx.createBuffer(1,outLen,sr);
  b.copyToChannel(out,0);
  S.stretchCache.set(key,b);
  return b;
}

function now(){
  if(!S.playing) return S.head;
  return Math.max(tmin(), Math.min(headT0+(S.ctx.currentTime-ctxT0)*rate, total()));
}
function label(){ $('play').innerHTML = S.playing?'&#10074;&#10074; pause':'&#9654; play'; }
function stop(){
  if(S.playing) S.head=now();
  if(srcNode){ srcNode.onended=null; try{srcNode.stop();}catch(e){} srcNode=null; }
  S.playing=false; label();
}
function start(from,to){
  if(!S.buf)return;
  stop();
  S.seg=(to!=null)?[from,to]:null;
  S.head=Math.max(tmin(),Math.min(from,total()));
  if(to!=null && to-S.head<=.01){draw();return;}
  if(S.ctx.state==='suspended') S.ctx.resume();
  const b=stretched(rate);
  // App time -> offset in the (possibly stretched) buffer. Time 0 is `lead` into the clip,
  // because PAD seconds of context are served before it.
  const offset=(S.head+S.lead)/rate;
  const dur=(to!=null? to-S.head : total()-S.head)/rate;
  if(!(dur>0)) {draw();return;}
  const src=S.ctx.createBufferSource();
  src.buffer=b; src.connect(S.ctx.destination);
  src.onended=()=>{
    if(src!==srcNode) return;          // superseded by a newer region
    srcNode=null;
    if(S.loopKind){ const sp=loopSpan(); start(sp[0],sp[1]); return; }
    S.playing=false; S.head=(to!=null)?to:total(); label(); draw();
  };
  src.start(S.ctx.currentTime, Math.max(0,offset), dur);
  srcNode=src; ctxT0=S.ctx.currentTime; headT0=S.head;
  S.playing=true; label();
}
function loopSpan(){
  return S.loopKind==='word' ? [S.gold[S.wi].start,S.gold[S.wi].end]
       : [Math.max(tmin(),mark()-.35), Math.min(total(),mark()+.35)];
}
function setLoop(kind){
  S.loopKind=(S.loopKind===kind)?null:kind;
  $('loopWord').classList.toggle('on',S.loopKind==='word');
  $('loopMark').classList.toggle('on',S.loopKind==='mark');
  if(S.loopKind){ const sp=loopSpan(); start(sp[0],sp[1]); } else stop();
}
function toggle(){
  if(S.playing){ stop(); draw(); return; }
  // Playing a region (word, up-to-mark, after-mark) leaves the playhead exactly at that
  // region's end with seg still set, so the next press asked for a zero-length span and
  // silently did nothing -- the transport looked frozen. Finishing a region falls back to
  // free play, and reaching the end of the clip rewinds.
  if(S.seg && S.head>=S.seg[1]-0.005) S.seg=null;
  if(S.head>=total()-0.005) S.head=tmin();
  start(S.head,S.seg?S.seg[1]:null);
}
function moveHead(t){
  const wasPlaying=S.playing;
  S.head=Math.max(tmin(),Math.min(t,total()));
  if(wasPlaying){ start(S.head,null); return; }   // playing: restart from the new spot
  S.seg=null; draw();                              // paused: just draw, no seek, no lag
}
const playWord  =()=>start(S.gold[S.wi].start,S.gold[S.wi].end);
const playBefore=()=>start(Math.max(tmin(),mark()-.45),mark());
const playAfter =()=>start(mark(),Math.min(total(),mark()+.45));

function getRate(){ return rate; }
function setRate(r){ rate=r; }

export {total,tmin,mark,now,label,stop,start,loopSpan,setLoop,toggle,moveHead,
  playWord,playBefore,playAfter,stretched,getRate,setRate};
