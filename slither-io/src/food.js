/**
 * Food that snakes eat - it is pulled towards the center of a snake head after
 * it is first touched
 * @param  {Phaser.Game} game game object
 * @param  {Number} x    coordinate
 * @param  {Number} y    coordinate
 */
Food = function(game, x, y, id) {
    this.game = game;
    this.debug = false;
    this.sprite = this.game.add.sprite(x, y, 'coin');
    this.value = 1;
    this.id = id || null;

    this.game.physics.p2.enable(this.sprite, this.debug);
    this.sprite.body.clearShapes();
    this.sprite.body.addCircle(this.sprite.width * 0.5);
    //set callback for when something hits the food
    this.sprite.body.onBeginContact.add(this.onBeginContact, this);

    this.sprite.food = this;

    this.head = null;
    this.constraint = null;
}

Food.prototype = {
    onBeginContact: function(phaserBody, p2Body) {
        if (phaserBody && phaserBody.sprite.name == "head" && this.constraint === null) {
            this.sprite.body.collides([]);
            //Create constraint between the food and the snake head that
            //it collided with. The food is then brought to the center of
            //the head sprite
            this.constraint = this.game.physics.p2.createRevoluteConstraint(
                this.sprite.body, [0,0], phaserBody, [0,0]
            );
            this.head = phaserBody.sprite;
            this.head.snake.food.push(this);
        }
    },
    /**
     * Call from main update loop
     */
    update: function() {
        //once the food reaches the center of the snake head, destroy it and
        //increment the size of the snake
        if (this.head && Math.round(this.head.body.x) == Math.round(this.sprite.body.x) &&
        Math.round(this.head.body.y) == Math.round(this.sprite.body.y)) {
            // increase local coin balance for death-drop logic
            try {
                if (this.head.snake) {
                    var inc = (typeof this.value === 'number') ? this.value : 1;
                    this.head.snake.coinBalance = (this.head.snake.coinBalance || 0) + inc;
                }
            } catch(e) {}
            // request pickup to server; server will confirm via pellets_removed + balance
            if (window.GameNetwork && window.GameNetwork.isConnected && window.GameNetwork.isConnected()) {
                window.GameNetwork.send('pickup_pellet', { id: this.id });
            }
            // Optimistically destroy to avoid double render; authoritative state will sync
            this.destroy();
        }
    },
    /**
     * Destroy this food and its constraints
     */
    destroy: function() {
        if (this.head) {
            this.game.physics.p2.removeConstraint(this.constraint);
            this.sprite.destroy();
            this.head.snake.food.splice(this.head.snake.food.indexOf(this), 1);
            this.head = null;
        }
    }
};
