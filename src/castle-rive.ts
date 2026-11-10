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

/** Starts the animation on canvas and hands its inputs to ready before the first frame. Returns a stop function. */
export function playCastle(canvas: HTMLCanvasElement, ready: (inputs: CastleInput[]) => void) {
  const rive: Rive = new Rive({
    buffer: prepare().buffer,
    canvas,
    stateMachine: "loader",
    autoplay: true,
    enableRiveAssetCDN: false,
    layout: new Layout({ fit: Fit.Cover }),
    onLoad: () => {
      rive.resizeDrawingSurfaceToCanvas();
      ready(rive.stateMachineInputs("loader")!);
    },
  });
  const resize = new ResizeObserver(() => rive.resizeDrawingSurfaceToCanvas());
  resize.observe(canvas);
  return () => {
    resize.disconnect();
    rive.cleanup();
  };
}
