const jrpc = new simple_jsonrpc();
const peerConnectionConfig = {
  // Эти сервера нужны браузеру для преодоления NAT,
  // через них он узнает свои внешние IP и порт,
  // а потом предложит нам в качестве кандидатов на передачу SRTP
  iceServers: [
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

let constraints;
let localAudio;
let remoteAudio;
let localStream;
let peerConnection;
let serverConnection;
let ice = '';
// Достаём url из localStorage
document.getElementById('url').value = localStorage.getItem('url') || '';

document.addEventListener('DOMContentLoaded', pageReady);

// стартуем здесь
function pageReady() {
  constraints = {
    video: false, // отключил видео, т.к. если нет камеры пример не работает
    audio: true,
  };

  localAudio = document.getElementById('localAudio');
  remoteAudio = document.getElementById('remoteAudio');
  // Меняем статус на Ready
  document.getElementById('ready').innerHTML = 'Ready';
}

function connect() {
  let wssConnectionUrl = document.getElementById('url').value;
  // Кладём url в localStorage
  localStorage.setItem('url', wssConnectionUrl);
  // Это подключение к нашему MFAPI серверу, но у нас там бегает MFAPI в виде JSON-RPC
  serverConnection = new WebSocket(wssConnectionUrl);

  // Отправляем сообщение на сервер
  jrpc.toStream = function(msg) {
    console.log('Message sended: ', JSON.parse(msg));
    serverConnection.send(msg);
  };

  serverConnection.onopen = function() {
    // В этот момент всплывает запрос на разрешение доступа к микрофону
    if (navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia(constraints)
        .then(stream => {
          getUserMediaSuccess(stream);
          startPeerConnection();
          document.getElementById('connect').disabled = true;
          document.getElementById('disconnect').disabled = false;
        })
        .catch(errorHandler);
    } else {
      alert('Connection failed. Your browser does not support getUserMedia API');
      document.getElementById('status').innerHTML = 'Error: Your browser does not support getUserMedia API';
    }
  };

  // Показываем ошибку, если соединение не было установлено
  serverConnection.onerror = errorHandler;

  // Показываем сообщение, которое прислал сервер
  serverConnection.onmessage = gotMessageFromServer;

  // Показываем сообщение в случае, если соединение было закрыто
  serverConnection.onclose = function(event) {
    if (event.wasClean) {
      console.info('Connection close was clean');
      document.getElementById('status').innerHTML = 'Connection close was clean';
    } else {
      console.error('Connection suddenly close');
      document.getElementById('status').innerHTML = 'Connection suddenly close';
    }
    console.info('close code: ' + event.code + ', reason: ' + event.reason);
    document.getElementById('status').innerHTML += ', close code: ' + event.code + ', reason: ' + event.reason;
    disconnect();
  };
}

// Разрешение получили
function getUserMediaSuccess(stream) {
  localStream = stream;
  localAudio.srcObject = stream;
}

function startPeerConnection() {
  peerConnection = new RTCPeerConnection(peerConnectionConfig); // конфигурация ICE серверов
  peerConnection.onicecandidate = gotIceCandidate;  // ICE будет выдавать нам кандидатов для преодоления NAT  
  peerConnection.ontrack = gotRemoteStream; // SDP offer/answer прошел
  peerConnection.addStream(localStream); // наш источник звука  

  // Получаем у браузера SDP
  peerConnection
    .createOffer()
    .then(createdDescription)
    .catch(errorHandler);
}

// Мы получили наш локальный SDP
function createdDescription(description) {
  // Устанавливаем его себе
  peerConnection.setLocalDescription(description); 
}

// Эти ICE кандидаты мы все должны собрать и прикрепить к SDP offer или answer,
// в зависимости от того нам звонят или мы звоним.
// К SDP прикрепляется в виде поля a=
// , например:
// a=candidate:0 1 UDP 2122252543 192.168.10.131 39005 typ host
function gotIceCandidate(event) {  
  document.getElementById('status').innerHTML = 'Getting ice candidates...';
  // Ожидаем последнего кандидата
  if (event.target.iceGatheringState === 'complete') {    
    // Регистрируемся (rtcPrepare)
    register();
  }
}

function register() {
  // Вызываем rtcPrepare после открытия соединения
  jrpc.call('rtcPrepare');
  // Меняем статус на Connection established
  document.getElementById('status').innerHTML = 'Connection established';
  // Включаем кнопки
  document.getElementById('call').disabled = false;
  document.getElementById('callMakeText').disabled = false;
  document.getElementById('callMake').disabled = false;
}

function call(isCaller) {
  // Теперь обогащаем локальный SDP кандидатами ICE полученными в gotIceCandidate
  // Далее делаем вызов метода MFAPI:
  // - rtcCallMake(SDP) - если мы звоним
  // - rtcCallAnswer(SDP) - если нам звонят    
  if (isCaller) {
    jrpc.call('rtcCallMake', {
      sdp: peerConnection.localDescription.sdp
    });
  } else {
    jrpc.call('rtcCallAnswer', {
      sdp: peerConnection.localDescription.sdp
    });
  } 
}

function callMake() {
  // Вызываем callMake с параметром rtc_address, взятым из пользовательского input  
  jrpc.call('callMake', {
    rtc_address: document.getElementById('callMakeText').value
  });
}

function gotMessageFromServer(message) {  
  jrpc.messageHandler(message.data); // Этот метод должен обязательно вызываться для обработки входящих событий
  const signal = JSON.parse(message.data);
  console.log('Server answer: ', signal);

  // Обработка ответа и вывод в поле status
  const result = signal.result ? signal.result : signal.error ? signal.error : '';
  document.getElementById('status').innerHTML = result ? result.message : document.getElementById('status').innerHTML;
  
  if (signal.result && signal.result.message === 'call created') {
    document.getElementById('callCreated').checked = true;
  }

  // Обработка jrpc ответов
  handleMessageFromServer();
}

function handleMessageFromServer() {
  let callSessionConnect = '';
  let callSessionIncoming = '';
  // Слушаем событие onCallIncoming
  jrpc.on('onCallIncoming', 'pass', event => {
    console.log('Call incoming: ', event);
    callSessionConnect = event.params.call_session.toString();
    document.getElementById('onCallIncoming').checked = true;
    // Если пришло событие onCallIncoming, то вызываем callAnswer
    // "description": [ "Уникальный идентификатор звонковой сессии.", "Возвращается из события onCallIncoming или метода callMake.
    // После совершения вызова все операции над ним производятся с указанием этого идентификатора"]
    jrpc.call('callAnswer', {
      call_session: callSessionConnect,
    });    
    document.getElementById('callAnswer').checked = true;    
  });
  
  // Слушаем событие onRtcCallAnswer
  jrpc.on('onRtcCallAnswer', 'pass', event => {
    console.log('Answered, SDP V: ', event);
    document.getElementById('onRtcCallAnswer').checked = true;
    handleSDP(event, 'answer'); // передаём sdp и статус answer
    // Вызываем метод callTonePlay
    jrpc.call('callTonePlay', {
      call_session: callSessionConnect,
      tone_id: '425'
    });
    document.getElementById('callTonePlayConnect').checked = true;
  });

  // Слушаем событие onRtcCallIncoming
  jrpc.on('onRtcCallIncoming', 'pass', event => {
    console.log('Incoming call, SDP V: ', event);
    callSessionIncoming = event.params.call_session.toString();
    document.getElementById('onRtcCallIncoming').checked = true;
    // Если пришло событие onRtcCallIncoming, то вызываем rtcCallAnswer
    call(false);
    document.getElementById('rtcCallAnswer').checked = true;
    handleSDP(event, 'offer'); // передаём sdp и статус offer
  });  

  // Слушаем событие onCallAnswer
  jrpc.on('onCallAnswer', 'pass', event => {
    console.log('Answered: ', event);
    document.getElementById('onCallAnswer').checked = true;

    // Вызываем метод callTonePlay
    jrpc.call('callTonePlay', {
      call_session: callSessionIncoming,
      tone_id: '425'
    });
    document.getElementById('callTonePlayIncoming').checked = true;
  });
}

function handleSDP(signal, status) {
  // Тут мы получаем MFAPI:
  // - onRtcCallIncoming - при входящем в браузер вызове
  // - onRtcCallAnswer - при исходящем из браузера
  // В обоих случаях мы получили SDP от FreeSwitch и он уже содержит Ice-кандидатов
  
  if (signal.sdp) {
    const sdpStrings = signal.sdp.split('\r\n');
    let withoutCandidates = [];
    let candidates = [];

    // Парсим без Ice-кандидатов
    withoutCandidates = sdpStrings.filter(
      item =>
        !item.includes('a=end-of-candidates') &&
        !item.includes('a=candidate') &&
        item !== ''
    );

    // Парсим Ice-кандидатов из SDP от FreeSwitch
    candidates = sdpStrings.filter(item => item.includes('a=candidate'));
    candidates = candidates.map(candidate => candidate.slice(2));

    let withoutCandidatesString = withoutCandidates.join('\r\n');
    let rtcSessionDescription = new RTCSessionDescription({
      sdp: withoutCandidatesString,
      type: status, // ставим type в зависимости от статуса соответственно answer или offer
    });
    peerConnection
      .setRemoteDescription(rtcSessionDescription)
      .then(function() {
        candidates.forEach(candidate => {
          peerConnection
            .addIceCandidate(new RTCIceCandidate({ sdpMid: '', sdpMLineIndex: '', candidate: candidate }))
            .catch(errorHandler);
        });
        // Only create answers in response to offers
        if (signal.sdp.type === 'offer') {
          peerConnection
            .createAnswer()
            .then(createdDescription)
            .catch(errorHandler);
        }
      })
      .catch(errorHandler);
  }  
}

function gotRemoteStream(event) {
  console.log('got remote stream: ', event);
  remoteAudio.srcObject = event.streams[0];
  event.streams[0]
    .getTracks()
    .forEach(track => peerConnection.addTrack(track, localStream)); 
}

function errorHandler(error) {
  console.log(error);
  document.getElementById('status').innerHTML = 'Connection error' + (error.message !== undefined ? ': ' + error.message : '');
}

function disconnect() {
  serverConnection.close();
  document.getElementById('connect').disabled = false;
  document.getElementById('disconnect').disabled = true;
  // Выключаем кнопки и чек-боксы
  document.getElementById('call').disabled = true;
  document.getElementById('callMake').disabled = true;
  document.getElementById('onCallIncoming').checked = false;
  document.getElementById('callAnswer').checked = false;
  document.getElementById('onRtcCallAnswer').checked = false;
  document.getElementById('callTonePlayConnect').checked = false;
  document.getElementById('onRtcCallIncoming').checked = false;
  document.getElementById('rtcCallAnswer').checked = false;
  document.getElementById('onCallAnswer').checked = false;
  document.getElementById('callTonePlayIncoming').checked = false;
}