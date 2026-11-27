/**
 * The backdrop's WebGL2 program: a few soft pools of colour over a dark
 * vignette, drawn small and scaled up.
 *
 * 1. The pools pass draws a full-screen triangle into a render target 1/8 of the
 *    canvas's size (at least 64 px tall): every pixel blends the pools by their
 *    smooth falloffs, darkens towards the edges and eases towards a soft ceiling.
 * 2. The present pass scales that up to the canvas with linear filtering and
 *    adds dither below one 8-bit step, so the wide, dark gradients don't band.
 *
 * Both passes are a single triangle with no vertex buffers. The render target is
 * half-float where the browser can render to it, for smoother gradients, and
 * 8-bit otherwise.
 */
import { MAX_POOLS } from "./colours";
import type { Uniforms } from "./scene";

/** The render target is this many times smaller than the canvas… */
const DOWNSCALE = 8;
/** …but at least this tall. */
const MIN_TARGET_HEIGHT = 64;

const VERTEX = `#version 300 es
void main() {
  // A triangle that covers the screen: (-1,-1), (3,-1), (-1,3).
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const POOLS = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform vec4 u_pool[${String(MAX_POOLS)}];
uniform vec3 u_colour[${String(MAX_POOLS)}];
uniform float u_ceiling;
out vec4 colour;
void main() {
  // Screen-height units from the centre.
  vec2 p = (gl_FragCoord.xy - 0.5 * u_size) / u_size.y;
  // Where pools overlap their colours blend, weighted by each one's falloff, and
  // their light adds up like layers of frosted glass: it never passes the brightest.
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  float dark = 1.0;
  for (int i = 0; i < ${String(MAX_POOLS)}; i++) {
    vec2 d = p - u_pool[i].xy;
    float r = u_pool[i].z;
    float w = u_pool[i].w * exp(-dot(d, d) / (r * r));
    sum += u_colour[i] * w;
    weight += w;
    dark *= 1.0 - w;
  }
  vec3 c = sum / max(weight, 1e-4) * (1.0 - dark);
  // A dark vignette, measured so it fits any aspect ratio.
  vec2 q = (gl_FragCoord.xy / u_size) * 2.0 - 1.0;
  c *= 1.0 - 0.6 * smoothstep(0.3, 1.5, length(q));
  colour = vec4(u_ceiling * (1.0 - exp(-c / u_ceiling)), 1.0);
}
`;

const PRESENT = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_size;
out vec4 colour;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 c = texture(u_image, gl_FragCoord.xy / u_size).rgb;
  // Triangular dither, ±1 step of 8 bits at most.
  float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 17.0) - 1.0;
  colour = vec4(c + n / 255.0, 1.0);
}
`;

export interface Backdrop {
  /** The canvas's drawing buffer is now `width` × `height`. */
  resize: (width: number, height: number) => void;
  render: (uniforms: Uniforms) => void;
  dispose: () => void;
}

/** The render target's size for a canvas of `width` × `height`. */
export function targetSize(width: number, height: number): [number, number] {
  const h = Math.max(MIN_TARGET_HEIGHT, Math.ceil(height / DOWNSCALE));
  return [Math.max(1, Math.round((width * h) / Math.max(1, height))), h];
}

/**
 * Makes the program for `canvas`. Throws if WebGL2 is missing or anything fails
 * to build; whatever was built by then is deleted first.
 */
export function createBackdrop(canvas: HTMLCanvasElement): Backdrop {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (!gl) {
    throw new Error("WebGL2 isn't available");
  }
  const cleanups: (() => void)[] = [];
  const dispose = () => {
    // Newest first, so nothing is deleted while something built on it remains.
    for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
      cleanup();
    }
  };
  try {
    return build(gl, cleanups, dispose);
  } catch (error) {
    dispose();
    throw error;
  }
}

function build(
  gl: WebGL2RenderingContext,
  cleanups: (() => void)[],
  dispose: () => void,
): Backdrop {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Couldn't create a shader");
    }
    cleanups.push(() => {
      gl.deleteShader(shader);
    });
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true && !gl.isContextLost()) {
      throw new Error(`Shader didn't compile: ${gl.getShaderInfoLog(shader) ?? ""}`);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const link = (source: string) => {
    const program = gl.createProgram();
    cleanups.push(() => {
      gl.deleteProgram(program);
    });
    gl.attachShader(program, vertex);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source));
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true && !gl.isContextLost()) {
      throw new Error(`Program didn't link: ${gl.getProgramInfoLog(program) ?? ""}`);
    }
    return program;
  };
  const pools = link(POOLS);
  const present = link(PRESENT);
  const at = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name);
  const poolsSize = at(pools, "u_size");
  const poolsPool = at(pools, "u_pool");
  const poolsColour = at(pools, "u_colour");
  const poolsCeiling = at(pools, "u_ceiling");
  const presentImage = at(present, "u_image");
  const presentSize = at(present, "u_size");

  const vao = gl.createVertexArray();
  cleanups.push(() => {
    gl.deleteVertexArray(vao);
  });
  const texture = gl.createTexture();
  cleanups.push(() => {
    gl.deleteTexture(texture);
  });
  const framebuffer = gl.createFramebuffer();
  cleanups.push(() => {
    gl.deleteFramebuffer(framebuffer);
  });
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  let halfFloat = gl.getExtension("EXT_color_buffer_float") !== null;

  let canvasSize: [number, number] = [1, 1];
  let target: [number, number] = [0, 0];

  /** (Re)allocates the render target, falling back to 8 bits if half-float won't attach. */
  const allocate = (width: number, height: number) => {
    target = [width, height];
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    for (;;) {
      if (halfFloat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          width,
          height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
      }
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (complete || gl.isContextLost()) {
        break;
      }
      if (!halfFloat) {
        throw new Error("Couldn't make the backdrop's render target");
      }
      halfFloat = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const resize = (width: number, height: number) => {
    canvasSize = [width, height];
    const [w, h] = targetSize(width, height);
    if (w !== target[0] || h !== target[1]) {
      allocate(w, h);
    }
  };
  resize(gl.drawingBufferWidth, gl.drawingBufferHeight);

  return {
    resize,
    render(uniforms) {
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, target[0], target[1]);
      gl.useProgram(pools);
      gl.uniform2f(poolsSize, target[0], target[1]);
      gl.uniform4fv(poolsPool, uniforms.pools);
      gl.uniform3fv(poolsColour, uniforms.colours);
      gl.uniform1f(poolsCeiling, uniforms.ceiling);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasSize[0], canvasSize[1]);
      gl.useProgram(present);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(presentImage, 0);
      gl.uniform2f(presentSize, canvasSize[0], canvasSize[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose,
  };
}
