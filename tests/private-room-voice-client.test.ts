import { afterEach, expect, test, vi } from "vitest";
import { RoomVoiceSession } from "../src/client/room-voice/session";
import { requireVoiceSafeSource } from "../src/client/room-voice/source-audio";
import { HostAudio } from "../src/client/media/host-audio";

class Track {
  kind = "audio";
  enabled = true;
  readyState = "live";
  contentHint = "";
  onended: (() => void) | null = null;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings = () => ({});
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
class Context {
  state = "running";
  destination = {};
  currentTime = 0;
  createGain() {
    return {
      gain: { value: 1, setTargetAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createMediaStreamDestination() {
    return { stream: new Stream([new Track()]) };
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  addEventListener() {}
}
class Peer {
  connectionState = "connected";
  remoteDescription: unknown = null;
  localDescription = { sdp: "answer", type: "answer" };
  onicecandidate: unknown;
  ontrack: unknown;
  onconnectionstatechange: unknown;
  sender = {
    replaceTrack: vi.fn(async () => {}),
    getParameters: () => ({ encodings: [{}] }),
    setParameters: vi.fn(async () => {}),
  };
  transceiver = { mid: "0", direction: "sendonly", sender: this.sender };
  setRemoteDescription = vi.fn(async (v: unknown) => {
    this.remoteDescription = v;
  });
  getTransceivers = () => [this.transceiver];
  addIceCandidate = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer" }));
  setLocalDescription = vi.fn(async () => {
    if (typeof this.onconnectionstatechange === "function")
      this.onconnectionstatechange();
  });
  close = vi.fn();
}
function setup() {
  const peers: Peer[] = [];
  const getUserMedia = vi.fn();
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends Peer {
      constructor() {
        super();
        peers.push(this);
      }
    },
  );
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia, getSupportedConstraints: () => ({}) },
  });
  const sent: unknown[] = [];
  const voice = new RoomVoiceSession((message) => {
    sent.push(message);
    return true;
  });
  voice.authenticated("host_peer_12345678", { iceServers: [] });
  return { voice, sent, getUserMedia, peers };
}
async function connect(voice: RoomVoiceSession) {
  await voice.join();
  voice.receive({
    type: "voice-state",
    peerId: "host_peer_12345678",
    connectionId: "connection_12345678",
    participants: [
      {
        peerId: "host_peer_12345678",
        publicationId: "publication_12345678",
        name: "Host",
        muted: true,
      },
    ],
  });
  voice.receive({
    type: "voice-signal",
    connectionId: "connection_12345678",
    description: {
      revision: 1,
      sdp: { type: "offer", sdp: "offer" },
      tracks: [{ mid: "0", publicationId: "publication_12345678" }],
    },
  });
  await vi.waitFor(() => expect(voice.getSnapshot().status).toBe("connected"));
}
afterEach(() => vi.unstubAllGlobals());

test("joining is listen-only and microphone denial leaves room playback admitted", async () => {
  const { voice, getUserMedia, sent } = setup();
  await connect(voice);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(sent).toContainEqual({ type: "voice-command", action: "join" });
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await voice.setMicrophone(true);
  expect(voice.getSnapshot()).toMatchObject({
    joined: true,
    muted: true,
    pending: false,
    error: "microphone-denied",
  });
  voice.close();
});
test("leaving during microphone permission discards and stops the late input", async () => {
  const { voice, getUserMedia } = setup();
  await connect(voice);
  let resolve!: (stream: Stream) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const opening = voice.setMicrophone(true);
  voice.leave();
  const track = new Track();
  resolve(new Stream([track]));
  await opening;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(voice.getSnapshot().joined).toBe(false);
});
test("signaling recovery retains a healthy audio transport and capture; retirement closes them", async () => {
  const { voice, getUserMedia, peers } = setup();
  await connect(voice);
  const track = new Track();
  getUserMedia.mockResolvedValue(new Stream([track]));
  await voice.setMicrophone(true);
  voice.disconnected();
  voice.authenticated("host_peer_12345678", { iceServers: [] });
  expect(peers).toHaveLength(1);
  expect(track.stop).not.toHaveBeenCalled();
  expect(voice.getSnapshot()).toMatchObject({
    joined: true,
    muted: false,
    online: true,
  });
  voice.receive({ type: "voice-error", code: "forbidden" });
  expect(peers[0]!.close).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
});
test("source audio refuses unproven system loopback but accepts excluded tab capture", async () => {
  setup();
  const audio = new Track(),
    video = new Track();
  video.kind = "video";
  const stream = new Stream([audio, video]) as unknown as MediaStream;
  await expect(requireVoiceSafeSource(stream)).rejects.toThrow("source-audio");
  video.getSettings = () => ({ displaySurface: "browser" });
  await expect(requireVoiceSafeSource(stream)).resolves.toBeUndefined();
});
test("taking the microphone from commentary invalidates a pending legacy permission result", async () => {
  const { getUserMedia } = setup();
  let resolve!: (stream: Stream) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const host = new HostAudio(new Stream([]) as unknown as MediaStream, vi.fn());
  const opening = host.setMicrophone(true, "");
  host.releaseMicrophone();
  const track = new Track();
  resolve(new Stream([track]));
  await opening;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(host.audioAvailable).toBe(false);
  host.dispose();
});
