import {S,$,api,setUrlParam} from '../state.js';
import {stop} from '../audio-engine.js';
import {cancelAlign} from '../align-client.js';
// main.js is not imported here: see the comment by its own S.openClip= assignment.

// What each aligner is, so the table reads without a lookup.
const ALIGNER_DESC={
  'wav2vec2-hebrew':'CTC forced alignment &mdash; imvladikon/wav2vec2-xls-r-300m-hebrew',
  mms:'CTC forced alignment &mdash; Meta MMS, 1,130 languages, romanized',
  'mms-corrected':'MMS, then a shift per letter class and, before a pause, the end extended to where the sound stops',
  'whisper-stable-ts':'stable-ts align on faster-whisper &mdash; ivrit.ai whisper-large-v3-turbo',
  'mwa-buckeye':'Multilingual Word Aligner, buckeye checkpoint (arXiv 2606.10675) &mdash; the align button',
  'ivrit-ai':'timings shipped with the dataset (Whisper + stable-ts), not re-run here',
};
const fmtMs=v=>(v==null?'&ndash;':Math.round(v)+' ms');
const errClass=v=>v==null?'':(v<=50?'evGood':(v<=100?'evMid':'evBad'));

async function showEval(pick){
  stop(); cancelAlign();
  $('workspace').style.display='none';
  $('overviewScreen').classList.remove('on');
  $('overviewLink').classList.remove('cur');
  $('evalScreen').classList.add('on');
  $('evalLink').classList.add('cur');
  $('taggingLink').style.display='';
  setUrlParam('view','eval');
  setUrlParam('clip',null);
  $('evDlMarks').href=api('/api/export');
  let d;
  try{
    const r=await fetch(api('/api/eval-results'));
    if(!r.ok){ $('evSummary').textContent='Could not list results ('+r.status+').'; return; }
    d=await r.json();
  }catch(e){ $('evSummary').textContent='Could not reach the server.'; return; }
  S.evalList=d.results||[];
  $('evUpWrap').hidden=!d.can_upload;
  $('evDeleteBtn').style.display=S.evalList.length?'':'none';
  const want=pick||new URL(location.href).searchParams.get('result')||S.evalCur;
  const cur=S.evalList.find(e=>e.id===want)||S.evalList[0];
  $('evPick').innerHTML=S.evalList.map(e=>'<option value="'+e.id+'">'
    +String(e.title||e.id).replace(/</g,'&lt;')+' &middot; '+(e.created_at||e.uploaded_at||'').slice(0,10)
    +'</option>').join('');
  if(!cur){
    S.evalCur=null; S.evalData=null;
    $('evDlResults').style.display='none';
    $('evMeta').textContent='';
    renderEval({});
    $('evSummary').textContent='No results uploaded yet.'+(d.can_upload?' Upload a result.json from eval-forced-alignment.':'');
    return;
  }
  $('evPick').value=cur.id;
  await loadEvalResult(cur.id);
}

async function loadEvalResult(id){
  $('evSummary').textContent='Loading...';
  const url=api('/api/eval-results/'+encodeURIComponent(id));
  $('evDlResults').href=url; $('evDlResults').style.display='';
  $('evDlResults').download=id+'.json';
  let d;
  try{
    const r=await fetch(url);
    if(!r.ok){ $('evSummary').textContent='Could not load that result ('+r.status+').'; return; }
    d=await r.json();
  }catch(e){ $('evSummary').textContent='Could not load that result.'; return; }
  S.evalCur=id; S.evalData=d;
  setUrlParam('result',id);
  renderEvalMeta(d);
  renderEval(d);
}

// Where the result came from, and which aligners it could not run, so a missing row says why.
function renderEvalMeta(d){
  const esc=v=>String(v==null?'':v).replace(/[&<]/g,c=>c==='&'?'&amp;':'&lt;');
  const inp=d.input||{};
  let m='Input: <b>'+esc(inp.ref)+'</b>'+(inp.revision?' @ <code>'+esc(String(inp.revision).slice(0,12))+'</code>':'')
    +(inp.rows!=null?' &middot; '+inp.rows+' marks on '+inp.clips+' clips':'')
    +' &middot; computed '+esc((d.created_at||'').replace('T',' ').slice(0,16))
    +(d.producer&&d.producer.git?' by eval-forced-alignment <code>'+esc(d.producer.git)+'</code>':'');
  const st=d.aligner_status||{};
  const off=Object.entries(st).filter(([,s])=>s.status!=='ok'&&s.status!=='imported');
  if(off.length) m+='<br>Not scored: '+off.map(([n,s])=>'<b>'+esc(n)+'</b> ('+esc(s.reason||s.status)+')').join('; ');
  const imp=Object.entries(st).filter(([,s])=>s.status==='imported');
  if(imp.length) m+='<br>Aligned on another machine: '+imp.map(([n,s])=>esc(n)
    +(s.provenance&&s.provenance.host?' on '+esc(s.provenance.host):'')).join(', ');
  const failed=Object.entries(st).filter(([,s])=>s.failed&&s.failed.length);
  if(failed.length) m+='<br>Clips an aligner could not align: '+failed.map(([n,s])=>esc(n)+' '+s.failed.length).join(', ');
  $('evMeta').innerHTML=m;
}

$('evPick').onchange=()=>loadEvalResult($('evPick').value);
$('evUploadBtn').onclick=()=>$('evUpload').click();
$('evUpload').onchange=async()=>{
  const f=$('evUpload').files[0]; $('evUpload').value='';
  if(!f) return;
  $('evSummary').textContent='Uploading '+f.name+'...';
  try{
    const r=await fetch(api('/api/eval-results'),{method:'POST',headers:{'Content-Type':'application/json'},body:await f.text()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ $('evSummary').textContent='Upload refused: '+(d.error||r.status); return; }
    await showEval(d.id);
  }catch(e){ $('evSummary').textContent='Upload failed: '+e; }
};
$('evDeleteBtn').onclick=async()=>{
  if(!S.evalCur||!confirm('Delete this result from the site? The file itself is not affected.')) return;
  const r=await fetch(api('/api/eval-results/delete'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:S.evalCur})});
  if(!r.ok){ alert('Could not delete ('+r.status+')'); return; }
  S.evalCur=null; setUrlParam('result',null);
  await showEval();
};

// The result's own alignments for a clip, as lanes: those are what was scored, and the
// dataset's labels may be older runs or absent. The first annotator's words are used when
// several people marked the clip, since each got their own alignment.
function evalLanes(id){
  const c=S.evalData&&S.evalData.clip_data&&S.evalData.clip_data[id];
  if(!c||!c.labels) return null;
  return Object.entries(c.labels).map(([name,byWho])=>{
    const who=Object.keys(byWho).sort()[0];
    return {source:name, words:byWho[who]};
  }).filter(l=>l.words&&l.words.length);
}

function renderEval(d){
  const people=Object.entries(d.annotators||{}).map(([n,c])=>n+' '+c).join(', ');
  $('evSummary').innerHTML=d.marked_clips
    ? '<b>'+d.marked_clips+'</b> clips marked by '+people
      +(d.left_out&&d.left_out.length?' &middot; left out (test accounts): '+d.left_out.join(', '):'')
    : 'No marked clips yet.';
  const ranked=Object.entries(d.aligners||{}).filter(([,s])=>s.boundaries)
    .sort((a,b)=>a[1].p90_ms-b[1].p90_ms);
  if(!ranked.length){
    $('evTable').innerHTML='<tr><td class="evEmpty">Nothing scored in this result.</td></tr>';
    $('evBars').innerHTML=''; $('evClips').innerHTML=''; $('evLegend').textContent='';
    $('evSig').innerHTML=''; $('evWarn').hidden=true;
    return;
  }
  // A value with its 95% interval underneath, from resampling clips.
  const withCi=(v,ci,unit)=>{
    const main=(v==null?'&ndash;':(unit==='%'?v+'%':Math.round(v)+' ms'));
    if(!ci) return main;
    const lo=unit==='%'?ci[0]:Math.round(ci[0]), hi=unit==='%'?ci[1]:Math.round(ci[1]);
    return main+'<span class="evCi">'+lo+'&ndash;'+hi+'</span>';
  };
  const TOL=[10,25,50,100];
  const row=(name,s,cls)=>{
    const ci=s.ci||{}, e=s.ends||{};
    const seedTag=(d.seed&&name===d.seed)?'<span class="evSeed">marks started here &mdash; flattered</span>':'';
    const desc=((d.aligner_status||{})[name]||{}).description||ALIGNER_DESC[name];
    return '<tr class="'+cls+'"><td><span class="evName">'+name+'</span>'
      +(desc?'<span class="evDesc">'+desc+'</span>':'')+seedTag+'</td>'
      +'<td class="'+errClass(s.median_ms)+'">'+withCi(s.median_ms,ci.median_ms,'ms')+'</td>'
      +'<td class="'+errClass(s.p90_ms)+'">'+withCi(s.p90_ms,ci.p90_ms,'ms')+'</td>'
      +TOL.map(x=>'<td>'+withCi(s['within_'+x+'ms'],ci['within_'+x+'ms'],'%')+'</td>').join('')
      +'<td class="evEnds '+errClass(e.median_ms)+'">'+fmtMs(e.median_ms)+'</td>'
      +'<td class="evEnds '+errClass(e.p90_ms)+'">'+fmtMs(e.p90_ms)+'</td>'
      +'<td class="evEnds">'+(e.within_50ms!=null?e.within_50ms+'%':'&ndash;')+'</td>'
      +(hasUnmoved?'<td>'+(s.unmoved_pct!=null?s.unmoved_pct+'%':'&ndash;')+'</td>':'')+'</tr>';
  };
  const hasUnmoved=ranked.some(([,s])=>s.unmoved_pct!=null);
  let t='<tr><th>aligner</th><th>median</th><th>p90</th>'
    +TOL.map(x=>'<th>&le;'+x+' ms</th>').join('')
    +'<th class="evEnds" title="Word ends only. MWA predicts nothing else: its starts are '
    +'copied from the end of the word before it by its own writer, so this is the fair '
    +'column">ends: median</th><th class="evEnds">ends: p90</th>'
    +'<th class="evEnds">ends: &le;50 ms</th>'
    +(hasUnmoved?'<th title="Human boundaries left exactly where this aligner put them">unmoved</th>':'')+'</tr>';
  ranked.forEach(([n,s],i)=>{ t+=row(n,s,i===0&&n!==d.seed?'best':''); });
  const h=d.human_agreement;
  if(h){
    const hc=h.ci||{};
    t+='<tr class="floor"><td>two humans, same clip<span class="evDesc">'+h.boundaries
      +' boundaries, '+(h.clips||'?')+' clips</span></td><td>'+withCi(h.median_ms,hc.median_ms,'ms')
      +'</td><td>'+withCi(h.p90_ms,hc.p90_ms,'ms')+'</td>'
      +TOL.map(x=>'<td>'+withCi(h['within_'+x+'ms'],hc['within_'+x+'ms'],'%')+'</td>').join('')
      +'<td class="evEnds">'+fmtMs((h.ends||{}).median_ms)+'</td>'
      +'<td class="evEnds">'+fmtMs((h.ends||{}).p90_ms)+'</td>'
      +'<td class="evEnds">'+(((h.ends||{}).within_50ms!=null)?h.ends.within_50ms+'%':'&ndash;')+'</td>'
      +(hasUnmoved?'<td></td>':'')+'</tr>';
  }
  $('evTable').innerHTML=t;
  renderSignificance(d);

  $('evBars').innerHTML=ranked.map(([n,s])=>'<div class="evBar"><span>'+n+'</span>'
    +'<div class="evTrack"><div class="evFill" style="width:'+s.within_100ms+'%"></div>'
    +(h?'<div class="evFloor" style="left:'+h.within_100ms+'%"></div>':'')+'</div>'
    +'<span>'+s.within_100ms+'%</span></div>').join('');
  $('evLegend').textContent=h
    ? 'White line: two people on the same clip agree within 100 ms on '+h.within_100ms+'% of boundaries.'
    : 'No clip has been marked by two people yet, so there is no human reference line.';

  const names=ranked.map(([n])=>n);
  const clipsRows=Object.entries(d.clips||{}).map(([id,c])=>{
    const vals=names.map(n=>c[n]).filter(v=>v!=null);
    return {id,c,worst:vals.length?Math.max(...vals):-1};
  }).sort((a,b)=>b.worst-a.worst);
  let ct='<tr><th></th><th>clip</th><th>recording</th>'+names.map(n=>'<th>'+n+'</th>').join('')+'</tr>';
  clipsRows.forEach(({id,c})=>{
    ct+='<tr class="clip" data-id="'+id+'"><td><a class="evOpen" href="?clip='+encodeURIComponent(id)
      +'&aligners=all" title="Open this clip with every aligner shown">open &#9656;</a></td><td><span class="evText">'
      +String(c._text||'').replace(/</g,'&lt;')+'</span></td><td>'+(c._recording||'')+'</td>'
      +names.map(n=>'<td class="'+errClass(c[n])+'">'+fmtMs(c[n])+'</td>').join('')+'</tr>';
  });
  $('evClips').innerHTML=ct;
  $('evClips').querySelectorAll('tr.clip').forEach(tr=>{
    tr.onclick=e=>{
      // A plain click opens in place; ctrl/cmd-click on the link opens a new tab as usual.
      if(e.target.closest('a')&&(e.ctrlKey||e.metaKey||e.shiftKey)) return;
      e.preventDefault();
      S.alnForceAll=true; S.alnSig=null;
      $('evalScreen').classList.remove('on'); $('evalLink').classList.remove('cur');
      S.openClip(tr.dataset.id, false, evalLanes(tr.dataset.id));
    };
  });
}

// The seed warning and the pairwise tests. Kept apart from the main table so the numbers
// and the question "should I believe this ranking?" read as separate things.
function renderSignificance(d){
  const w=$('evWarn');
  const seed=d.seed, ss=seed&&d.aligners&&d.aligners[seed];
  if(ss && ss.unmoved_pct!=null){
    w.hidden=false;
    w.innerHTML='<b>Not a fair test for '+seed+'.</b> The tool opens every clip on '+seed
      +'\'s boundaries, and '+ss.unmoved_pct+'% of the human boundaries were never moved. '
      +'Each of those counts as '+seed+' being exactly right, whether anyone checked it or '
      +'not, so its scores are flattered. A comparison it <i>wins</i> may owe the win to that; '
      +'one it <i>loses</i> was lost despite it, and still holds.';
  } else w.hidden=true;

  const tests=d.comparisons||[];
  if(!tests.length){
    $('evSig').innerHTML='<tr><td class="evEmpty">Needs at least two aligners scored on the same clips.</td></tr>';
    return;
  }
  const label={p90_ms:'p90',within_50ms:'within 50 ms'};
  let s='<tr><th>comparison</th><th>measure</th><th>difference</th><th>95% interval</th>'
    +'<th>p (corrected)</th><th>verdict</th></tr>';
  tests.forEach(t=>{
    const unit=t.metric.startsWith('within_')?' pts':' ms';
    const verdict=t.significant
      ?'<span class="evYes">real &mdash; '+t.better+' is better</span>'
      :'<span class="evNo">could be chance</span>';
    const unfair=t.fair===false
      ?'<span class="evUnfair">unfair: marks started from '+seed+'</span>'
      :(t.seed_lost_anyway?'<span class="evRobust">holds despite '+seed+'\'s head start</span>':'');
    const basis=t.edges==='end'?'<span class="evEndsTag">ends only</span>':'';
    s+='<tr><td>'+t.a+' vs '+t.b+unfair+'</td><td>'+(label[t.metric]||t.metric)+basis+'</td>'
      +'<td>'+(t.diff>0?'+':'')+t.diff+unit+'</td><td>'+t.ci[0]+' to '+t.ci[1]+'</td>'
      // No redrawn sample crossed zero: that bounds p below the resolution of the draws,
      // it does not make it zero.
      +'<td>'+(t.p_holm===0?'&lt; 0.001':t.p_holm)+'</td><td>'+verdict+'</td></tr>';
  });
  $('evSig').innerHTML=s;
}

export {showEval,loadEvalResult,evalLanes,renderEval,renderSignificance};
