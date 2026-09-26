import {$,api,fail,setUrlParam} from '../state.js';
import {stop} from '../audio-engine.js';
import {cancelAlign} from '../align-client.js';

async function showApprovals(){
  stop(); cancelAlign();
  $('workspace').style.display='none';
  $('overviewScreen').classList.remove('on');
  $('evalScreen').classList.remove('on');
  $('approveScreen').classList.add('on');
  setUrlParam('view','approvals'); setUrlParam('clip',null);
  let list=[];
  try{
    const r=await fetch(api('/api/waiting'));
    if(!r.ok) return fail('Could not load the queue ('+r.status+').');
    list=await r.json();
  }catch(e){ return fail('Could not load the queue: '+e.message); }
  if(!list.length){
    $('appTable').innerHTML='<tr><td class="appNone">Nobody is waiting.</td></tr>';
    return;
  }
  $('appTable').innerHTML='<tr><th>name</th><th>google account</th><th>since</th><th></th></tr>'
    +list.map(p=>'<tr data-sub="'+p.sub+'"><td>'+p.name+'</td><td>'+(p.display||'')
      +' &middot; '+(p.email||'')+'</td><td>'+(p.since||'').slice(0,10)
      +'</td><td><button class="appBtn">let in</button></td></tr>').join('');
  $('appTable').querySelectorAll('button').forEach(b=>{
    b.onclick=async ()=>{
      const tr=b.closest('tr'); b.disabled=true; b.textContent='...';
      try{
        const r=await fetch(api('/api/approve'),{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sub:tr.dataset.sub})});
        if(!r.ok) throw new Error('the server said '+r.status);
        tr.remove();
        if(!$('appTable').querySelector('tr[data-sub]')) showApprovals();
      }catch(e){ b.disabled=false; b.textContent='let in'; fail('Could not let them in: '+e.message); }
    };
  });
}

export {showApprovals};
