/**
 * TutorConnect SDK  v4.0
 * Usage: <script src="https://your-domain.com/sdk.js"></script>
 */
(function(global){"use strict";
class TutorConnect{
  constructor({host=""}={}){this.host=host.replace(/\/$/,"")}
  async createSession({tutor,student,metadata={}}={}){
    if(!tutor?.userId||!tutor?.name)throw new Error("tutor.userId and tutor.name required");
    if(!student?.userId||!student?.name)throw new Error("student.userId and student.name required");
    const r=await fetch(`${this.host}/api/rooms`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tutor,student,metadata})});
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||`HTTP ${r.status}`);}
    return r.json();
  }
  async getSession(id){const r=await fetch(`${this.host}/api/rooms/${id}`);if(!r.ok)throw new Error("Not found");return r.json().then(d=>d.room);}
  async getSummary(id){const r=await fetch(`${this.host}/api/rooms/${id}/summary`);if(!r.ok)throw new Error("Not found");return r.json();}
  async endSession(id){const r=await fetch(`${this.host}/api/rooms/${id}`,{method:"DELETE"});return r.json();}
  launch(url,{width=1280,height=760}={}){
    const l=Math.max(0,(screen.width-width)/2),t=Math.max(0,(screen.height-height)/2);
    window.open(url,`tc_${Date.now()}`,`width=${width},height=${height},left=${l},top=${t},resizable=yes`);
  }
  embed(container,url,{height="620px"}={}){
    const el=typeof container==="string"?document.querySelector(container):container;
    if(!el)throw new Error("Container not found");
    el.innerHTML=`<iframe src="${url}" allow="camera;microphone;fullscreen" style="width:100%;height:${height};border:none;border-radius:12px;display:block;" allowfullscreen></iframe>`;
  }
  getJoinUrl(roomId,userId){return `${this.host}/session/${roomId}/${encodeURIComponent(userId)}`;}
}
global.TutorConnect=TutorConnect;
if(typeof module!=="undefined"&&module.exports)module.exports=TutorConnect;
})(typeof window!=="undefined"?window:global);
