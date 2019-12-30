const jrpc = new simple_jsonrpc();
const wssConnectionUrl = 'ws://192.168.10.131:8800';
const peerConnectionConfig = {
  // Эти сервера нужны браузеру для преодоления NAT,
  // через них он узнает свои внешние IP и порт,
  // а потом предложит нам в качестве кандидатов на передачу SRTP
  iceServers: [
    { urls: 'stun:stun.stunprotocol.org:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

let localAudio;
let remoteAudio;
let localStream;
let peerConnection;
let serverConnection;
let ice = '';

document.addEventListener('DOMContentLoaded', pageReady);

// стартуем здесь
function pageReady() {
  let constraints = {
    video: false, // отключил видео, т.к. если нет камеры пример не работает
    audio: true,
  };

  localAudio = document.getElementById('localAudio');
  remoteAudio = document.getElementById('remoteAudio');

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
        })
        .catch(errorHandler);
    } else {
      alert('Your browser does not support getUserMedia API');
    }
  };

  // Показываем ошибку, если соединение не было установлено
  serverConnection.onerror = function(error) {
    console.error('Connection error: ' + error.message);
  };

  // Показываем сообщение, которое прислал сервер
  serverConnection.onmessage = gotMessageFromServer;

  // Показываем сообщение в случае, если соединение было закрыто
  serverConnection.onclose = function(event) {
    if (event.wasClean) {
      console.info('Connection close was clean');
    } else {
      console.error('Connection suddenly close');
    }
    console.info('close code : ' + event.code + ' reason: ' + event.reason);
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
  // Ожидаем последнего кандидата
  if (event.target.iceGatheringState === 'complete') {
    // Меняем статус на готов
    document.getElementById('init').innerHTML = 'Готов';
    // Включаем кнопки
    document.getElementById('call').disabled = false;
    document.getElementById('answer').disabled = false;
    // Регистрируемся (rtcPrepare)
    register();
  }
}

function register() {
  // Вызываем rtcPrepare после открытия соединения
  jrpc.call('rtcPrepare');  
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

function gotMessageFromServer(message) {  
    // Слушаем событие onCallIncoming
  jrpc.on('onCallIncoming', 'pass', event => {
    console.log('Call incoming: ', event);
    // Если пришло событие onCallIncoming, то вызываем callAnswer
    // "description": [ "Уникальный идентификатор звонковой сессии.", "Возвращается из события onCallIncoming или метода callMake.
    // После совершения вызова все операции над ним производятся с указанием этого идентификатора"]
    jrpc.call('callAnswer', {
      call_session: event.params.call_session.toString(),
    });
  });

  // Слушаем событие onRtcCallAnswer
  jrpc.on('onRtcCallAnswer', 'pass', event => {
    console.log('Answered, SDP V: ', event);
    handleSDP(event);
  });  

  // Слушаем событие onRtcCallIncoming
  jrpc.on('onRtcCallIncoming', 'pass', event => {
    console.log('Incoming call, SDP V: ', event);
    // Если пришло событие onRtcCallIncoming, то вызываем rtcCallAnswer
    document.getElementById('answer').addEventListener('click', () => {
      call(false);
      handleSDP(event);
    });
  });  

  // Слушаем событие onCallAnswer
  jrpc.on('onCallAnswer', 'pass', event => {
    console.log('Answered: ', event);
  });

  jrpc.messageHandler(message.data); // Этот метод должен обязательно вызываться для обработки входящих событий
  const signal = JSON.parse(message.data);
  console.log('Server answer: ', signal);  


}

function handleSDP(signal) {
  // Тут мы получаем MFAPI:
  // - onRtcCallIncoming - при входящем в браузер вызове
  // - onRtcCallAnswer - при исходящем из браузера
  // В обоих случаях мы получили SDP от FreeSwitch и он уже содержит Ice-кандидатов
  if (signal.sdp) { 
    peerConnection
      .setRemoteDescription(
        new RTCSessionDescription({ sdp: signal.sdp, type: 'offer' })
      ).catch(errorHandler);
  }  
}

function gotRemoteStream(event) {
  console.log('got remote stream: ', event);
  remoteAudio.srcObject = event.streams[0];
}

function errorHandler(error) {
  console.log(error);
}