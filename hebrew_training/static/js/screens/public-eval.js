import {S,$,api,setUrlParam,setTitle,EVAL_TITLE} from '../state.js';
import {renderEvalMeta,renderEval} from './eval.js';

// The public landing view: no sign-in, no clip picker, just whatever an approver pinned via
// "Set as Public" on the admin eval screen. A visitor can still open any clip from the
// per-clip table -- its audio and marks come from routes the server serves without a
// sign-in (see /api/audio and /api/clip-marks in align_tag_server.py); nothing here needs
// a claim, a save, or an identity.
async function showPublicEval(){
  $('gate').classList.remove('on');
  $('waitScreen').style.display='none';
  $('workspace').style.display='none';
  $('overviewScreen').classList.remove('on'); $('overviewLink').classList.remove('cur');
  $('evalScreen').classList.remove('on'); $('evalLink').classList.remove('cur');
  $('approveScreen').classList.remove('on');
  $('publicEvalScreen').classList.add('on');
  $('taggingLink').style.display='';
  S.taggingEntered=false;
  setTitle(EVAL_TITLE);
  setUrlParam('clip',null);
  $('pubEmpty').hidden=true; $('pubResults').hidden=true;
  let d;
  try{
    const r=await fetch(api('/api/public-eval'));
    if(!r.ok){
      $('pubEmpty').hidden=false; $('pubEmptyText').textContent='Could not load results ('+r.status+').';
      setUrlParam('result',null);
      return;
    }
    d=await r.json();
  }catch(e){
    $('pubEmpty').hidden=false; $('pubEmptyText').textContent='Could not reach the server.';
    setUrlParam('result',null);
    return;
  }
  if(!d.has_public){
    $('pubEmpty').hidden=false;
    $('pubEmptyText').textContent='An administrator must upload and designate a public evaluation result.';
    setUrlParam('result',null);
    return;
  }
  $('pubResults').hidden=false;
  // A bookmark or reload of ?clip=...&result=... is what tells boot() a clip link is part of
  // this public preview, rather than a tagging deep link an unauthenticated visitor has no
  // business opening -- see openPublicClip() in main.js.
  setUrlParam('result',d.id);
  // evalLanes() (called when a clip is opened from the per-clip table below) reads this --
  // without it every "open" click would look like a plain, unclaimed live clip instead of a
  // frozen eval preview.
  S.evalCur=d.id; S.evalData=d.result;
  renderEvalMeta(d.result,'pub');
  // A public visitor can open a clip too: the audio and its marks are read-only routes the
  // server serves without a sign-in, same as the summary tables above.
  renderEval(d.result,'pub',true);
}

export {showPublicEval};
