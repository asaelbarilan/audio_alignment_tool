import {S,$,api,mmss,setUrlParam} from '../state.js';
import {stop} from '../audio-engine.js';
import {cancelAlign} from '../align-client.js';
// main.js is not imported here: see the comment by its own S.openClip= assignment.

async function showOverview(){
  stop(); cancelAlign();
  $('evalScreen').classList.remove('on');
  $('evalLink').classList.remove('cur');
  $('workspace').style.display='none';
  $('overviewScreen').classList.add('on');
  $('overviewLink').classList.add('cur');
  $('taggingLink').style.display='';
  setUrlParam('view','overview');
  setUrlParam('clip',null);
  await loadOverview();
}

async function loadOverview(){
  try{
    const r=await fetch(api('/api/overview'));
    if(!r.ok){ alert('Failed to load overview ('+r.status+')'); return; }
    S.overviewData=await r.json();
    renderOverviewStats();
    populateOverviewFilters();
    renderOverviewList();
  }catch(err){
    console.error(err);
  }
}

function renderOverviewStats(){
  if(!S.overviewData||!S.overviewData.stats) return;
  const s=S.overviewData.stats;
  $('ovDatasetName').textContent=S.overviewData.dataset||'-';
  $('statOverallClips').textContent=s.overall_clips;
  $('statOverallMin').textContent=s.overall_minutes+'m';
  $('statSavedClips').textContent=s.saved_clips;
  const savedPct=s.overall_clips?Math.round((s.saved_clips/s.overall_clips)*100):0;
  $('statSavedPct').textContent=savedPct+'% of overall';
  $('statSavedMin').textContent=s.saved_minutes+'m';
  const savedMinPct=s.overall_minutes?Math.round((s.saved_minutes/s.overall_minutes)*100):0;
  $('statSavedMinPct').textContent=savedMinPct+'% of overall';
  $('statDoneClips').textContent=s.done_clips;
  const donePct=s.overall_clips?Math.round((s.done_clips/s.overall_clips)*100):0;
  $('statDonePct').textContent=donePct+'% of overall';
  $('statDoneMin').textContent=s.done_minutes+'m';
  const doneMinPct=s.overall_minutes?Math.round((s.done_minutes/s.overall_minutes)*100):0;
  $('statDoneMinPct').textContent=doneMinPct+'% of overall';
}

function populateOverviewFilters(){
  const userSelect=$('ovFilterUser');
  const prevVal=userSelect.value;
  userSelect.innerHTML='<option value="all">All claimants</option><option value="unclaimed">Unclaimed</option>';
  if(S.overviewData&&S.overviewData.annotators){
    S.overviewData.annotators.forEach(u=>{
      const opt=document.createElement('option');
      opt.value=u;
      opt.textContent=u+(u===S.WHO?' (you)':'');
      userSelect.appendChild(opt);
    });
  }
  userSelect.value=prevVal||'all';
}

function renderOverviewList(){
  if(!S.overviewData||!S.overviewData.clips) return;
  const doneFilter=$('ovFilterDone').value;
  const userFilter=$('ovFilterUser').value;
  const sortFilter=$('ovSort').value;
  const searchFilter=($('ovSearch').value||'').trim().toLowerCase();

  let filtered=S.overviewData.clips.filter(c=>{
    if(doneFilter==='done' && !c.done) return false;
    if(doneFilter==='not_done' && c.done) return false;
    if(userFilter==='unclaimed' && c.claimant) return false;
    if(userFilter!=='all' && userFilter!=='unclaimed' && c.claimant!==userFilter) return false;
    if(searchFilter){
      const matchId=c.id.toLowerCase().includes(searchFilter);
      const matchText=(c.text||'').toLowerCase().includes(searchFilter);
      if(!matchId && !matchText) return false;
    }
    return true;
  });

  if(sortFilter==='dur_asc'){
    filtered.sort((a,b)=>a.duration-b.duration);
  }else if(sortFilter==='dur_desc'){
    filtered.sort((a,b)=>b.duration-a.duration);
  }

  $('ovCount').textContent='Showing '+filtered.length+' of '+S.overviewData.clips.length+' clips';

  const list=$('ovList');
  list.innerHTML='';
  if(!filtered.length){
    list.innerHTML='<div style="color:#8a8f98;padding:20px;text-align:center">No matching clips found</div>';
    return;
  }

  filtered.forEach((c,idx)=>{
    const row=document.createElement('div');
    row.className='ovRow'+(c.claimed_by_me?' isMe':'');

    const iSpan=document.createElement('span');
    iSpan.className='ovIdx';
    iSpan.textContent=(idx+1)+'.';

    const idSpan=document.createElement('span');
    idSpan.className='ovId';
    idSpan.textContent=c.id.slice(0,8);
    idSpan.title=c.id;

    const textSpan=document.createElement('span');
    textSpan.className='ovText';
    textSpan.textContent=c.text||c.id;
    textSpan.title=c.text||c.id;

    const durSpan=document.createElement('span');
    durSpan.className='ovDur';
    durSpan.textContent=mmss(c.duration);

    const statusSpan=document.createElement('span');
    statusSpan.className='ovStatus';
    if(c.done){
      statusSpan.innerHTML='<span class="savedBadge done on">done</span>';
    }else if(c.saved){
      const whoList=c.saved_by&&c.saved_by.length?c.saved_by.join(', '):'';
      statusSpan.innerHTML='<span class="savedBadge on" title="Saved by: '+(whoList||'yes')+'">saved</span>';
    }
    if(c.claimant){
      const clPill=document.createElement('span');
      clPill.className='savedBadge';
      clPill.textContent=c.claimed_by_me?'claimed by you':c.claimant;
      if(c.claimed_by_me) clPill.style.color='#6aa0ff';
      statusSpan.appendChild(clPill);
    }else{
      const unPill=document.createElement('span');
      unPill.className='savedBadge';
      unPill.textContent='unclaimed';
      statusSpan.appendChild(unPill);
    }

    const actDiv=document.createElement('div');
    actDiv.className='ovActions';

    if(c.claimed_by_me){
      const editBtn=document.createElement('button');
      editBtn.className='btnEdit';
      editBtn.textContent='Edit';
      editBtn.onclick=()=>S.openClip(c.id, false);

      const viewBtn=document.createElement('button');
      viewBtn.className='btnView';
      viewBtn.textContent='View';
      viewBtn.onclick=()=>S.openClip(c.id, true);

      actDiv.append(editBtn, viewBtn);
    }else{
      if(c.claimable){
        const claimBtn=document.createElement('button');
        claimBtn.className='btnClaim';
        claimBtn.textContent='Claim';
        claimBtn.onclick=()=>claimClip(c.id);
        actDiv.appendChild(claimBtn);
      }
      const viewBtn=document.createElement('button');
      viewBtn.className='btnView';
      viewBtn.textContent='View';
      viewBtn.onclick=()=>S.openClip(c.id, true);
      actDiv.appendChild(viewBtn);
    }

    row.append(iSpan, idSpan, textSpan, durSpan, statusSpan, actDiv);
    list.appendChild(row);
  });
}

async function claimClip(key){
  try{
    const r=await fetch(api('/api/claim'),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key})
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok){
      alert(j.error||'Failed to claim clip');
      return;
    }
    await S.openClip(key, false);
  }catch(err){
    alert('Failed to claim clip: '+err);
  }
}

$('ovFilterDone').onchange=renderOverviewList;
$('ovFilterUser').onchange=renderOverviewList;
$('ovSort').onchange=renderOverviewList;
$('ovSearch').oninput=renderOverviewList;

export {showOverview,loadOverview,renderOverviewList,renderOverviewStats,populateOverviewFilters,claimClip};
