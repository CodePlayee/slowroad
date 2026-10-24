# Slowroad

Open world scenic driving built with Vite and Three.js. The scene includes
procedural terrain and roads, bridges and water, streamed vegetation, seasonal
atmosphere, and a locally bundled Tesla Model Y vehicle asset.

## Run locally

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5188/>.

## Validate

```sh
npm run build
node --test gauntlet/*.test.mjs
```

The `gauntlet/` directory contains deterministic runtime checks and capture
tools. Generated captures and benchmark rounds are ignored by Git.
