import {S,$,api,NAME} from '../state.js';
import {showApprovals} from './approvals.js';
// main.js is not imported here: see the comment by its own S.load= assignment.

function showWaiting(){
  $('gate').classList.remove('on');
  $('workspace').style.display='none';
  $('waitScreen').style.display='block';
  $('waitWho').textContent='Signed in as '+((S.ME&&S.ME.display)||'')+
    ((S.ME&&S.ME.email)?' ('+S.ME.email+')':'')+', filed under the name '+((S.ME&&S.ME.name)||'');
  $('me').innerHTML='waiting for approval'
    +(S.ME&&S.ME.logout_url?' &middot; <a href="'+S.ME.logout_url+'">sign out</a>':'');
}

function started(){
  $('gate').classList.remove('on');
  $('me').innerHTML='marking as <b>'+S.WHO+'</b>'
    +(S.ME&&S.ME.display?' &middot; '+S.ME.display:'')
    +(S.ME&&S.ME.logout_url?' &middot; <a href="'+S.ME.logout_url+'">sign out</a>':'');
  if(S.ME&&S.ME.admin){
    $('approveLink').style.display='';
    $('approveLink').textContent='approvals'+(S.ME.waiting?' ('+S.ME.waiting+')':'');
    $('approveLink').onclick=e=>{ e.preventDefault(); showApprovals(); };
  }
  // Someone still in the queue gets the read-only tour, not the tagging screen: every
  // write is refused server-side anyway, and letting them mark for an hour before finding
  // that out would be worse than saying so up front.
  if(S.ME&&S.ME.auth&&S.ME.approved===false) return showWaiting();
  S.load();
}

function signIn(){
  const g=$('gate'); g.classList.add('on');
  $('whoform').hidden=true;
  $('gatetext').textContent='Sign in so your marks are yours: nobody else can save under '
    +'your name, and you keep the same work across devices.';
  const b=$('gsignin'); b.hidden=false;
  // --local-auth stands in for the whole gate, including this label -- a real "Sign in
  // with Google" button that does not talk to Google would be the confusing part.
  b.textContent=(S.ME&&S.ME.local_auth)?'Sign in (local)':'Sign in with Google';
  b.onclick=()=>{ location.href=S.ME.login_url; };
}

function showMigrate(){
  const g=$('mgate'); g.classList.add('on');
  $('miggo').onclick=async ()=>{
    const b=$('miggo'); b.disabled=true; $('migerr').textContent='';
    try{
      const r=await fetch(api('/api/migrate'),{method:'POST'});
      const j=await r.json().catch(()=>({}));
      if(!r.ok){ $('migerr').textContent=j.error||('Migration failed ('+r.status+')');
        b.disabled=false; return; }
      $('migtext').textContent='Migration complete. Your marks were rewritten in place. '
        +'Reload to start marking.';
      b.textContent='Reload'; b.disabled=false;
      b.onclick=()=>location.reload();
    }catch(err){ $('migerr').textContent='Migration failed: '+err; b.disabled=false; }
  };
}

function gate(authed){
  const g=$('gate'); g.classList.add('on');
  $('gsignin').hidden=true; $('whoform').hidden=false;
  if(authed){
    $('gatetext').textContent='Signed in as '+S.ME.display
      +'. Pick the name your marks are filed under — if you have marked before, '
      +'type that same name to claim your existing work.';
    if(!$('whoin').value) $('whoin').value=(S.ME.email||'').split('@')[0].slice(0,32);
  }
  $('whoin').focus(); $('whoin').select();
  const go=async ()=>{
    const v=$('whoin').value.trim();
    if(!NAME.test(v)){ $('whoerr').textContent=
      'Letters, digits, - and _ only, up to 32 characters.'; return; }
    if(authed){
      const r=await fetch(api('/api/claim-name'),{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({name:v})});
      if(r.status===409){ $('whoerr').textContent=
        'That name belongs to another account. Pick a different one.'; return; }
      if(!r.ok){ $('whoerr').textContent='Could not save that name. Try again.'; return; }
      // /api/me was fetched before this name existed, so the copy in ME is now stale --
      // and it is what the waiting screen prints back at them.
      S.WHO=v; if(S.ME) S.ME.name=v; return started();
    }
    S.WHO=v; localStorage.setItem('tagWho',v);
    g.classList.remove('on'); $('me').textContent='marking as '+S.WHO;
    S.load();
  };
  // A real form, so Enter submits the way it does in every other text box, rather than
  // riding on a keydown handler.
  $('whoform').onsubmit=e=>{ e.preventDefault(); go(); };
}

export {showWaiting,started,signIn,showMigrate,gate};
