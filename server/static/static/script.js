const socket = io();
let currentChatUserId = null;
let currentChatUsername = null;

// DOM Elements
const friendList = document.getElementById('friend-list');
const requestList = document.getElementById('request-list');
const reqCount = document.getElementById('request-count');
const addFriendInput = document.getElementById('add-friend-input');
const addFriendBtn = document.getElementById('add-friend-btn');

const chatPlaceholder = document.getElementById('chat-placeholder');
const chatInterface = document.getElementById('chat-interface');
const chatPartnerName = document.getElementById('current-chat-user');
const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

// Settings
const openSettings = document.getElementById('open-settings');
const closeSettings = document.getElementById('close-settings');
const settingsModal = document.getElementById('settings-modal');
const micSelect = document.getElementById('mic-select');
const speakerSelect = document.getElementById('speaker-select');

// ----------------- Initialization -----------------

async function loadFriends() {
    const res = await fetch('/api/friends');
    const friends = await res.json();
    friendList.innerHTML = '';
    friends.forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span><i class="fas fa-user-circle"></i> ${f.username}</span>
            <span class="status online"></span>
        `;
        li.onclick = () => openChat(f.id, f.username, li);
        friendList.appendChild(li);
    });
}

async function loadRequests() {
    const res = await fetch('/api/friend-requests');
    const requests = await res.json();
    requestList.innerHTML = '';
    reqCount.textContent = requests.length;

    requests.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${r.sender}</span>
            <button class="action-btn" onclick="acceptRequest(${r.id})"><i class="fas fa-check"></i></button>
        `;
        requestList.appendChild(li);
    });
}

loadFriends();
loadRequests();

// ----------------- Friends Logic -----------------

addFriendBtn.onclick = async () => {
    const username = addFriendInput.value;
    if (!username) return;

    const res = await fetch('/api/add-friend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.success) {
        addFriendInput.value = '';
        alert('İstek gönderildi!');
    } else {
        alert(data.message);
    }
};

async function acceptRequest(id) {
    const res = await fetch('/api/accept-friend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: id })
    });
    if ((await res.json()).success) {
        loadFriends();
        loadRequests();
    }
}

// ----------------- Chat Logic -----------------

async function openChat(id, username, liElement) {
    document.querySelectorAll('.friend-list li').forEach(li => li.classList.remove('active'));
    liElement.classList.add('active');

    currentChatUserId = id;
    currentChatUsername = username;

    chatPlaceholder.classList.add('hidden');
    chatInterface.classList.remove('hidden');
    chatPartnerName.textContent = username;

    // Load messages
    const res = await fetch(`/api/messages/${id}`);
    const msgs = await res.json();

    messagesContainer.innerHTML = '';
    msgs.forEach(m => {
        appendMessage(m.content, m.sender_id === id ? 'received' : 'sent', m.timestamp);
    });
    scrollToBottom();
}

function appendMessage(content, type, time) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.innerHTML = `${content} <span class="time">${time}</span>`;
    messagesContainer.appendChild(div);
    scrollToBottom();
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

messageForm.onsubmit = (e) => {
    e.preventDefault();
    const content = messageInput.value.trim();
    if (!content || !currentChatUsername) return;

    socket.emit('send_message', {
        receiver: currentChatUsername,
        content: content
    });
    messageInput.value = '';
};

socket.on('receive_message', (data) => {
    if (data.sender === currentChatUsername || data.sender === CURRENT_USERNAME) {
        appendMessage(data.content, data.sender === CURRENT_USERNAME ? 'sent' : 'received', data.timestamp);
    }
});

socket.on('friend_request', (data) => {
    loadRequests();
});

// ----------------- Settings (Mic Selection) -----------------

openSettings.onclick = () => settingsModal.classList.remove('hidden');
closeSettings.onclick = () => settingsModal.classList.add('hidden');

async function getMicrophones() {
    try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();

        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

        micSelect.innerHTML = '<option value="">Varsayılan Mikrofon</option>';
        audioInputs.forEach((device, index) => {
            if (device.deviceId) {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Mikrofon ${index + 1}`;
                micSelect.appendChild(option);
            }
        });

        speakerSelect.innerHTML = '<option value="">Varsayılan Hoparlör</option>';
        audioOutputs.forEach((device, index) => {
            if (device.deviceId) {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Hoparlör ${index + 1}`;
                speakerSelect.appendChild(option);
            }
        });
    } catch (e) {
        console.error("Mic access denied", e);
    }
}
getMicrophones();

speakerSelect.onchange = async () => {
    const deviceId = speakerSelect.value;
    if (typeof remoteAudio.setSinkId !== 'undefined') {
        try {
            await remoteAudio.setSinkId(deviceId);
            console.log(`Audio output routed to ${deviceId}`);
        } catch (error) {
            console.error('Error setting audio output:', error);
        }
    } else {
        console.warn('Browser does not support output device selection.');
    }
};


// ==========================================
// WebRTC Voice Call Logic
// ==========================================

const voiceCallBtn = document.getElementById('voice-call-btn');
const callModal = document.getElementById('call-modal');
const endCallBtn = document.getElementById('end-call-btn');
const acceptCallBtn = document.getElementById('accept-call-btn');
const callStatus = document.getElementById('call-status');
const callTarget = document.getElementById('call-target');
const remoteAudio = document.getElementById('remote-audio');

let localStream;
let peerConnection;
let callerName = null;
let isCalling = false;

const configuration = {
    'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }]
};

async function getLocalStream() {
    const deviceId = micSelect.value;
    const constraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        video: false
    };
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
        console.error("Failed to get local stream", err);
        alert("Mikrofon bulunamadı veya erişim reddedildi.");
    }
}

function createPeerConnection(targetUser) {
    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: targetUser,
                candidate: event.candidate
            });
        }
    };

    // Ensure remote audio plays out of the selected speaker if it's playing
    if (typeof remoteAudio.setSinkId !== 'undefined' && speakerSelect.value) {
        remoteAudio.setSinkId(speakerSelect.value).catch(console.error);
    }
}

// 1. Caller starts call
voiceCallBtn.onclick = async () => {
    if (!currentChatUsername) return;

    await getLocalStream();
    if (!localStream) return;

    callModal.classList.remove('hidden');
    acceptCallBtn.classList.add('hidden');
    callStatus.textContent = 'Aranıyor...';
    callTarget.textContent = currentChatUsername;
    isCalling = true;
    callerName = currentChatUsername;

    createPeerConnection(currentChatUsername);

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('call-user', {
            userToCall: currentChatUsername,
            signalData: peerConnection.localDescription
        });
    } catch (err) {
        console.error(err);
    }
};

// 2. Receiver gets call
socket.on('incoming-call', (data) => {
    if (isCalling) return; // Busy

    callerName = data.from;
    callModal.classList.remove('hidden');
    acceptCallBtn.classList.remove('hidden');
    callStatus.textContent = 'Gelen Arama';
    callTarget.textContent = callerName;

    // Save offer to use when accepted
    window.incomingOffer = data.signal;
});

// 3. Receiver accepts call
acceptCallBtn.onclick = async () => {
    await getLocalStream();
    if (!localStream) return;

    isCalling = true;
    acceptCallBtn.classList.add('hidden');
    callStatus.textContent = 'Bağlanıyor...';

    createPeerConnection(callerName);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(window.incomingOffer));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer-call', {
        to: callerName,
        signal: peerConnection.localDescription
    });

    callStatus.textContent = 'Konuşuluyor';
};

// 4. Caller receives answer
socket.on('call-accepted', async (signal) => {
    callStatus.textContent = 'Konuşuluyor';
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
});

// 5. ICE Candidates
socket.on('ice-candidate', async (data) => {
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error('Error adding ICE candidate', e);
        }
    }
});

// 6. End Call
function cleanupCall() {
    isCalling = false;
    callModal.classList.add('hidden');
    remoteAudio.srcObject = null;

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
}

endCallBtn.onclick = () => {
    socket.emit('end-call', { target: callerName });
    cleanupCall();
};

socket.on('call-ended', () => {
    cleanupCall();
});
