;(function(global){
	var socket = null;
	var isConnected = false;

	function connect(url, onOpen, onMessage, onClose){
		try {
			socket = global.io(url, { transports: ['websocket'] });
			socket.on('connect', function(){ isConnected = true; onOpen && onOpen(); });
			socket.onAny(function(event, data){ onMessage && onMessage(JSON.stringify({ type: event, payload: data })); });
			socket.on('disconnect', function(){ isConnected = false; onClose && onClose(); });
			return true;
		} catch(e){ return false; }
	}

	function send(event, payload){
		if (!socket || !isConnected) return false;
		try { socket.emit(event, payload); return true; } catch(e){ return false; }
	}

	function id(){ return socket && socket.id; }

	global.GameNetwork = {
		connect: connect,
		send: send,
		sendInput: function(payload){ return send('input', payload); },
		isConnected: function(){ return isConnected; },
		id: id
	};
})(window);


