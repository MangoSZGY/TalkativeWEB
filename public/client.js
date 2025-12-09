// client.js - Talkative: Ome TV-style Voice/Video Demo

// --- 1. WebSocket Kapcsolat és Inicializálás ---

// 💡 JAVÍTVA: Csak a legrobusztusabb WSS protokollt használjuk
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${window.location.host}`);

// Egyedi ID generálása és név beállítása
const myId = 'user-' + Math.random().toString(36).slice(2,9);
const chosenName = prompt("Kérlek, add meg a nevedet:");
const myName = chosenName || 'Anonim (' + myId + ')';

let pc = null; 
let localStream = null; 
let remoteAudioEl = null; 
let currentTarget = null; // A jelenlegi partner ID-ja
let isVideoCall = false; 
let isMuted = false;
let isCamOff = false;

// 🗑️ TÖRÖLVE: Nincs szükség statikus kontaktlistára (contacts)
let targetName = 'Partner keresése...'; // Az aktuális partner neve

function $(id){ return document.getElementById(id); }

// UI Inicializálás
$('myAvatar').textContent = myName[0];
$('myName').textContent = myName;
$('myName').title = `Az egyedi ID-d: ${myId}`;

// 🗑️ TÖRÖLVE: Nincs szükség renderContacts és selectContact funkciókra

// --- 2. Websocket Események és Párosítási Logika ---

ws.addEventListener('open', () => {
    // Regisztráció küldése a szervernek az automatikus párosításhoz
    ws.send(JSON.stringify({ type: 'register', id: myId, name: myName }));
    $('targetName').textContent = 'Várólistán...';
    $('targetStatus').textContent = 'Partnerre vár...';
});

ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    const { type, from, data, text } = msg;

    // 🗑️ TÖRÖLVE: Nincs 'presence' (jelenléti lista) kezelése

    // 💡 ÚJ OME TV Logika: Partner automatikus észlelése és hívás kezdeményezése
    if (type === 'partner_found') {
        const partnerId = msg.partnerId;
        console.log("Partner talált:", partnerId, "Kezdődik az automatikus hívás...");
        
        currentTarget = partnerId;
        // Az ID utolsó 4 karakterét használjuk a név helyettesítésére
        targetName = `Partner (${partnerId.slice(5, 9)})`; 
        
        $('targetName').textContent = targetName;
        $('targetStatus').textContent = 'Párosítva. Hívás indítása...';

        // Videó hívás kezdeményezése a talált partner felé
        isVideoCall = true;
        await createPeer(true, partnerId);

    // Régi logika: Bejövő hívás fogadása
    } else if (type === 'offer' && msg.to === myId) {
        const isVid = msg.isVideo || false;

        const accept = confirm(`Bejövő ${isVid ? 'Videó' : 'Audio'} hívás. Elfogadod?`);
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
        targetName = `Partner (${from.slice(5, 9)})`;
        $('targetName').textContent = targetName;
        $('targetStatus').textContent = 'Kapcsolatban';
        showCallOverlay(from, `Hívás ${targetName} felől...`);

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
        alert(`${targetName} elutasította a hívást.`);
        endCall();
    }
});

// --- 3. WebRTC és Segéd Fuggvények ---

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
    
    // ⚠️ FONTOS! ELLENŐRIZD EZT A RÉSZT! A TURN adatoknak helyesnek kell lenniük!
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }, 
            { 
                urls: 'turn:SAJÁT_TURN_URI:PORT', 
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

// --- 4. UI és Vezérlő Függvények ---

// Hívás Overlay megjelenítése és frissítése
function showCallOverlay(remoteId, stateText) {
    $('callOverlay').classList.remove('hidden');
    // Az ID-t használjuk az avatarhoz
    $('callLargeAvatar').textContent = targetName[0] || '?'; 
    $('callState').textContent = stateText;
    
    $('hangupBtn').disabled = false;
    $('endCall').disabled = false;
    // Gombok kikapcsolása, mivel automatikus a hívás
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
    
    // Vissza a párosítási státuszba
    $('hangupBtn').disabled = true;
    currentTarget = null;
    $('targetName').textContent = 'Partner keresése...';
    $('targetStatus').textContent = 'Várólistán...';
    
    // Újraregisztráljuk magunkat a szerveren, hogy újra bekerüljünk a várólistába
    ws.send(JSON.stringify({ type: 'register', id: myId, name: myName }));
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

// --- 5. Vezérlő Eseménykezelők ---
// Töröltük a 'callBtn' és 'videoCallBtn' eseménykezelőket, mivel a hívás automatikus

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
        
        // Hozzá kell adni a pc-hez az új track-et, ha közben érkezett
        if (pc) {
            localStream.getVideoTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }
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
        // Az ID-t használjuk névként
        const senderName = `Partner (${fromId.slice(5, 9)})`;
        m.innerHTML = `<span style="font-weight:bold; color:var(--accent); font-size:10px;">${senderName}:</span> ${txt}`;
    }
    
    $('messages').appendChild(m);
    $('messages').scrollTop = $('messages').scrollHeight;
}

// 🗑️ TÖRÖLVE: Nincs szükség kontaktlista renderelésre és keresésre