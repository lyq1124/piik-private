import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSocket } from "node:dgram";
import {
  CdpConnection,
  cleanupRun,
  createPage,
  evaluate,
  fetchJsonBefore,
  launchChrome,
  reservePort,
  waitForSample,
  waitForVersion,
  type PageHandle,
} from "./browser-gate-harness";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "build/private-room-voice");
const cycles = Number(process.env.PIIK_VOICE_CYCLES ?? 2);
const duration = Number(process.env.PIIK_VOICE_DURATION_SECONDS ?? 0);
const sfuOnly = process.env.PIIK_VOICE_SFU_ONLY === "true";
const probe = String.raw`(()=>{
  localStorage.setItem('piik:ui-lang','en');localStorage.setItem('piik:ui-mode','text');
  const pcs=[],sockets=[],streams=[],errors=[],sent=[],received=[];let authentications=0;
  const rendered=[],AC=AudioContext;
  window.AudioContext=class extends AC{createMediaStreamSource(stream){const source=super.createMediaStreamSource(stream),analyser=this.createAnalyser(),sink=this.createGain();sink.gain.value=0;source.connect(analyser);analyser.connect(sink);sink.connect(this.destination);rendered.push({track:stream.getAudioTracks()[0],analyser});return source;}};
  const PC=RTCPeerConnection,WS=WebSocket,getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.RTCPeerConnection=class extends PC{constructor(...args){super(...args);pcs.push(this);}};
  window.WebSocket=class extends WS{constructor(...args){super(...args);sockets.push(this);this.addEventListener('message',e=>{try{const m=JSON.parse(e.data);if(m.type==='authenticated')authentications++;received.push(m);if(received.length>120)received.shift();}catch{}});}send(raw){try{sent.push(JSON.parse(raw));if(sent.length>120)sent.shift();}catch{}super.send(raw);}};
  navigator.mediaDevices.getUserMedia=async options=>{const stream=await getMedia(options);streams.push(stream);return stream;};
  addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
  window.privateVoiceGate={pcs,sockets,streams,sent,received,errors,sample:async()=>{
    const inbound=[],outbound=[],sources=[],codecs=[];
    for(let i=0;i<pcs.length;i++){const pc=pcs[i];if(pc.connectionState==='closed')continue;const reports=await pc.getStats();reports.forEach(s=>{
      if(s.type==='inbound-rtp')inbound.push({pc:i,id:s.id,kind:s.kind,bytes:s.bytesReceived,samples:s.totalSamplesReceived,concealed:s.concealedSamples,codec:s.codecId,energy:s.totalAudioEnergy,frames:s.framesDecoded});
      if(s.type==='outbound-rtp')outbound.push({pc:i,id:s.id,kind:s.kind,bytes:s.bytesSent,packets:s.packetsSent});
      if(s.type==='media-source'&&s.kind==='audio')sources.push({level:s.audioLevel,energy:s.totalAudioEnergy});
      if(s.type==='codec'&&s.mimeType.includes('audio'))codecs.push({id:s.id,mime:s.mimeType,payload:s.payloadType,fmtp:s.sdpFmtpLine});
    });}
    const pcm=rendered.filter(r=>r.track.readyState==='live').map(r=>{const samples=new Float32Array(r.analyser.fftSize);r.analyser.getFloatTimeDomainData(samples);return {id:r.track.id,rms:Math.sqrt(samples.reduce((s,v)=>s+v*v,0)/samples.length)};});
    return{inbound,outbound,sources,codecs,pcm,authentications,audio:[...document.querySelectorAll('audio')].map(a=>({paused:a.paused,muted:a.muted,time:a.currentTime,ready:a.readyState})),states:pcs.map(p=>p.connectionState),liveMicrophones:streams.flatMap(s=>s.getAudioTracks()).filter(t=>t.readyState==='live'&&t.enabled).length,
      voice:document.querySelector('.lr-room-voice')?.textContent,buttons:[...document.querySelectorAll('button')].map(b=>({id:b.id,label:b.getAttribute('aria-label')||b.textContent,disabled:b.disabled})),
      overflow:document.documentElement.scrollWidth>innerWidth,errors,received:received.filter(m=>m.type.startsWith('voice-')).slice(-3)};
  }};
})();`;

function microphoneWav() {
  const rate = 48000,
    n = rate * 2,
    buffer = Buffer.alloc(44 + n * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buffer.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / rate)),
      44 + i * 2,
    );
  return buffer;
}
async function udpPort() {
  const socket = createSocket("udp4");
  return new Promise<number>((resolvePort, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolvePort(address.port));
    });
  });
}
type Sample = {
  authentications: number;
  inbound: Array<{
    pc: number;
    id: string;
    kind: string;
    bytes: number;
    samples?: number;
    energy?: number;
    frames?: number;
  }>;
  outbound: Array<{ kind: string; bytes: number }>;
  pcm: Array<{ id: string; rms: number }>;
  states: string[];
  liveMicrophones: number;
  voice: string;
  buttons: Array<{ id: string; label: string; disabled: boolean }>;
  overflow: boolean;
  errors: string[];
  received: unknown[];
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const [port, debugPort, mediaPort] = await Promise.all([
    reservePort(),
    reservePort(),
    udpPort(),
  ]);
  const origin = `http://127.0.0.1:${port}`,
    profile = await mkdtemp(join(tmpdir(), "piik-client-media-"));
  const audio = join(OUT, "microphone.wav");
  await writeFile(audio, microphoneWav());
  let cdp: CdpConnection | null = null,
    chrome: Awaited<ReturnType<typeof launchChrome>> | null = null,
    server: ReturnType<typeof spawn> | null = null;
  let serverLog = "";
  const pages: PageHandle[] = [];
  const checks: string[] = [];
  let stage = "start";
  const call = <T>(page: PageHandle, expression: string) =>
    evaluate<T>(cdp!, page, expression, Date.now() + 5000);
  const sample = (page: PageHandle) =>
    call<Sample>(page, "window.privateVoiceGate.sample()");
  const until = async (
    page: PageHandle,
    accept: (s: Sample) => boolean,
    label: string,
  ) => {
    stage = label;
    let last: Sample | undefined;
    try {
      await waitForSample(
        () => sample(page),
        (s) => {
          last = s;
          return accept(s);
        },
        25000,
        200,
      );
    } catch {
      throw Error(`${label}: ${JSON.stringify(last)}`);
    }
    return last!;
  };
  const click = async (page: PageHandle, selector: string) => {
    await waitForSample(
      () =>
        call<boolean>(
          page,
          `!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      Boolean,
      10000,
    );
    await call(
      page,
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  };
  const button = async (page: PageHandle, label: string) => {
    const selector = `button[aria-label=${JSON.stringify(label)}]`;
    await click(page, selector);
  };
  const check = (text: string) => {
    checks.push(text);
    console.log(text);
  };
  try {
    server = spawn(
      process.env.PIIK_SERVER_EXE ??
        join(ROOT, "build/go-check/piik-server.exe"),
      [],
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: "pipe",
        env: {
          ...process.env,
          PIIK_ENV: "development",
          LISTEN_HOST: "127.0.0.1",
          PORT: String(port),
          PUBLIC_BASE_URL: origin,
          ROOM_DATABASE_PATH: join(profile, "rooms.sqlite"),
          ROOM_VOICE_MAX_ROOMS: "1",
          MAX_VIEWERS_PER_ROOM: "3",
          SFU_UDP_PORT: String(mediaPort),
          SFU_LISTEN_HOST: "127.0.0.1",
          SFU_PUBLIC_IP: "127.0.0.1",
          SFU_ONLY: String(sfuOnly),
        },
      },
    );
    server.stdout?.resume();
    server.stderr?.on("data", (data: Buffer) => {
      serverLog = (serverLog + data.toString()).slice(-16000);
    });
    await waitForSample(
      (deadline) => fetchJsonBefore(`${origin}/healthz`, deadline),
      () => true,
      15000,
    );
    chrome = await launchChrome(
      process.env.CHROME_PATH ??
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      debugPort,
      profile,
      [
        "--headless=new",
        "--no-first-run",
        "--window-size=1280,900",
        "--allow-loopback-in-peer-connection",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        `--use-file-for-fake-audio-capture=${audio}`,
      ],
    );
    const version = await waitForVersion(debugPort, chrome);
    cdp = await CdpConnection.connect(
      version.webSocketDebuggerUrl,
      Date.now() + 10000,
    );
    const create = async (url: string, extra = "") => {
      const { browserContextId } = await cdp!.call<{
        browserContextId: string;
      }>("Target.createBrowserContext", {}, undefined, Date.now() + 5000);
      const page = await createPage(
        cdp!,
        url,
        probe + extra,
        true,
        browserContextId,
      );
      pages.push(page);
      return page;
    };
    stage = "create room";
    const response = await fetch(`${origin}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ codeEntryPolicy: "open" }),
    });
    if (!response.ok)
      throw Error(
        `Room creation failed: ${response.status} ${await response.text()}`,
      );
    const room = (await response.json()) as {
      roomId: string;
      hostToken: string;
      inviteUrl: string;
    };
    const host = await create(
      origin,
      `localStorage.setItem('piik:host-room:v1',${JSON.stringify(JSON.stringify(room))});`,
    );
    await until(
      host,
      (s) => s.buttons.some((b) => b.label === "Start sharing"),
      "restored Host room",
    );
    await button(host, "Start sharing");
    await button(host, "Camera");
    const picker = await until(
      host,
      (s) => s.buttons.some((b) => b.label?.startsWith("Share camera:")),
      "camera picker",
    );
    const camera = picker.buttons.find((b) =>
      b.label?.startsWith("Share camera:"),
    )!;
    await button(host, camera.label);
    await until(
      host,
      (s) => s.buttons.some((b) => b.id === "voice-join" && !b.disabled),
      "camera share",
    );
    for (let i = 0; i < 3; i++) {
      const viewer = await create(room.inviteUrl);
      await until(
        viewer,
        (s) => s.buttons.some((b) => b.id === "voice-join" && !b.disabled),
        `viewer ${i + 1} admitted`,
      );
    }
    for (const page of pages) await click(page, "#voice-join");
    for (let i = 0; i < pages.length; i++)
      await until(
        pages[i]!,
        (s) => s.voice.includes("Connected") && !s.voice.includes("could not"),
        `voice ${i + 1} connected`,
      );
    for (const page of pages) {
      if ((await sample(page)).liveMicrophones !== 0)
        throw Error("Joining voice captured a microphone");
    }
    check(
      "four authenticated participants join muted while camera sharing continues",
    );
    await click(host, 'button[aria-label="Turn on microphone"]');
    for (const viewer of pages.slice(1))
      await click(viewer, "#voice-microphone");
    for (let i = 0; i < pages.length; i++)
      await until(
        pages[i]!,
        (s) =>
          s.inbound.filter((r) => r.kind === "audio" && (r.samples ?? 0) > 0)
            .length >= 3 && s.pcm.filter((r) => r.rms > 0.00001).length >= 3,
        `three decoded remote voices at participant ${i + 1}`,
      );
    check(
      "four simultaneous microphone publications, each receiver decodes three remote voices",
    );
    for (const viewer of pages.slice(1))
      await until(
        viewer,
        (s) => s.inbound.some((r) => r.kind === "video" && (r.frames ?? 0) > 0),
        "camera video decoded alongside voice",
      );
    check("camera picture and duplex audio operate concurrently");
    const participant = pages[1]!;
    for (let i = 0; i < cycles; i++) {
      await click(participant, "#voice-leave");
      await until(
        participant,
        (s) =>
          s.liveMicrophones === 0 &&
          s.buttons.some((b) => b.id === "voice-join"),
        "voice retirement",
      );
      await click(participant, "#voice-join");
      await until(
        participant,
        (s) => s.voice.includes("Connected"),
        "voice rejoin",
      );
      await click(participant, "#voice-microphone");
      for (const page of pages)
        await until(
          page,
          (s) => s.pcm.filter((r) => r.rms > 0.00001).length >= 3,
          "all three remote voices restored after rejoin",
        );
      for (const page of pages)
        if (
          (await call<number>(
            page,
            "document.querySelectorAll('audio').length",
          )) > 3
        )
          throw Error("Retired audio elements accumulated");
    }
    check(
      `${cycles} join/leave cycles stop old microphone tracks and restore the member`,
    );
    const authenticationCount = (await sample(host)).authentications;
    const priorFrames = await Promise.all(
      pages
        .slice(1)
        .map(async (page) =>
          (await sample(page)).inbound
            .filter((r) => r.kind === "video")
            .reduce((sum, r) => sum + (r.frames ?? 0), 0),
        ),
    );
    await call(
      host,
      'window.privateVoiceGate.sockets.filter(s=>s.url.includes("/signal")).at(-1).close()',
    );
    await until(
      host,
      (s) =>
        s.voice.includes("Connected") &&
        s.authentications > authenticationCount,
      "signaling recovery",
    );
    check("room signaling recovery retains call admission");
    for (let i = 1; i < pages.length; i++)
      await until(
        pages[i]!,
        (s) =>
          s.inbound
            .filter((r) => r.kind === "video")
            .reduce((sum, r) => sum + (r.frames ?? 0), 0) >
          priorFrames[i - 1]! + 5,
        "camera resumes after fresh authentication",
      );
    check("camera delivery continues after fresh Host authentication");
    await button(host, "Pause sharing");
    for (const page of pages)
      await until(
        page,
        (s) => s.pcm.filter((r) => r.rms > 0.00001).length >= 3,
        "voice retained while picture paused",
      );
    await button(host, "Resume sharing");
    await click(host, "#host-stop-share");
    await until(
      host,
      (s) =>
        s.buttons.some((b) => b.id === "voice-microphone") &&
        s.voice.includes("Connected"),
      "voice retained after camera stops",
    );
    for (const page of pages)
      await until(
        page,
        (s) => s.pcm.filter((r) => r.rms > 0.00001).length >= 3,
        "voice independent of source retirement",
      );
    await button(host, "Start sharing");
    await button(host, "Camera");
    const again = await until(
      host,
      (s) => s.buttons.some((b) => b.label?.startsWith("Share camera:")),
      "camera restart picker",
    );
    await button(
      host,
      again.buttons.find((b) => b.label?.startsWith("Share camera:"))!.label,
    );
    for (const viewer of pages.slice(1))
      await until(
        viewer,
        (s) => s.inbound.some((r) => r.kind === "video" && (r.frames ?? 0) > 5),
        "picture restarts alongside existing room voice",
      );
    check("pausing, stopping and restarting camera do not retire the call");
    await cdp.call(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      pages[2]!.sessionId,
      Date.now() + 5000,
    );
    await until(pages[2]!, (s) => !s.overflow, "mobile voice control layout");
    check("voice controls fit a 390px mobile viewport");
    if (duration > 0) {
      stage = "endurance";
      const end = Date.now() + duration * 1000;
      while (Date.now() < end) {
        await waitForSample(
          () => sample(host),
          (s) =>
            s.inbound.filter((r) => r.kind === "audio" && (r.samples ?? 0) > 0)
              .length >= 3 && s.pcm.filter((r) => r.rms > 0.00001).length >= 3,
          10000,
          1000,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, Math.min(10000, end - Date.now())),
        );
      }
      check(`${duration}s continuous four-person camera and voice session`);
    }
    for (let i = 0; i < pages.length; i++) {
      const state = await sample(pages[i]!);
      if (state.errors.length)
        throw Error(`Unhandled browser errors: ${state.errors}`);
      const shot = await cdp.call<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true },
        pages[i]!.sessionId,
        Date.now() + 5000,
      );
      await writeFile(
        join(OUT, `participant-${i}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
    await writeFile(
      join(OUT, "result.json"),
      JSON.stringify(
        {
          passed: true,
          sfuOnly,
          checks,
          samples: await Promise.all(pages.map(sample)),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(OUT, "result.json"),
      JSON.stringify(
        { passed: false, stage, checks, error: String(error), serverLog },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    const cleanup = await cleanupRun({
      cdp,
      chrome,
      native: null,
      server: server as Parameters<typeof cleanupRun>[0]["server"],
      profile,
      ports: [port, debugPort],
    });
    console.log(JSON.stringify({ cleanup }));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
