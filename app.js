// =====================================================================
//  Qwen2.5-0.5B in the browser with WebLLM + two spinning wheels
// =====================================================================
import * as webllm from "https://esm.run/@mlc-ai/web-llm";

// ---- Settings you will tweak ---------------------------------------
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const SYSTEM_PROMPT = "You are a playful oracle. Answer in one or two short sentences.";
const MAX_TOKENS = 80;
const SPIN_MS = 4500; // keep equal to the transition time in style.css

// ---- Grab elements --------------------------------------------------
const $ = (id) => document.getElementById(id);
const loadBtn = $("loadBtn"), progress = $("progress"), statusEl = $("status");
const form = $("form"), input = $("input"), sendBtn = $("sendBtn");
const logEl = $("log"), output = $("output"), rewardEl = $("reward"), rarityBar = $("rarityBar");

let engine = null, busy = false;

// =====================================================================
//  WHEELS
// =====================================================================

// Random slice sizes that add up to 360°.
function randomSizes(n) {
  const raw = Array.from({ length: n }, () => 0.4 + Math.random()); // 0.4 stops slivers
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => (r / total) * 360);
}

// SVG path for one pie slice. Angles in degrees, clockwise, 0 = top.
function slicePath(startDeg, endDeg, r = 100) {
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [r * Math.sin(rad), -r * Math.cos(rad)];
  };
  const [x1, y1] = pt(startDeg), [x2, y2] = pt(endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0; // arc longer than half circle?
  return `M0 0 L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

// Build a wheel. `values` = what each slice is worth, `colorFn` = slice color.
function makeWheel(svgId, wrapId, valId, values, colorFn, format) {
  const svg = $(svgId), wrap = $(wrapId), valEl = $(valId);
  const sizes = randomSizes(values.length);
  let start = 0;
  const slices = values.map((value, i) => {
    const s = { start, end: start + sizes[i], value };
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", slicePath(s.start, s.end));
    p.setAttribute("fill", colorFn(i));
    svg.appendChild(p);
    start = s.end;
    return s;
  });

  const wheel = {
    rotation: 0,       // total degrees turned so far (keeps growing)
    spinning: false,
    spun: false,       // spun since the last answer?
    value: null,
    // Which slice is under the pointer for a given rotation?
    sliceAt(rotation) {
      const a = ((-rotation % 360) + 360) % 360; // wheel angle now at the top
      return slices.find((s) => a >= s.start && a < s.end) ?? slices[0];
    },
    spin() {
      if (wheel.spinning) return Promise.resolve(wheel.value);
      wheel.spinning = true;
      wrap.classList.add("spinning");
      valEl.textContent = "…";
      // Pick a random landing angle, then add 5–7 full turns for drama.
      const landing = Math.random() * 360;
      const turns = 5 + Math.floor(Math.random() * 3);
      const current = ((wheel.rotation % 360) + 360) % 360;
      const delta = turns * 360 + ((((-landing - current) % 360) + 360) % 360);
      wheel.rotation += delta;
      svg.style.transform = `rotate(${wheel.rotation}deg)`;
      return new Promise((resolve) =>
        setTimeout(() => {
          wheel.value = wheel.sliceAt(wheel.rotation).value;
          valEl.textContent = format(wheel.value);
          wheel.spinning = false;
          wheel.spun = true;
          wrap.classList.remove("spinning");
          resolve(wheel.value);
        }, SPIN_MS + 100)
      );
    },
  };
  wheel.value = wheel.sliceAt(0).value;
  valEl.textContent = format(wheel.value);
  wrap.addEventListener("click", () => { if (!busy) wheel.spin(); });
  return wheel;
}

// Temperature wheel: REAL. Each slice is a temperature, in shuffled order.
const temps = [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5].sort(() => Math.random() - 0.5);
const hue0 = Math.random() * 360;
const tempWheel = makeWheel(
  "tempWheel", "tempWrap", "tempVal", temps,
  (i) => `hsl(${(hue0 + i * 137.5) % 360} ${35 + Math.random() * 35}% ${45 + Math.random() * 30}%)`, // hue · saturation · lightness
  (v) => v.toFixed(1)
);

// Luck wheel: FAKE. Its value is shown and logged, but never sent to the model.
const lucks = Array.from({ length: 5 }, () => Math.floor(Math.random() * 100));
const luckWheel = makeWheel(
  "luckWheel", "luckWrap", "luckVal", lucks,
  () => `hsl(${38 + Math.random() * 12} ${55 + Math.random() * 35}% ${48 + Math.random() * 32}%)`, // golds
  (v) => `${v}%`
);

// =====================================================================
//  MODEL
// =====================================================================
if (!navigator.gpu) {
  statusEl.textContent = "WebGPU isn't available. Use desktop Chrome or Edge.";
  loadBtn.disabled = true;
}

loadBtn.addEventListener("click", async () => {
  loadBtn.disabled = true;
  try {
    engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (r) => { progress.value = r.progress; statusEl.textContent = r.text; },
    });
    statusEl.textContent = "Ready.";
    sendBtn.disabled = false;
    input.focus();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't load the model: " + err.message;
    loadBtn.disabled = false;
  }
});

let t0 = 0;
function logStep(text) {
  const li = document.createElement("li");
  li.textContent = `+${Math.round(performance.now() - t0)}ms  ${text}`;
  logEl.appendChild(li);
}

function setLocked(on) {
  busy = on;
  sendBtn.disabled = on;
  ["tempWrap", "luckWrap"].forEach((id) => $(id).classList.toggle("locked", on));
}

// =====================================================================
//  ROULETTE REVEAL
//  Each token flickers through the alternatives the model actually
//  considered (its "top_logprobs"), then settles on the one it picked.
//  The less sure the model was, the longer the roulette spins.
// =====================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Special tokens look like <|im_end|>: the model's internal "I'm done" signals.
const isSpecial = (t) => /^<\|[^|]*\|>$/.test(t.trim());
const FILLER = ["…", "▒", "?", "·", "~"]; // used only if no alternatives come back

// Strangeness 0 → 1 becomes a color: grey (expected) → blue (unusual) → gold (very strange).
// The stops match the common / rare / legendary badges.
function rarityColor(s) {
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const grey = [221, 221, 221], blue = [61, 90, 254], gold = [247, 201, 72];
  const rgb = s < 0.5 ? mix(grey, blue, s / 0.5) : mix(blue, gold, (s - 0.5) / 0.5);
  return `rgb(${rgb.join(",")})`;
}

async function revealToken({ text, alts }) {
  const span = document.createElement("span");
  span.className = "tok rolling";
  output.appendChild(span);

  // Probability of the token the model chose (logprob → %)
  const mine = alts.find((a) => a.token === text);
  const p = mine ? Math.exp(mine.logprob) : 0.5;

  // Candidates to flicker through: the OTHER tokens it considered
  let pool = alts.map((a) => a.token).filter((t) => t !== text && t.trim() && !isSpecial(t));
  if (!pool.length) pool = FILLER;

  // Unsure → more frames. Each frame is a little slower (suspense).
  const frames = Math.round(2 + (1 - p) * 10);
  for (let i = 0; i < frames; i++) {
    span.textContent = pool[Math.floor(Math.random() * pool.length)];
    await sleep(20 + i * i * 1.5);
  }

  span.textContent = text;
  span.className = "tok" + (p < 0.4 ? " unsure" : "");

  // Add this token's slice to the rarity bar (strangeness = 1 - probability)
  const seg = document.createElement("span");
  seg.style.background = rarityColor(1 - p);
  seg.title = `${JSON.stringify(text)} · ${(p * 100).toFixed(0)}% likely`;
  rarityBar.appendChild(seg);
  // Hover a word to see what else it could have been
  span.title = alts
    .map((a) => `${JSON.stringify(a.token)}  ${(Math.exp(a.logprob) * 100).toFixed(1)}%`)
    .join("\n");
  return p;
}

// =====================================================================
//  ASK
// =====================================================================
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const userText = input.value.trim();
  if (!userText || busy || !engine) return;
  setLocked(true);
  logEl.innerHTML = ""; output.textContent = ""; rewardEl.innerHTML = ""; rarityBar.innerHTML = "";
  t0 = performance.now();

  // Any wheel the user didn't spin since the last answer spins now.
  const toSpin = [tempWheel, luckWheel].filter((w) => !w.spun || w.spinning);
  if (toSpin.length) {
    logStep("spinning the wheels…");
    await Promise.all(toSpin.map((w) => w.spin()));
  }
  const temperature = tempWheel.value;

  logStep(`luck ${luckWheel.value}% locked in, applying…`); // illusion: never used
  logStep(`temperature ${temperature.toFixed(1)} sent to the model`);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];

  let firstTokenAt = null, pieces = 0;
  let sumLogprob = 0, scored = 0;
  const queue = [];          // tokens waiting to be revealed
  const confidences = [];
  let streamDone = false;

  // The revealer runs alongside the stream: the model can be faster than
  // the animation, so tokens wait in the queue and come out one by one.
  const revealer = (async () => {
    while (!streamDone || queue.length) {
      if (!queue.length) { await sleep(20); continue; }
      confidences.push(await revealToken(queue.shift()));
    }
  })();

  try {
    const stream = await engine.chat.completions.create({
      messages, temperature, max_tokens: MAX_TOKENS, stream: true,
      logprobs: true,     // ask for the probability of each token…
      top_logprobs: 5,    // …and the 5 most likely alternatives at each step
    });
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const lp = choice.logprobs?.content ?? [];
      const piece = choice.delta?.content ?? "";
      if (!lp.length && !piece) continue;
      if (firstTokenAt === null) { firstTokenAt = performance.now(); logStep("first token arrived"); }
      if (lp.length) {
        for (const t of lp) {
          if (isSpecial(t.token)) continue; // skip <|im_end|> and friends
          sumLogprob += t.logprob; scored++;
          queue.push({ text: t.token, alts: t.top_logprobs ?? [] }); pieces++;
        }
      } else {
        if (!isSpecial(piece)) { queue.push({ text: piece, alts: [] }); pieces++; } // fallback: no alternatives
      }
    }
    const secs = (performance.now() - firstTokenAt) / 1000;
    logStep(`${pieces} tokens generated · ${(pieces / secs).toFixed(1)} tokens/sec`);
    streamDone = true;
    await revealer; // wait for the animation to catch up
    const avg = confidences.reduce((a, b) => a + b, 0) / (confidences.length || 1);
    logStep(`average confidence ${(avg * 100).toFixed(0)}% · hover a word to see its rivals`);

    // Reward based on how unlikely this answer actually was.
    let tier;
    if (scored) {
      const avgP = Math.exp(sumLogprob / scored); // typical probability per token
      const odds = Math.exp(-sumLogprob);         // odds of this exact answer
      tier = avgP < 0.35 ? "legendary" : avgP < 0.6 ? "rare" : "common";
      logStep(`each token ~${(avgP * 100).toFixed(0)}% likely · odds of this exact answer: 1 in ${odds < 1e6 ? Math.round(odds).toLocaleString() : odds.toExponential(1)} → ${tier}`);
    } else {
      const r = Math.random(); // fallback if no logprobs came back
      tier = r > 0.95 ? "legendary" : r > 0.75 ? "rare" : "common";
    }
    const label = { legendary: "★ LEGENDARY", rare: "RARE", common: "common" }[tier];
    rewardEl.innerHTML = `<span class="badge ${tier}">${label}</span>`;
  } catch (err) {
    console.error(err);
    streamDone = true; await revealer;
    output.textContent = "Error: " + err.message;
  }

  tempWheel.spun = false; luckWheel.spun = false; // next answer needs fresh spins
  setLocked(false);
  input.focus();
});
