# Snake Game

A feature-parallel app: game logic, rendering, and input are separable, with the pure logic unit-tested in Node.

## Prompt

```text
/dag-plan Build a snake game for the browser (vanilla JS, canvas, no build step, no external assets).
- Pure game logic in game.js (no DOM): 20x20 grid, snake movement, wall collision, food spawn on a random free cell, score, speed-up every 5 foods; export the functions so Node can import them
- index.html + render.js: canvas rendering, arrow/WASD input, fixed-timestep game loop, game-over overlay with a restart button
- High score persisted in localStorage under the key "snake.highscore"
- Tests: node:test in test/game.test.js covering movement, collision, eating, and food never spawning on the snake; `npm test` must pass
- Playing: open index.html in a browser (no server required)
```
