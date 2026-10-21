"use strict";

// StageCue is a browser simulation. It never sends commands to lighting,
// captioning, or sound equipment.
const EXAMPLES = {
  midnight: `// A short, original scene for StageCue
show "A Midnight Conversation"
length 90s

cue "Pre-show" at 0s for 12s
  light left 20%
  light right 20%
  caption "The house settles into silence."
end

cue "Opening" at 12s for 20s
  light center 75%
  light left 40%
  caption "One small light appears."
  sound chime
end

cue "A second voice" at 32s for 28s
  light left 65%
  light right 55%
  caption "Two stories meet at the table."
end

cue "Afterglow" at 60s for 30s
  light center 35%
  light right 20%
  caption "The room remembers."
  sound pulse
end`,
  collision: `// Two overlapping windows are intentionally flagged
show "Collision Study"
length 70s

cue "Warm entry" at 0s for 22s
  light left 70%
  caption "The door opens."
end

cue "Interrupted line" at 18s for 24s
  light center 80%
  caption "Wait — another voice."
  sound pulse
end

cue "Resolution" at 42s for 28s
  light right 65%
  caption "The stage grows still."
end`,
  blank: `// Write your own cue script
show "Untitled show"
length 60s

cue "First look" at 0s for 15s
  light center 60%
  caption "Your story starts here."
end`
};

const $ = (id) => document.getElementById(id);
const source = $("source");
const cueList = $("cue-list");
const diagnosticsList = $("diagnostics-list");
const timeline = $("timeline");
const scrub = $("scrub");
let compiled = {title:"",length:0,cues:[],issues:[]};
let time = 0;
let playing = false;
let frame = 0;
let lastFrame = 0;
let lastSoundCue = null;
let muted = false;
let audioContext;
let compiledSource = "";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]);
}
function formatTime(seconds) {
  const n = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(n / 60)).padStart(2,"0")}:${String(n % 60).padStart(2,"0")}`;
}
function issue(type,line,message,cues=[]) { return {type,line,message,cues}; }
function parse(input) {
  const lines = input.split(/\r?\n/);
  const result = {title:"Untitled show",length:0,cues:[],issues:[]};
  let current = null;
  let sawShow = false, sawLength = false;
  const add = (type,line,message) => result.issues.push(issue(type,line,message));
  lines.forEach((raw,index) => {
    const line = raw.trim();
    const number = index + 1;
    if (!line || line.startsWith("//")) return;
    let match;
    if ((match = line.match(/^show\s+"([^"]+)"$/i))) {
      if (current) return add("error",number,"Close the current cue with end first.");
      if (sawShow) add("error",number,"A show title is already defined.");
      result.title = match[1]; sawShow = true; return;
    }
    if ((match = line.match(/^length\s+(\d+(?:\.\d+)?)s$/i))) {
      if (current) return add("error",number,"Length belongs outside cue blocks.");
      if (sawLength) add("error",number,"Show length is already defined.");
      result.length = Number(match[1]); sawLength = true;
      if (result.length <= 0 || result.length > 3600) add("error",number,"Length must be from 1 to 3600 seconds.");
      return;
    }
    if ((match = line.match(/^cue\s+"([^"]+)"\s+at\s+(\d+(?:\.\d+)?)s\s+for\s+(\d+(?:\.\d+)?)s$/i))) {
      if (current) add("error",number,`Close cue “${current.name}” with end before opening another.`);
      current = {name:match[1],start:Number(match[2]),duration:Number(match[3]),line:number,lights:{left:0,center:0,right:0},caption:"",sound:"none"};
      if (current.duration <= 0) add("error",number,"Cue duration must be greater than zero.");
      result.cues.push(current); return;
    }
    if (/^end$/i.test(line)) {
      if (!current) add("error",number,"end has no open cue.");
      current = null; return;
    }
    if ((match = line.match(/^light\s+(left|center|right)\s+(\d+(?:\.\d+)?)%$/i))) {
      if (!current) return add("error",number,"light must appear inside a cue.");
      const level = Number(match[2]);
      if (level > 100) return add("error",number,"Light level must be between 0% and 100%.");
      current.lights[match[1].toLowerCase()] = level; return;
    }
    if ((match = line.match(/^caption\s+"([^"]*)"$/i))) {
      if (!current) return add("error",number,"caption must appear inside a cue.");
      current.caption = match[1]; return;
    }
    if ((match = line.match(/^sound\s+(none|chime|pulse)$/i))) {
      if (!current) return add("error",number,"sound must appear inside a cue.");
      current.sound = match[1].toLowerCase(); return;
    }
    add("error",number,`Unknown command: ${line.slice(0,64)}`);
  });
  if (current) add("error",current.line,`Cue “${current.name}” is missing end.`);
  if (!sawShow) add("error",1,"Add a show title with show \"Title\".");
  if (!sawLength) add("error",1,"Add a show length, for example length 90s.");
  if (!result.cues.length) add("error",1,"Add at least one cue block.");
  const names = new Set();
  result.cues.forEach(cue => {
    if (names.has(cue.name.toLowerCase())) add("error",cue.line,`Cue name “${cue.name}” is repeated.`);
    names.add(cue.name.toLowerCase());
    if (cue.start + cue.duration > result.length) add("error",cue.line,`Cue “${cue.name}” ends after the show length.`);
  });
  const ordered = [...result.cues].sort((a,b) => a.start-b.start || a.line-b.line);
  for (let i=0;i<ordered.length;i++) for (let j=i+1;j<ordered.length;j++) {
    const a=ordered[i], b=ordered[j];
    if (b.start >= a.start+a.duration) break;
    result.issues.push(issue("warning",b.line,`“${b.name}” overlaps “${a.name}” by ${(Math.min(a.start+a.duration,b.start+b.duration)-b.start).toFixed(1).replace(/\.0$/,'')}s.`,[a.name,b.name]));
  }
  result.cues = ordered;
  return result;
}

function cueAt(seconds) {
  // A later cue takes visual priority during an overlap. The overlap remains
  // visible as a warning in the inspector and timeline.
  return [...compiled.cues].reverse().find(cue => seconds >= cue.start && seconds < cue.start + cue.duration) || null;
}
function beep(kind) {
  if (muted || kind === "none") return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = kind === "chime" ? "sine" : "triangle";
    const now = audioContext.currentTime;
    oscillator.frequency.setValueAtTime(kind === "chime" ? 880 : 220,now);
    if (kind === "chime") oscillator.frequency.exponentialRampToValueAtTime(660,now+.28);
    gain.gain.setValueAtTime(.0001,now);
    gain.gain.exponentialRampToValueAtTime(.08,now+.02);
    gain.gain.exponentialRampToValueAtTime(.0001,now+.36);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now); oscillator.stop(now+.37);
  } catch (_) { /* Visual simulation stays available without Web Audio. */ }
}
function renderAt(seconds) {
  time = Math.max(0,Math.min(seconds,compiled.length || 0));
  const cue = cueAt(time);
  const lights = cue?.lights || {left:0,center:0,right:0};
  const stage = $("stage");
  stage.style.setProperty("--left",lights.left/100);
  stage.style.setProperty("--center",lights.center/100);
  stage.style.setProperty("--right",lights.right/100);
  $("current-cue").textContent = cue ? cue.name : "No active cue";
  $("current-caption").textContent = cue?.caption || "The stage is waiting for its next cue.";
  $("current-sound").textContent = `Sound: ${cue?.sound || "none"}`;
  $("now-label").textContent = cue ? `${compiled.title} · ${cue.name}` : compiled.title;
  $("time-readout").textContent = `${formatTime(time)} / ${formatTime(compiled.length)}`;
  scrub.value = compiled.length ? String(Math.round(time/compiled.length*1000)) : "0";
  document.querySelectorAll(".cue-row,.timeline-cue").forEach(el => el.classList.toggle("selected",el.dataset.cue === cue?.name));
  if (playing && cue?.name !== lastSoundCue) { lastSoundCue = cue?.name || null; if (cue) beep(cue.sound); }
}
function renderCompilation() {
  const errors = compiled.issues.filter(item=>item.type==="error");
  const warnings = compiled.issues.filter(item=>item.type==="warning");
  $("issue-count").textContent = `${errors.length} error${errors.length===1?"":"s"} · ${warnings.length} warning${warnings.length===1?"":"s"}`;
  $("issue-count").className = `issue-count ${errors.length?"has-error":warnings.length?"has-warning":""}`;
  cueList.innerHTML = compiled.cues.map((cue,index) => {
    const conflict = warnings.some(item=>item.cues.includes(cue.name));
    return `<button type="button" class="cue-row ${conflict?"conflict":""}" data-index="${index}" data-cue="${escapeHtml(cue.name)}"><span><b>${String(index+1).padStart(2,"0")}</b>${escapeHtml(cue.name)}</span><time>${formatTime(cue.start)}</time><em>${conflict?"Overlap":"Ready"}</em></button>`;
  }).join("") || '<p class="empty">No cues yet.</p>';
  diagnosticsList.innerHTML = compiled.issues.map(item=>`<div class="diagnostic ${item.type}"><b>${item.type === "error" ? "✕" : "!"}</b><p><span>Line ${item.line}</span>${escapeHtml(item.message)}</p></div>`).join("") || '<div class="diagnostic clean"><b>✓</b><p>Syntax and timing checks passed.</p></div>';
  timeline.innerHTML = compiled.cues.map((cue,index) => {
    const left = compiled.length ? Math.max(0,Math.min(100,cue.start/compiled.length*100)) : 0;
    const width = compiled.length ? Math.max(.8,Math.min(100-left,cue.duration/compiled.length*100)) : 0;
    const conflict = warnings.some(item=>item.cues.includes(cue.name));
    return `<button type="button" class="timeline-cue ${conflict?"conflict":""}" data-index="${index}" data-cue="${escapeHtml(cue.name)}" style="left:${left}%;width:${width}%" title="${escapeHtml(cue.name)}: ${formatTime(cue.start)}–${formatTime(cue.start+cue.duration)}"><b>${index+1}</b><span>${escapeHtml(cue.name)}</span></button>`;
  }).join("");
  $("mid-time").textContent = formatTime(compiled.length/2);
  $("end-time").textContent = formatTime(compiled.length);
  scrub.disabled = !compiled.length;
  renderAt(Math.min(time,compiled.length));
}
function compile() {
  stop();
  compiled = parse(source.value);
  compiledSource = source.value;
  time = 0; lastSoundCue = null;
  renderCompilation();
  return !compiled.issues.some(item=>item.type==="error");
}
function tick(now) {
  if (!playing) return;
  if (lastFrame) renderAt(time + (now-lastFrame)/1000*Number($("speed").value));
  lastFrame = now;
  if (time >= compiled.length) { stop(); renderAt(compiled.length); return; }
  frame = requestAnimationFrame(tick);
}
function stop() {
  playing = false; cancelAnimationFrame(frame); lastFrame = 0; lastSoundCue = null;
  $("play").innerHTML = '▶ <span>Run show</span>';
}
function updateLineCount() { $("line-count").textContent = `${source.value.split(/\r?\n/).length} lines`; }

$("example").addEventListener("change",event => { source.value = EXAMPLES[event.target.value]; updateLineCount(); compile(); });
source.addEventListener("input",updateLineCount);
source.addEventListener("keydown",event => {
  if (event.key !== "Tab") return;
  event.preventDefault(); const start=source.selectionStart,end=source.selectionEnd;
  source.setRangeText("  ",start,end,"end"); updateLineCount();
});
$("compile").addEventListener("click",compile);
$("play").addEventListener("click",() => {
  if (playing) { stop(); return; }
  if (source.value !== compiledSource && !compile()) { $("diagnostics-list").scrollIntoView({block:"nearest",behavior:"smooth"}); return; }
  if (compiled.issues.some(item=>item.type==="error")) { $("diagnostics-list").scrollIntoView({block:"nearest",behavior:"smooth"}); return; }
  if (time >= compiled.length) renderAt(0);
  playing = true; lastFrame = 0; lastSoundCue = null;
  $("play").innerHTML = '❚❚ <span>Pause show</span>';
  frame = requestAnimationFrame(tick);
});
$("stop").addEventListener("click",() => { stop(); renderAt(0); });
$("mute").addEventListener("click",() => { muted=!muted; $("mute").setAttribute("aria-pressed",String(muted)); $("mute").setAttribute("aria-label",muted?"Unmute simulated audio":"Mute simulated audio"); $("mute").textContent=muted?"♪̸":"♫"; });
scrub.addEventListener("input",() => { stop(); renderAt(Number(scrub.value)/1000*compiled.length); });
function jump(event) {
  const target = event.target.closest("[data-index]");
  if (!target) return;
  const cue = compiled.cues[Number(target.dataset.index)];
  if (cue) { stop(); renderAt(cue.start); }
}
cueList.addEventListener("click",jump);
timeline.addEventListener("click",jump);

source.value = EXAMPLES.midnight;
updateLineCount();
compile();
