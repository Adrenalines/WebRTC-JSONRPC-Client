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

let localStream;
let peerConnection;
let uuid;
let serverConnection;

document.addEventListener('DOMContentLoaded', pageReady);


// стартуем здесь
function pageReady() {
  uuid = createUUID();

  // Это подключение к нашему MFAPI серверу, но у нас там бегает MFAPI в виде JSON-RPC
  serverConnection = new WebSocket(wssConnectionUrl, []);
    

  let constraints = {
    video: false, // отключил видео, т.к. если нет камеры пример не работает
    audio: true,
  };
  
  // Отправляем сообщение на сервер
  jrpc.toStream = function(_msg) {
    console.log('Message sended: ', _msg);
    serverConnection.send(_msg);
  };

  // Вызываем rtcPrepare после открытия соединения
  serverConnection.onopen = function() {
    jrpc.call('rtcPrepare');
  }
  
  // Показываем ошибку, если соединение не было установлено
  serverConnection.onerror = function(error) {
    console.error('Connection error: ' + error.message);
  };

  // Показываем сообщение, которое вернул сервер
  serverConnection.onmessage = function(event) {
    console.log('Server answer: ', event.data);
    const answer = JSON.parse(event.data);
    if (answer.result && answer.result.message === 'call created') {
      
    }
  };

  // Показываем сообщение в случае, если соединение было закрыто
  serverConnection.onclose = function(event) {
    if (event.wasClean) {
      console.info('Connection close was clean');
    } else {
      console.error('Connection suddenly close');
    }
    console.info('close code : ' + event.code + ' reason: ' + event.reason); 
  };

  // Слушаем событие onRtcCallAnswer
  jrpc.on('onRtcCallAnswer', answer => {
    console.log('Answered, SDP V: ', answer);
  });

  // Слушаем событие onCallIncoming
  jrpc.on('onCallIncoming', event => {
    console.log('Call incoming: ', event);
    // Если пришло событие onCallIncoming, то вызываем callAnswer
    // "description": [ "Уникальный идентификатор звонковой сессии.", "Возвращается из события onCallIncoming или метода callMake.
    // После совершения вызова все операции над ним производятся с указанием этого идентификатора"]
    jrpc.call('callAnswer', { description: answer.id.toString(), examples: uuid }); 
  });


  // В этот момент всплывает запрос на разрешение доступа к микрофону
  if (navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia(constraints).then(getUserMediaSuccess).catch(errorHandler);
  } else {
    alert('Your browser does not support getUserMedia API');
  }
}

// Разрешение получили
function getUserMediaSuccess(stream) {
  localStream = stream;
}

function start(isCaller) {
  console.log(localStream);

  peerConnection = new RTCPeerConnection(peerConnectionConfig); // конфигурация ICE серверов
  peerConnection.onicecandidate = gotIceCandidate; // ICE будет выдавать нам кандидатов для преодоления NAT
  peerConnection.ontrack = gotRemoteStream; // SDP offer/answer прошел
  peerConnection.addStream(localStream); // наш источник звука
  

  if (isCaller) {
    // Т.к. мы звоним, нам нужно получить у браузера SDP
    peerConnection
      .createOffer()
      .then(createdDescription)
      .catch(errorHandler);
  }
}

// Мы получили наш локальный SDP
function createdDescription(description) {
  // Устанавливаем его себе
  peerConnection.setLocalDescription(description).then(function () {
    // Теперь обогащаем локальный SDP кандидатами ICE полученными в gotIceCandidate
    // Далее, вместо этого вызова делаем вызов метода MFAPI:
    // - rtcCallMake(SDP) - если мы звоним
    // - rtcCallAnswer(SDP) - если нам звонят
    jrpc.call('rtcCallMake', { 'sdp': peerConnection.localDescription.sdp });    
  });
}

function gotMessageFromServer(message) {
  if (!peerConnection) start(false);

  let signal = JSON.parse(message.data);

  // Ignore messages from ourself
  if (signal.uuid == uuid) return;

  // Тут мы получаем MFAPI:
  // - onRtcCallIncoming - при входящем в браузер вызове
  // - onRtcCallAnswer - при исходящем из браузера
  // В обоих случаях мы получили SDP от FreeSwitch и он уже содержит Ice-кандидатов
  if (signal.sdp) {
    // Устанавливаем SDP полученный от FreeSwitch
    peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
      // Only create answers in response to offers
      if (signal.sdp.type == 'offer') { // Если мы получили MFAPI onRtcCallIncoming
        peerConnection.createAnswer().then(createdDescription).catch(errorHandler);
      }
    }).catch(errorHandler);
  } else if (signal.ice) { // это условие удаляется
    // Здесь мы вычлиняем Ice-кандидатов из SDP от FreeSwitch и добавляем их
    peerConnection.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
  }
}

// Эти ICE кандидаты мы все должны собрать и прикрепить к SDP offer или answer,
// в зависимости от того нам звонят или мы звоним.
// К SDP прикрепляется в виде поля a=
// , например:
// a=candidate:0 1 UDP 2122252543 192.168.10.131 39005 typ host
function gotIceCandidate(event) {
  if (event.candidate != null) {
    serverConnection.send(JSON.stringify({ 'ice': event.candidate, 'uuid': uuid }));
  }
}



function gotRemoteStream(event) {
  console.log('got remote stream');
}

function errorHandler(error) {
  console.log(error);
}

// Taken from http://stackoverflow.com/a/105074/515584
// Strictly speaking, it's not a real UUID, but it gets the job done here
function createUUID() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  }

  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}
