
const PARAMS=new URLSearchParams(location.search);
const TOK=PARAMS.get('t')||'';
const $=id=>document.getElementById(id);

// This page is one closure end to end -- drawing reads marks, marks read playback,
// playback reads the clip, the clip list reads who's signed in -- so instead of pretending
// each module owns a clean slice of state, every module that needs to read or write it
// imports S and touches its properties directly. Mutating a property (S.gold=...) is
// visible to every other module; only rebinding the name S itself would not be, and
// nothing does that.
const S={
  WHO: PARAMS.get('who')||localStorage.getItem('tagWho')||'',
  clips:[], ci:0, wi:0, edge:'end', gold:[], touched:new Set(),
  sampleMode:false, sampleCsv:null, sampleWav:null, sampleBaseline:null,
  buf:null, lead:0, ctx:null, peaks:null,
  playing:false, head:0, loopKind:null, seg:null,
  specCanvas:null, specData:null, snapPoints:[],
  snapThreshRatio: parseFloat(localStorage.getItem('tagSnapThresh')||'0.42'),
  snapMinSepMs: parseInt(localStorage.getItem('tagSnapMinSep')||'20',10),
  snapShow: localStorage.getItem('tagSnapShow')==='1',
  view:null,
  ME:null, isReadOnly:false, currentClipDetail:null, overviewData:null,
  evalList:[], evalCur:null, evalData:null,
  alnShown:new Set(), alnSig:null,
  // Opened from the eval dashboard: show every aligner, since comparing them is why you came.
  alnForceAll:(new URLSearchParams(location.search).get('aligners')==='all'),
  stretchCache:new Map(),
};
try{ S.alnShown=new Set(JSON.parse(localStorage.getItem('alnShown')||'[]')); }catch(e){}

// Hosted, the token gates the whole server and `who` decides which file a save lands in,
// so both have to ride along on every request.
function api(path){
  const [base,qs]=path.split('?');
  const q=new URLSearchParams(qs||'');
  if(TOK && !q.has('t')) q.set('t',TOK);
  if(S.WHO && !q.has('who')) q.set('who',S.WHO);
  const s=q.toString();
  return s ? base+'?'+s : base;
}

// Nothing in this page used to say when it broke. boot() is fired and forgotten, so a
// single failed fetch left a half-drawn screen and no message -- indistinguishable, from
// the outside, from a page that is merely slow. Every error now names itself on screen.
function fail(msg){
  let b=$('pageErr');
  if(!b){
    b=document.createElement('div');
    b.id='pageErr';
    b.onclick=()=>{b.style.display='none';};
    document.body.insertBefore(b,document.body.firstChild);
  }
  b.textContent=msg+'  — click to dismiss';
  b.style.display='block';
  console.error(msg);
}
// The server stamps the build of the file it just served here. A browser running an older
// copy out of its cache is the one failure this page cannot detect by looking at itself --
// it worked, against a server that had moved on. So it asks, once, and reloads past the
// cache if the answer differs. The sessionStorage guard is what stops a proxy that keeps
// serving the old copy from turning this into a reload loop.
// main.js is served from static/ and cache-busted by its content hash, so it cannot carry
// the build placeholder itself -- substituting it here would change the very bytes whose
// hash decides the build. The one substitution page() still does lands in the HTML instead,
// in a global this file only reads.
const BUILD=window.PAGE_BUILD;
async function checkBuild(){
  try{
    const d=await (await fetch('/api/progress',{cache:'no-store'})).json();
    if(!d.build || d.build===BUILD) return false;
    const seen='reloaded-for-'+d.build;
    if(sessionStorage.getItem(seen)){
      fail('This page is an old copy (build '+BUILD+', the server has '+d.build
        +') and reloading did not replace it. Press Ctrl+Shift+R.');
      return false;
    }
    sessionStorage.setItem(seen,'1');
    const u=new URL(location.href);
    u.searchParams.set('b',d.build);
    location.replace(u.toString());
    return true;
  }catch(e){ return false; }
}
addEventListener('error',e=>fail('The page hit an error: '+(e.message||e.error)));
addEventListener('unhandledrejection',e=>{
  const r=e.reason;
  fail('The page hit an error: '+((r&&r.message)||r));
});

const f3=t=>t.toFixed(3);
const mmss=t=>{t=Math.max(0,t);return Math.floor(t/60)+':'+(t%60).toFixed(2).padStart(5,'0');};

const NAME=/^[A-Za-z0-9_-]{1,32}$/;

function setUrlParam(key, val){
  const u=new URL(location.href);
  if(val!==null && val!==undefined) u.searchParams.set(key,val);
  else u.searchParams.delete(key);
  history.pushState(null,'',u.pathname+u.search);
}

export {PARAMS,TOK,S,api,$,fail,BUILD,checkBuild,f3,mmss,NAME,setUrlParam};
