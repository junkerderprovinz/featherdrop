// Plays castle-loader.riv, which anim/paths-rive/tools in castleparcel-prototype builds. The Rive
// runtime would fetch its WebAssembly from a CDN, and the page runs no code its pinned main script
// does not carry, so the WebAssembly and the animation it parses travel inside that script and reach
// the runtime as bytes. Both are decoded on the first transfer, not when the page loads.
import { Fit, Layout, Rive, RuntimeLoader } from "@rive-app/canvas-lite";
import wasm from "@rive-app/canvas-lite/rive.wasm?url&inline";
import { fromBase64 } from "@/lib/e2e/base64";
import type { CastleInput } from "@/lib/castle-loader";
import riv from "@/src/assets/castle-loader.riv?url&inline";

const bytes = (dataUrl: string) => fromBase64(dataUrl.slice(dataUrl.indexOf(",") + 1));

// The artboard, with the tower in its middle. Its width fills the stage, which shows the band the
// letters keep to from 175 to 935.
const ART_WIDTH = 1520;
const ART_HEIGHT = 1110;

let file: Uint8Array<ArrayBuffer> | undefined;

function prepare() {
  if (file) return file;
  RuntimeLoader.setWasmBinary(bytes(wasm).buffer);
  RuntimeLoader.setWasmFallbackUrl(null);
  // The file drives its animation through state machine inputs and has no view model to bind.
  Rive.suppressDeprecationWarnings = ["state-machine-inputs"];
  file = bytes(riv);
  return file;
}

export interface CastleHooks {
  /** Gets the inputs before the first frame. */
  ready: (inputs: CastleInput[]) => void;
  /** Hears, on start and on every resize, how far the farther window edge lies from the castle's
   * middle and how wide the artboard is drawn, both in CSS pixels. */
  placed: (edge: number, width: number) => void;
}

/** Plays the castle on canvas with the artboard over stage, and lets the canvas run from one window
 * edge to the other so the letters can come from and go past them. Returns a stop function. */
export function playCastle(canvas: HTMLCanvasElement, stage: HTMLElement, hooks: CastleHooks) {
  let loaded = false;
  const place = () => {
    const box = stage.getBoundingClientRect();
    const view = document.documentElement.clientWidth;
    canvas.style.left = `${-box.left}px`;
    canvas.style.width = `${view}px`;
    const middle = box.left + box.width / 2;
    hooks.placed(Math.max(middle, view - middle), box.width);
    if (!loaded) return;
    rive.resizeDrawingSurfaceToCanvas();
    const dpr = rive.devicePixelRatioUsed;
    const height = (box.width * ART_HEIGHT) / ART_WIDTH;
    rive.layout = new Layout({
      fit: Fit.Contain,
      minX: box.left * dpr,
      maxX: box.right * dpr,
      minY: ((box.height - height) / 2) * dpr,
      maxY: ((box.height + height) / 2) * dpr,
    });
  };
  const rive: Rive = new Rive({
    buffer: prepare().buffer,
    canvas,
    stateMachine: "loader",
    autoplay: true,
    enableRiveAssetCDN: false,
    onLoad: () => {
      loaded = true;
      place();
      hooks.ready(rive.stateMachineInputs("loader")!);
    },
  });
  place();
  const resize = new ResizeObserver(place);
  resize.observe(stage);
  // The page's width changes without the stage's when the column has reached its widest, and when a
  // scrollbar comes or goes.
  resize.observe(document.documentElement);
  return () => {
    resize.disconnect();
    rive.cleanup();
  };
}
