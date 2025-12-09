// client.js - Talkative: Skype-style Voice/Video Demo

const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
// A kapcsolat biztonságossá tétele: ha a publikus címed HTTPS, WSS-t kell használni.
const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
const ws = new WebSocket(protocol + window.location.host);

// Egyedi ID generálása és név beállítása
const myId = 'user-' + Math.random().toString(36).slice(2,9);
// Kérj be egy nevet a felhasználótól
const chosenName = prompt("Kérlek, add meg a nevedet (ez lesz látható a többieknek):");
const myName = chosenName || 'Anonim (' + myId + ')';

let pc = null; 
let localStream = null; 
let remoteAudioEl = null; 
let currentTarget = null; 
let isVideoCall = false; 
let isMuted = false;
let isCamOff = false;

// Statikus kontaktlista
const contacts = [
  { id: 'alice', name: 'Alice' },
  { id: 'bob', name: 'Bob' },
  { id: 'carol', name: 'Carol' },
];

function $(id){ return document.getElementById(id); }

// UI Inicializálás
$('myAvatar').textContent = myName[0];
$('myName').textContent = myName;
$('myName').title = `Az egyedi ID-d: ${myId}`;

// Kontaktlista renderelése
function renderContacts(filter='') {
  const el = $('contactsList');
  el.innerHTML = '';
  const allContacts = [...contacts, { id: myId, name: myName }]; 
  
  allContacts.forEach(c => {
    if (filter && !c.name.toLowerCase().includes(filter.toLowerCase()) && !c.id.toLowerCase().includes(filter.toLowerCase())) return;
    
    const div = document.createElement('div');
    div.className = 'contact' + (c.id === currentTarget ? ' selected' : '');
    div.dataset.id = c.id;
    
    const statusText = c.id === myId ? 'online' : $('status-' + c.id)?.textContent || 'offline';

    div.innerHTML = `<div class="c-avatar">${c.name[0]}</div>
                     <div class="c-meta"><div class="c-name">${c.name}</div><div class="c-status" id="status-${c.id}">${statusText}</div></div>`;
    
    if (c.id !== myId) {
        div.onclick = () => selectContact(c.id, c.name);
    } else {
        div.classList.add('self');
    }

    el.appendChild(div);
  });
}

// Kontakt kiválasztása
function selectContact(id, name) {
  if (currentTarget) {
    document.querySelector(`.contact[data-id="${currentTarget}"]`)?.classList.remove('selected');
  }
  
  currentTarget = id;
  document.querySelector(`.contact[data-id="${id}"]`)?.classList.add('selected');
  
  $('targetName').textContent = name;
  $('targetStatus').textContent = $('status-' + id)?.textContent || '';
  
  const isOnline = $('status-' + id)?.textContent === 'online';

  $('callBtn').disabled = !isOnline;
  $('videoCallBtn').disabled = !isOnline;
  $('hangupBtn').disabled = true;
  $('messages').innerHTML = '';
  $('videoContainer').classList.add('hidden'); 
}

// Websocket események kezelése
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'register', id: myId }));
  renderContacts();
});

ws.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);
  const { type, from, data, text } = msg;

  if (type === 'presence') {
    document.querySelectorAll('.contact').forEach(el => {
      const id = el.dataset.id;
      if (id === myId) return;
      const statusEl = el.querySelector('.c-status');
      const isOnline = msg.online.includes(id);
      statusEl.textContent = isOnline ? 'online' : 'offline';
      el.classList.toggle('online', isOnline);
      
      if (id === currentTarget) {
          $('callBtn').disabled = !isOnline;
          $('videoCallBtn').disabled = !isOnline;
          $('targetStatus').textContent = statusEl.textContent;
      }
    });
  } else if (type === 'offer' && msg.to === myId) {
    const callerName = contacts.find(x => x.id === from)?.name || from;
    const isVid = msg.isVideo || false;

    const accept = confirm(`Bejövő ${isVid ? 'Videó' : 'Audio'} hívás ${callerName} felől. Elfogadod?`);
    if (!accept) {
        ws.send(JSON.stringify({ type:'reject', to: from, from: myId }));
        return;
    }
    
    isVideoCall = isVid;
    await ensureLocalStream(isVid);
    
    await createPeer(isVid, from);
    await pc.setRemoteDescription(data);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type:'answer', to: from, from: myId, data: pc.localDescription, isVideo: isVid }));
    
    currentTarget = from;
    selectContact(currentTarget, callerName); 
    showCallOverlay(from, `Hívás ${callerName} felől...`);
  } else if (type === 'answer' && msg.to === myId) {
    await pc.setRemoteDescription(data);
    showCallOverlay(from, 'Kapcsolat létrejött.');
  } else if (type === 'ice' && msg.to === myId) {
    try {
      await pc.addIceCandidate(data);
    } catch (e) { console.warn('ICE add fail', e); }
  } else if (type === 'chat' && msg.to === myId) {
    appendMessage(text, 'them', from);
  } else if (type === 'reject' && msg.to === myId) {
    alert(`${contacts.find(x => x.id === from)?.name || from} elutasította a hívást.`);
    endCall();
  }
});

// Lekéri a saját média streamet
async function ensureLocalStream(requestVideo=false) {
  if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) videoTrack.enabled = requestVideo;
      
      if (requestVideo && !localStream.getVideoTracks().length) {
         return await getNewStream({ audio: true, video: true });
      }

      return localStream;
  }
  return await getNewStream({ audio: true, video: requestVideo });
}

async function getNewStream(constraints) {
    try {
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        localStream = s;
        const audioTrack = s.getAudioTracks()[0];
        const videoTrack = s.getVideoTracks()[0];
        if (audioTrack) isMuted = !audioTrack.enabled;
        if (videoTrack) isCamOff = !videoTrack.enabled;
        updateControls();
        return s;
    } catch (e) {
        console.error('Média elérés hiba (elutasítva vagy nincs eszköz)', e);
        localStream = new MediaStream();
        updateControls();
        return null; 
    }
}

// PeerConnection létrehozása és konfigurálása
async function createPeer(requestVideo, remoteId) {
  if (pc) endCall(); 
  
 pc = new RTCPeerConnection({
    iceServers: [
        // A STUN megmarad az első próbálkozáshoz
        { urls: 'stun:stun.l.google.com:19302' }, 
        
        // A TURN szerver adatai
        { 
            urls: 'turn:SAJÁT_TURN_URI:PORT', // Cseréld ki a szolgáltatótól kapott címre
            username: 'SAJÁT_FELHASZNÁLÓNÉV', 
            credential: 'SAJÁT_JELSZÓ'      
        }
    ]
});
  
  const stream = await ensureLocalStream(requestVideo);
  if (stream) {
    for (const t of stream.getTracks()) {
        pc.addTrack(t, stream);
    }
  }

  // ICE jelzések küldése
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      ws.send(JSON.stringify({ type:'ice', to: remoteId, from: myId, data: ev.candidate }));
    }
  };

  // Távoli média fogadása
  pc.ontrack = (ev) => {
    if (ev.track.kind === 'audio') {
        if (!remoteAudioEl) {
            remoteAudioEl = document.createElement('audio');
            remoteAudioEl.id = 'remoteAudio';
            remoteAudioEl.autoplay = true;
            document.body.appendChild(remoteAudioEl);
        }
        remoteAudioEl.srcObject = ev.streams[0];
    } 
    
    if (ev.track.kind === 'video' && ev.streams[0]) {
        $('remoteVideo').srcObject = ev.streams[0];
        $('remoteVideo').classList.remove('hidden');
        $('videoContainer').classList.remove('hidden');
        $('messages').style.zIndex = '0';
    }

    showCallOverlay(remoteId, 'Hívás folyamatban...');
  };
  
  // Hívás állapot frissítése
  pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      $('callState').textContent = state.charAt(0).toUpperCase() + state.slice(1);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          endCall();
      }
  };

  // Ajánlat létrehozása és küldése
  if (remoteId && (await ensureLocalStream(requestVideo))) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ 
        type:'offer', 
        to: remoteId, 
        from: myId, 
        data: pc.localDescription, 
        isVideo: requestVideo
    }));
    
    showLocalVideo();
    showCallOverlay(remoteId, 'Hívás indítása...');
  }
}

// Hívás Overlay megjelenítése és frissítése
function showCallOverlay(remoteId, stateText) {
  $('callOverlay').classList.remove('hidden');
  const c = contacts.find(x => x.id === remoteId);
  $('callLargeAvatar').textContent = c ? c.name[0] : '?';
  $('callState').textContent = stateText;
  
  $('hangupBtn').disabled = false;
  $('endCall').disabled = false;
  $('callBtn').disabled = true;
  $('videoCallBtn').disabled = true;
  
  updateControls();
}

// Helyi videó stream megjelenítése
function showLocalVideo() {
    if (localStream && localStream.getVideoTracks().length > 0 && localStream.getVideoTracks()[0].enabled) {
        $('localVideo').srcObject = localStream;
        $('localVideo').classList.remove('hidden');
        $('videoContainer').classList.remove('hidden');
    } else {
        $('localVideo').srcObject = null;
        $('localVideo').classList.add('hidden');
    }
}

// Hívás befejezése
function endCall() {
  if (pc) {
    pc.close();
    pc = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (remoteAudioEl) { 
      remoteAudioEl.srcObject = null; 
      remoteAudioEl.remove();
      remoteAudioEl = null;
  }
  
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('localVideo').classList.add('hidden');
  $('remoteVideo').classList.add('hidden');
  
  $('callOverlay').classList.add('hidden');
  $('videoContainer').classList.add('hidden');
  $('messages').style.zIndex = '1';
  $('hangupBtn').disabled = true;
  $('callBtn').disabled = currentTarget ? ($('status-' + currentTarget)?.textContent !== 'online') : false;
  $('videoCallBtn').disabled = currentTarget ? ($('status-' + currentTarget)?.textContent !== 'online') : false;
}

// Vezérlő gombok állapotának frissítése (Mic, Cam)
function updateControls() {
    $('toggleMic').textContent = isMuted ? '🔊 Unmute' : '🔇 Mute';
    $('toggleMic').classList.toggle('active', !isMuted);

    $('toggleCam').textContent = isCamOff ? '📹 Video On' : 'Hide Video';
    $('toggleCam').classList.toggle('active', !isCamOff);
    
    const hasVideoTrack = localStream && localStream.getVideoTracks().length > 0;
    $('toggleCam').disabled = !hasVideoTrack;
    
    if (pc) {
        showLocalVideo();
    }
}

// --- Vezérlő Eseménykezelők ---

$('callBtn').addEventListener('click', async () => {
  if (!currentTarget) return alert('Válassz kontaktot!');
  isVideoCall = false; 
  await createPeer(false, currentTarget);
});

$('videoCallBtn').addEventListener('click', async () => {
  if (!currentTarget) return alert('Válassz kontaktot!');
  isVideoCall = true; 
  await createPeer(true, currentTarget);
});

$('hangupBtn').addEventListener('click', endCall);
$('endCall').addEventListener('click', endCall);

// Mikrofon be/ki
$('toggleMic').addEventListener('click', () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    updateControls();
});

// Kamera be/ki
$('toggleCam').addEventListener('click', async () => {
    if (!pc) return;
    
    const hasVideo = localStream && localStream.getVideoTracks().length > 0;
    
    if (!hasVideo && !isCamOff) {
        await getNewStream({ audio: true, video: true });
        
        localStream.getVideoTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    isCamOff = !isCamOff;
    if (localStream) {
        localStream.getVideoTracks().forEach(track => track.enabled = !isCamOff);
    }
    
    updateControls();
});

// Üzenetküldés
$('sendBtn').addEventListener('click', sendMessage);
$('messageInput').addEventListener('keydown', (e)=>{ if (e.key==='Enter') sendMessage(); });

function sendMessage() {
  const txt = $('messageInput').value.trim();
  if (!txt || !currentTarget) return;
  appendMessage(txt, 'me');
  ws.send(JSON.stringify({ type:'chat', to: currentTarget, from: myId, text: txt }));
  $('messageInput').value = '';
}

function appendMessage(txt, who, fromId) {
  const m = document.createElement('div');
  m.className = 'message ' + (who==='me' ? 'me' : 'them');
  m.textContent = txt;
  
  if (who === 'them') {
      const senderName = contacts.find(c => c.id === fromId)?.name || fromId;
      m.innerHTML = `<span style="font-weight:bold; color:var(--accent); font-size:10px;">${senderName}:</span> ${txt}`;
  }
  
  $('messages').appendChild(m);
  $('messages').scrollTop = $('messages').scrollHeight;
}

// Keresés
$('searchInput').addEventListener('input', (e) => renderContacts(e.target.value));

renderContacts();