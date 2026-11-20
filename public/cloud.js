// A cloud of dots round a trefoil knot, turning slowly, drawn here from the
// knot's own equation. While the page is listening it swells with the voice.

const TONES = [
  ['#daff52', 0.44],
  ['#91fffa', 0.26],
  ['#ffb592', 0.12],
  ['#ff95e5', 0.07],
  ['#f2f2f2', 0.11],
];

/** A small seeded generator, so the cloud is the same on every visit. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function knot(count, tube) {
  const random = seeded(7);
  const spread = () => (random() + random() + random() + random() - 2) / 2;
  const dots = [];
  for (let i = 0; i < count; i++) {
    const t = random() * Math.PI * 2;
    const r = 2 + Math.cos(3 * t);
    let pick = random();
    let tone = 0;
    for (let k = 0; k < TONES.length; k++) {
      pick -= TONES[k][1];
      if (pick <= 0) {
        tone = k;
        break;
      }
    }
    // Where the dot sits on the knot, and which way it leans off it.
    dots.push({ x: r * Math.cos(2 * t), y: r * Math.sin(2 * t), z: Math.sin(3 * t) * 1.25, ox: spread() * tube, oy: spread() * tube, oz: spread() * tube, tone });
  }
  return dots;
}

export function cloud(canvas) {
  const context = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dots = knot(innerWidth < 700 ? 1500 : 2600, 0.42);
  const tilt = 0.5;
  const lean = 0.5;
  let level = 0;
  let heard = 0;
  let spin = 0;
  let width = 0;
  let height = 0;
  let seen = true;
  let last = 0;

  function fit() {
    const ratio = Math.min(2, devicePixelRatio || 1);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    const scale = Math.min(width, height) / 7.2;
    const [ct, st, cl, sl, cs, ss] = [Math.cos(tilt), Math.sin(tilt), Math.cos(lean), Math.sin(lean), Math.cos(spin), Math.sin(spin)];
    const swell = 1 + level * 1.6;
    for (let tone = 0; tone < TONES.length; tone++) {
      context.fillStyle = TONES[tone][0];
      for (const dot of dots) {
        if (dot.tone !== tone) continue;
        const px = dot.x + dot.ox * swell;
        const py = dot.y + dot.oy * swell;
        const pz = dot.z + dot.oz * swell;
        const x0 = px * cs - py * ss;
        const y0 = px * ss + py * cs;
        const y1 = y0 * ct - pz * st;
        const z1 = y0 * st + pz * ct;
        const depth = 9 / (9 + z1);
        const x = x0 * depth * scale;
        const y = y1 * depth * scale;
        const size = 1.5 * depth * depth;
        context.globalAlpha = Math.max(0.25, Math.min(1, depth - 0.25));
        context.fillRect(width / 2 + x * cl - y * sl, height / 2 + x * sl + y * cl, size, size);
      }
    }
    context.globalAlpha = 1;
  }

  function frame(now) {
    if (seen && now - last > 32) {
      last = now;
      level += (heard - level) * 0.18;
      heard *= 0.92;
      spin += 0.0016 + level * 0.004;
      draw();
    }
    requestAnimationFrame(frame);
  }

  fit();
  draw();
  addEventListener('resize', () => (fit(), draw()));
  new IntersectionObserver(([entry]) => (seen = entry.isIntersecting)).observe(canvas);
  if (!still) requestAnimationFrame(frame);

  return {
    /** How loud the voice is right now, from 0 to 1. */
    hear(loud) {
      heard = Math.max(heard, Math.min(1, loud));
      if (still) {
        level = heard;
        draw();
      }
    },
  };
}
