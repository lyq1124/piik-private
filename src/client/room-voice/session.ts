import type {
  ClientMessage,
  IceConfig,
  ServerMessage,
  VoiceDescription,
} from "../../shared/protocol";
import { audioInputConstraints } from "../media/audio-capture";
import { waitForConnectionOperation } from "../webrtc/connection-operation";

type VoiceState = Extract<ServerMessage, { type: "voice-state" }>;
export interface RoomVoiceSnapshot {
  online: boolean;
  joined: boolean;
  muted: boolean;
  pending: boolean;
  status: "idle" | "connecting" | "connected" | "reconnecting";
  participants: VoiceState["participants"];
  deviceId: string;
  volume: number;
  error:
    | Extract<ServerMessage, { type: "voice-error" }>["code"]
    | "offline"
    | "microphone-denied"
    | "microphone-unavailable"
    | "source-audio"
    | null;
  playbackBlocked: boolean;
}
export const EMPTY_ROOM_VOICE: RoomVoiceSnapshot = {
  online: false,
  joined: false,
  muted: true,
  pending: false,
  status: "idle",
  participants: [],
  deviceId: "",
  volume: 1,
  error: null,
  playbackBlocked: false,
};

// One owner per authenticated room. Camera/source lifetimes borrow none of
// these resources, so picture changes cannot retire a call.
export class RoomVoiceSession {
  private state: RoomVoiceSnapshot = { ...EMPTY_ROOM_VOICE };
  private listeners = new Set<() => void>();
  private peerId: string | null = null;
  private connectionId: string | null = null;
  private connection: RTCPeerConnection | null = null;
  private lifetime: AbortController | null = null;
  private ice: IceConfig = { iceServers: [] };
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sources = new Map<
    string,
    { source: MediaStreamAudioSourceNode; audio: HTMLAudioElement }
  >();
  private microphone: MediaStream | null = null;
  private capturedDevice = "";
  private uplink: RTCRtpSender | null = null;
  private candidates: RTCIceCandidateInit[] = [];
  private descriptions: Promise<void> = Promise.resolve();
  private operation = 0;
  private recoveries = 0;
  private recoveryPending = false;
  private closed = false;

  constructor(private readonly send: (message: ClientMessage) => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<RoomVoiceSnapshot>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  authenticated(peerId: string, ice: IceConfig) {
    if (this.closed) return;
    this.peerId = peerId;
    this.ice = ice;
    this.update({ online: true });
    if (this.state.joined)
      this.send({
        type: "voice-command",
        action: "join",
        ...(this.connectionId ? { connectionId: this.connectionId } : {}),
      });
  }
  disconnected() {
    this.update({ online: false });
  }

  async join(beforeJoin?: () => Promise<void>): Promise<void> {
    if (this.closed || this.state.joined) return;
    if (!this.state.online) {
      this.update({ error: "offline" });
      return;
    }
    const operation = ++this.operation;
    this.update({ joined: true, status: "connecting", error: null });
    try {
      await this.resume();
      await beforeJoin?.();
      if (this.closed || operation !== this.operation || !this.state.joined)
        return;
      if (!this.send({ type: "voice-command", action: "join" }))
        throw new Error("offline");
    } catch (error) {
      if (this.closed || operation !== this.operation) return;
      this.leave();
      this.update({
        error:
          error instanceof Error && error.message === "source-audio"
            ? "source-audio"
            : "connection-failed",
      });
    }
  }

  leave() {
    ++this.operation;
    if (this.connectionId)
      this.send({
        type: "voice-command",
        action: "leave",
        connectionId: this.connectionId,
      });
    this.retireConnection();
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.microphone = null;
    this.gain?.disconnect();
    this.gain = null;
    const context = this.context;
    this.context = null;
    void context?.close().catch(() => {});
    this.recoveries = 0;
    this.recoveryPending = false;
    this.update({
      joined: false,
      muted: true,
      pending: false,
      status: "idle",
      participants: [],
      playbackBlocked: false,
    });
  }
  close() {
    this.leave();
    this.closed = true;
    this.listeners.clear();
  }

  async resume() {
    if (this.closed) return;
    if (!this.context) {
      const context = (this.context = new AudioContext());
      this.gain = this.context.createGain();
      this.gain.gain.value = this.state.volume;
      this.gain.connect(this.context.destination);
      context.addEventListener("statechange", () => {
        if (this.context === context)
          this.update({ playbackBlocked: context.state !== "running" });
      });
    }
    const context = this.context;
    await context.resume();
    if (this.context !== context) return;
    await Promise.all(
      [...this.sources.values()].map(async ({ audio }) => {
        await audio.play();
      }),
    );
    if (this.context === context)
      this.update({ playbackBlocked: context.state !== "running" });
  }
  setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = volume;
    this.update({ volume });
  }
  async setDevice(deviceId: string) {
    if (this.state.muted) {
      this.update({ deviceId });
      return;
    }
    await this.setMicrophone(true, deviceId);
  }
  async setMicrophone(enabled: boolean, deviceId = this.state.deviceId) {
    if (!this.state.joined || this.closed) return;
    const operation = ++this.operation;
    if (!enabled) {
      this.microphone?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      this.update({ muted: true, pending: false, error: null });
      if (this.connectionId)
        this.send({
          type: "voice-command",
          action: "mute",
          connectionId: this.connectionId,
          muted: true,
        });
      return;
    }
    this.update({ pending: true, error: null });
    let acquired: MediaStream | null = null;
    try {
      void this.resume().catch(() => this.update({ playbackBlocked: true }));
      let track = this.microphone?.getAudioTracks()[0];
      if (
        !track ||
        track.readyState !== "live" ||
        deviceId !== this.capturedDevice
      ) {
        acquired = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            ...audioInputConstraints(true),
            channelCount: { ideal: 1 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
        if (this.closed || operation !== this.operation || !this.state.joined)
          return;
        track = acquired.getAudioTracks()[0];
        if (!track || track.readyState !== "live")
          throw new Error("microphone-unavailable");
      }
      const connection = this.connection,
        lifetime = this.lifetime;
      if (!connection || !lifetime || !this.uplink) throw new Error("offline");
      track.enabled = true;
      track.contentHint = "speech";
      await waitForConnectionOperation(lifetime.signal, () =>
        this.uplink!.replaceTrack(track!),
      );
      if (
        this.closed ||
        operation !== this.operation ||
        this.connection !== connection
      )
        return;
      if (acquired) {
        this.microphone?.getTracks().forEach((old) => old.stop());
        this.microphone = acquired;
        acquired = null;
        this.capturedDevice = deviceId;
      }
      track.onended = () => {
        if (this.microphone?.getAudioTracks()[0] === track) {
          void this.setMicrophone(false);
          this.update({ error: "microphone-unavailable" });
        }
      };
      await this.configureSender(this.uplink);
      if (
        this.closed ||
        operation !== this.operation ||
        this.connection !== connection
      )
        return;
      this.update({ muted: false, pending: false, deviceId });
      if (
        this.connectionId &&
        !this.send({
          type: "voice-command",
          action: "mute",
          connectionId: this.connectionId,
          muted: false,
        })
      )
        void this.setMicrophone(false);
    } catch (error) {
      if (!this.closed && operation === this.operation) {
        this.microphone?.getAudioTracks().forEach((track) => {
          track.enabled = !this.state.muted;
        });
        this.update({
          pending: false,
          error:
            error instanceof DOMException && error.name === "NotAllowedError"
              ? "microphone-denied"
              : "microphone-unavailable",
        });
      }
    } finally {
      acquired?.getTracks().forEach((track) => track.stop());
    }
  }

  receive(message: ServerMessage): boolean {
    if (
      message.type !== "voice-state" &&
      message.type !== "voice-signal" &&
      message.type !== "voice-error"
    )
      return false;
    if (this.closed || !this.state.joined) return true;
    if (message.type === "voice-error") {
      this.leave();
      this.update({ error: message.code });
      return true;
    }
    if (message.type === "voice-state") {
      if (message.peerId !== this.peerId) return true;
      if (this.connectionId !== message.connectionId)
        this.createConnection(message.connectionId);
      this.update({ participants: message.participants });
      return true;
    }
    const connection = this.connection,
      lifetime = this.lifetime;
    if (!connection || !lifetime || message.connectionId !== this.connectionId)
      return true;
    if (message.description) {
      const description = message.description;
      this.descriptions = this.descriptions
        .then(() => this.acceptOffer(connection, lifetime, description))
        .catch(() => {
          if (this.connection === connection && !lifetime.signal.aborted)
            this.requestRecovery();
        });
    } else if (message.candidate) {
      if (connection.remoteDescription) {
        void connection.addIceCandidate(message.candidate).catch(() => {
          if (this.connection === connection) this.requestRecovery();
        });
      } else if (this.candidates.length < 64)
        this.candidates.push(message.candidate);
      else this.requestRecovery();
    }
    return true;
  }

  private createConnection(id: string) {
    this.retireConnection();
    this.connectionId = id;
    const connection = (this.connection = new RTCPeerConnection({
      iceServers: this.ice.iceServers,
    }));
    const lifetime = (this.lifetime = new AbortController());
    this.update({ status: this.recoveries ? "reconnecting" : "connecting" });
    connection.onicecandidate = (event) => {
      if (this.connection === connection && event.candidate)
        this.send({
          type: "voice-signal",
          connectionId: id,
          candidate: {
            ...event.candidate.toJSON(),
            candidate: event.candidate.candidate,
          },
        });
    };
    connection.onconnectionstatechange = () => {
      if (this.connection !== connection) return;
      if (connection.connectionState === "connected") {
        this.recoveries = 0;
        this.recoveryPending = false;
        this.update({ status: "connected", error: null });
        this.send({
          type: "voice-command",
          action: "mute",
          connectionId: id,
          muted: this.state.muted,
        });
      } else if (connection.connectionState === "failed")
        this.requestRecovery();
      else if (connection.connectionState === "disconnected")
        this.update({ status: "reconnecting" });
    };
    connection.ontrack = (event) => {
      if (
        this.connection !== connection ||
        event.track.kind !== "audio" ||
        !this.context ||
        !this.gain
      )
        return;
      if (this.sources.has(event.track.id)) return;
      const stream = new MediaStream([event.track]);
      // Chromium needs a playing media element to pull remote WebRTC audio
      // into Web Audio. Mute this sink; only the gain graph is audible.
      // https://issues.chromium.org/issues/40094084
      const audio = new Audio();
      audio.autoplay = true;
      audio.muted = true;
      audio.hidden = true;
      audio.srcObject = stream;
      document.body.append(audio);
      void audio.play().catch(() => {
        if (this.connection === connection)
          this.update({ playbackBlocked: true });
      });
      const source = this.context.createMediaStreamSource(stream);
      source.connect(this.gain);
      this.sources.set(event.track.id, { source, audio });
      event.track.addEventListener(
        "ended",
        () => {
          source.disconnect();
          audio.pause();
          audio.srcObject = null;
          audio.remove();
          if (this.sources.get(event.track.id)?.source === source)
            this.sources.delete(event.track.id);
        },
        { once: true },
      );
    };
    lifetime.signal.addEventListener("abort", () => connection.close(), {
      once: true,
    });
  }

  private async acceptOffer(
    connection: RTCPeerConnection,
    lifetime: AbortController,
    description: VoiceDescription,
  ) {
    if (this.connection !== connection || lifetime.signal.aborted) return;
    if (description.sdp.type !== "offer")
      throw new Error("Unexpected voice answer");
    await waitForConnectionOperation(lifetime.signal, () =>
      connection.setRemoteDescription(description.sdp),
    );
    const own = this.state.participants.find(
      (person) => person.peerId === this.peerId,
    );
    const tracks: VoiceDescription["tracks"] = [];
    for (const transceiver of connection.getTransceivers()) {
      const mapping = description.tracks.find(
        (track) => track.mid === transceiver.mid,
      );
      if (mapping && mapping.publicationId === own?.publicationId) {
        transceiver.direction = "sendonly";
        this.uplink = transceiver.sender;
        await waitForConnectionOperation(lifetime.signal, () =>
          transceiver.sender.replaceTrack(
            this.microphone?.getAudioTracks()[0] ?? null,
          ),
        );
        tracks.push(mapping);
      } else {
        transceiver.direction = mapping ? "recvonly" : "inactive";
      }
    }
    for (const candidate of this.candidates.splice(0))
      await waitForConnectionOperation(lifetime.signal, () =>
        connection.addIceCandidate(candidate),
      );
    const answer = await waitForConnectionOperation(lifetime.signal, () =>
      connection.createAnswer(),
    );
    await waitForConnectionOperation(lifetime.signal, () =>
      connection.setLocalDescription(answer),
    );
    if (this.connection !== connection || !this.connectionId) return;
    if (this.uplink) await this.configureSender(this.uplink);
    if (
      this.connection !== connection ||
      !this.connectionId ||
      lifetime.signal.aborted
    )
      return;
    this.send({
      type: "voice-signal",
      connectionId: this.connectionId,
      description: {
        revision: description.revision,
        sdp: { type: "answer", sdp: connection.localDescription!.sdp },
        tracks,
      },
    });
  }
  private async configureSender(sender: RTCRtpSender) {
    const parameters = sender.getParameters();
    if (parameters.encodings?.length) {
      parameters.encodings[0]!.maxBitrate = 32_000;
      await sender.setParameters(parameters);
    }
  }
  private requestRecovery() {
    if (this.recoveryPending || !this.state.online || !this.connectionId)
      return;
    if (++this.recoveries > 2) {
      this.leave();
      this.update({ error: "connection-failed" });
      return;
    }
    this.recoveryPending = true;
    this.update({ status: "reconnecting" });
    this.send({
      type: "voice-command",
      action: "recover",
      connectionId: this.connectionId,
    });
  }
  private retireConnection() {
    const lifetime = this.lifetime;
    this.lifetime = null;
    this.connection = null;
    this.connectionId = null;
    this.uplink = null;
    this.candidates = [];
    this.descriptions = Promise.resolve();
    lifetime?.abort();
    this.sources.forEach(({ source, audio }) => {
      source.disconnect();
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    });
    this.sources.clear();
  }
}
