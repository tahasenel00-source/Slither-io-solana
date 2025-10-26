Game = function(game) {}

Game.prototype = {
    preload: function() {

        //load assets
        this.game.load.image('circle','asset/circle.png');
    	this.game.load.image('shadow', 'asset/white-shadow.png');
    	this.game.load.image('background', 'asset/tile.png');

    	this.game.load.image('eye-white', 'asset/eye-white.png');
    	this.game.load.image('eye-black', 'asset/eye-black.png');

        this.game.load.image('coin', 'asset/food.png');
    },
    create: function() {
        var width = this.game.width;
        var height = this.game.height;

        // scale to fit window and support fullscreen
        this.game.scale.scaleMode = Phaser.ScaleManager.RESIZE;
        this.game.scale.fullScreenScaleMode = Phaser.ScaleManager.EXACT_FIT;

        this.game.world.setBounds(-width, -height, width*2, height*2);
    	this.game.stage.backgroundColor = '#444';

        //add tilesprite background
        this.background = this.game.add.tileSprite(-width, -height,
            this.game.world.width, this.game.world.height, 'background');

        //initialize physics and groups
        this.game.physics.startSystem(Phaser.Physics.P2JS);
        this.foodGroup = this.game.add.group();
        this.foodGroup.removeAll(true);
        this.snakeHeadCollisionGroup = this.game.physics.p2.createCollisionGroup();
        this.foodCollisionGroup = this.game.physics.p2.createCollisionGroup();

        // do not add random food; coins spawn only on snake death

        this.game.snakes = [];

        //create player
        var snake = new PlayerSnake(this.game, 'circle', 0, 0);
        this.game.playerSnake = snake;
        this.game.camera.follow(snake.head);

        //create bots
        new BotSnake(this.game, 'circle', -200, 0);
        new BotSnake(this.game, 'circle', 200, 0);

        //initialize snake groups and collision
        for (var i = 0 ; i < this.game.snakes.length ; i++) {
            var snake = this.game.snakes[i];
            snake.head.body.setCollisionGroup(this.snakeHeadCollisionGroup);
            snake.head.body.collides([this.foodCollisionGroup]);
            //callback for when a snake is destroyed
            snake.addDestroyedCallback(this.snakeDestroyed, this);
            // give bots a starting balance so they drop coins on first death (no pellets until they die)
            if (!snake.isPlayer) { snake.coinBalance = 10; }
        }

        // HUD for coin balance
        var style = { font: '16px Arial', fill: '#ffffff' };
        this.coinText = this.game.add.text(10, 10, 'Coins: 0', style);
        this.coinText.fixedToCamera = true;

        // ESC hold-to-exit overlay
        this.exitCountdown = null;
        this.exitHoldMs = 0;
        this.exitOverlay = this.game.add.text(this.game.width/2, 40, '', { font: '20px Arial', fill: '#ffcc00' });
        this.exitOverlay.fixedToCamera = true;
        this.exitOverlay.anchor.setTo(0.5, 0);

        // optional WS connect to track server economy

        // connect to socket.io server
        if (window.GameNetwork && !window.GameNetwork.isConnected()) {
            var self = this;
            window.GameNetwork.connect('http://localhost:3001', function(){}, function(msg){
                try {
                    var data = JSON.parse(msg);
                    if (data.type === 'welcome' && data.payload && data.payload.id) {
                        self.game.playerId = data.payload.id;
                    }
                    if (data.type === 'balance' && data.payload && typeof data.payload.balance === 'number') {
                        self.serverBalance = data.payload.balance;
                    }
                    if (data.type === 'pellets_state' && data.payload && Array.isArray(data.payload.pellets)) {
                        self.syncPelletsSnapshot(data.payload.pellets);
                    }
                    if (data.type === 'pellets_added' && data.payload && Array.isArray(data.payload.pellets)) {
                        data.payload.pellets.forEach(function(p){ self.addPellet(p); });
                    }
                    if (data.type === 'pellets_removed' && data.payload && Array.isArray(data.payload.ids)) {
                        data.payload.ids.forEach(function(id){ self.removePellet(id); });
                    }
                } catch(e) {}
            }, function(){});
        }

        // adjust background on resize to keep covering world bounds
        var self = this;
        this.game.scale.setResizeCallback(function(game, w, h){
            var ww = self.game.world.width; var wh = self.game.world.height;
            self.background.width = ww; self.background.height = wh;
        }, this);
    },
    /**
     * Main update loop
     */
    update: function() {
        //update game components
        for (var i = this.game.snakes.length - 1 ; i >= 0 ; i--) {
            this.game.snakes[i].update();
        }
        for (var i = this.foodGroup.children.length - 1 ; i >= 0 ; i--) {
            var f = this.foodGroup.children[i];
            f.food.update();
        }
        // update HUD and bridge to HTML overlay
        if (this.game.playerSnake) {
            var local = (this.game.playerSnake.coinBalance || 0);
            var txt = 'Coins: ' + local;
            if (typeof this.serverBalance === 'number') { txt += ' (srv ' + this.serverBalance + ')'; }
            this.coinText.text = txt;
            if (window.GameUI && typeof window.GameUI.setBalances === 'function') {
                window.GameUI.setBalances({ local: local, server: this.serverBalance });
            }
        }

        // ESC hold-to-exit logic (5 seconds)
        if (this.game.input.keyboard.isDown(Phaser.Keyboard.ESC)) {
            this.exitHoldMs += this.game.time.physicsElapsedMS || 16;
            var remain = Math.max(0, 5000 - Math.floor(this.exitHoldMs));
            var sec = Math.ceil(remain / 1000);
            this.exitOverlay.text = 'Hold ESC to Exit: ' + sec;
            if (this.exitHoldMs >= 5000 && !this._withdrawTriggered) {
                this._withdrawTriggered = true;
                this.triggerWithdraw();
            }
        } else {
            this.exitHoldMs = 0;
            this._withdrawTriggered = false;
            this.exitOverlay.text = '';
        }
    },
    respawnBot: function() {
        // respawn a bot at a random location within world bounds
        var w = this.game.world.width * 0.5;
        var h = this.game.world.height * 0.5;
        var rx = Util.randomInt(-w * 0.8, w * 0.8);
        var ry = Util.randomInt(-h * 0.8, h * 0.8);
        var bot = new BotSnake(this.game, 'circle', rx, ry);
        // collisions and callbacks
        bot.head.body.setCollisionGroup(this.snakeHeadCollisionGroup);
        bot.head.body.collides([this.foodCollisionGroup]);
        bot.addDestroyedCallback(this.snakeDestroyed, this);
        // give initial balance so next death drops pellets
        bot.coinBalance = 10;
        return bot;
    },
    triggerWithdraw: function() {
        try {
            // always exit to menu regardless of withdraw availability
            this.exitToMenu();
            if (!window.GameNetwork || !window.GameNetwork.isConnected() || !window.GameNetwork.id()) return;
            var addr = (window.solana && window.solana.publicKey) ? window.solana.publicKey.toString() : null;
            if (!addr) return;
            fetch('http://localhost:3001/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ socketId: window.GameNetwork.id(), wallet: addr }) })
                .then(function(r){ return r.json(); })
                .then(function(j){ /* optionally show toast via GameUI */ })
                .catch(function(){});
        } catch(e) {}
    },
    exitToMenu: function(){
        try {
            // show HTML menu overlay
            var overlay = document.getElementById('menu-overlay');
            if (overlay) { overlay.style.display = 'flex'; }
            // pause game to stop updates and input
            if (this.game && !this.game.paused) { this.game.paused = true; }
        } catch(e) {}
    },
    /**
     * Create a piece of food at a point
     * @param  {number} x x-coordinate
     * @param  {number} y y-coordinate
     * @return {Food}   food object created
     */
    initFood: function(x, y, value, id) {
        var f = new Food(this.game, x, y, id);
        if (typeof value === 'number') { f.value = value; }
        f.sprite.body.setCollisionGroup(this.foodCollisionGroup);
        this.foodGroup.add(f.sprite);
        f.sprite.body.collides([this.snakeHeadCollisionGroup]);
        return f;
    },
    syncPelletsSnapshot: function(items){
        // clear current
        this.foodGroup.removeAll(true);
        var self = this;
        items.forEach(function(p){ self.addPellet(p); });
    },
    addPellet: function(p){
        var f = this.initFood(p.x, p.y, p.value || 1, p.id);
        return f;
    },
    removePellet: function(id){
        for (var i = this.foodGroup.children.length - 1 ; i >= 0 ; i--) {
            var s = this.foodGroup.children[i];
            if (s && s.food && s.food.id === id) { s.food.destroy(); }
        }
    },
    snakeDestroyed: function(snake) {
        // drop only the coins owned by this snake
        // decide pellet count: prefer coin balance; fallback to snake length
        var amount = Math.max(0, snake.coinBalance || 0);
        if (amount <= 0) { amount = Math.max(1, Math.floor(snake.snakeLength)); }
        if (amount > 0) {
            var len = snake.headPath.length;
            var step = Math.max(1, Math.floor(len / amount));
            var items = [];
            for (var i = 0, dropped = 0 ; i < len && dropped < amount ; i += step) {
                var px = snake.headPath[i].x + Util.randomInt(-10,10);
                var py = snake.headPath[i].y + Util.randomInt(-10,10);
                var id = Math.random().toString(36).slice(2);
                items.push({ id: id, x: px, y: py, value: 1 });
                this.initFood(px, py, 1, id);
                dropped++;
            }
            // temp log for verification
            if (!snake.isPlayer) {
                console.log('[BOT_DEATH] pellets spawned =', items.length);
            }
            if (window.GameNetwork && window.GameNetwork.isConnected && window.GameNetwork.isConnected()) {
                window.GameNetwork.send('spawn_pellets', { items: items });
            }
        }
        // reset snake coin balance after death
        snake.coinBalance = 0;
        // respawn bot if needed
        if (!snake.isPlayer) {
            this.respawnBot();
        }
    }
};
