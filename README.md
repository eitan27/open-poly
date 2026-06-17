# open-shape

An open source, locally runnable, in-browser CAD application.

open-shape runs entirely in your browser — modeling is powered by the OpenCASCADE geometry kernel (via [replicad](https://replicad.xyz/)) compiled to WebAssembly, rendered with [three.js](https://threejs.org/), with parametric sketch constraints handled by [planegcs](https://github.com/Salusoft89/planegcs).

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- npm (ships with Node.js)

## Clone

```bash
git clone git@github.com:eitan27/open-shape.git
cd open-shape
```

## Install

```bash
npm install
```

## Run

Start the dev server:

```bash
npm run dev
```

Vite will print a local URL (default http://localhost:5173) — open it in your browser.

## Other scripts

| Command           | Description                                      |
| ----------------- | ------------------------------------------------ |
| `npm run dev`     | Start the Vite dev server with hot reloading.    |
| `npm run build`   | Type-check and build a production bundle.         |
| `npm run preview` | Serve the production build locally to preview it. |
