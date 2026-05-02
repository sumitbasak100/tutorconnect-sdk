/**
 * TutorConnect SDK v4
 * Join URLs now point to /lobby/:roomId/:userId (pre-join screen)
 * which redirects to /session/:roomId/:userId after device check.
 */
(function(g){"use strict";
class TutorConnect{
  constructor({host=""}={}){this.host=host.replace(/\/$/,"")}
  async createSession({tutor,student,metadata={}}={}){
    if(!tutor?.userId||!tutor?.name) throw new Error("tutor.userId and tutor.name required");
    if(!student?.userId||!student?.name) throw new Error("student.userId and student.name required");
    const r=await fetch(`${this.host}/api/rooms`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tutor,student,metadata})});
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||`HTTP ${r.status}`);}
    const d=await r.json();
    // Rewrite join URLs to go through lobby
    const rewrite=url=>url.replace("/session/","/lobby/");
    return {...d, tutorJoinUrl:rewrite(d.tutorJoinUrl), studentJoinUrl:rewrite(d.studentJoinUrl)};
  }
  async getSession(id){const r=await fetch(`${this.host}/api/rooms/${id}`);if(!r.ok)throw new Error("Not found");return r.json().then(d=>d.room);}
  async getSummary(id){const r=await fetch(`${this.host}/api/rooms/${id}/summary`);if(!r.ok)throw new Error("Not found");return r.json();}
  async endSession(id){return fetch(`${this.host}/api/rooms/${id}`,{method:"DELETE"}).then(r=>r.json());}
  launch(url,{width=1280,height=760}={}){
    const l=Math.max(0,(screen.width-width)/2),t=Math.max(0,(screen.height-height)/2);
    window.open(url,`tc_${Date.now()}`,`width=${width},height=${height},left=${l},top=${t},resizable=yes`);
  }
  embed(el,url,{height="620px"}={}){
    const c=typeof el==="string"?document.querySelector(el):el;
    if(!c)throw new Error("Container not found");
    c.innerHTML=`<iframe src="${url}" allow="camera;microphone;fullscreen" style="width:100%;height:${height};border:none;border-radius:12px;" allowfullscreen></iframe>`;
  }
  getLobbyUrl(roomId,userId){return `${this.host}/lobby/${roomId}/${encodeURIComponent(userId)}`;}
  getSessionUrl(roomId,userId){return `${this.host}/session/${roomId}/${encodeURIComponent(userId)}`;}
}
g.TutorConnect=TutorConnect;
if(typeof module!=="undefined"&&module.exports)module.exports=TutorConnect;
})(typeof window!=="undefined"?window:global);
