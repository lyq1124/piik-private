import { useState, useSyncExternalStore } from "react";
import { RoomVoiceSession, EMPTY_ROOM_VOICE } from "./session";
import { useCopy, type CopyKey } from "../ui/copy";
import { Btn } from "../components/living/primitives";
import { MicrophoneDeviceSelect } from "../components/living/MicrophoneDeviceSelect";
import { browserCaptureDevices } from "../media/capture-devices";
import "./room-voice.css";
import { labelPresence } from "../lib/viewer-presence";

const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY_ROOM_VOICE;
const microphoneDevices = () => browserCaptureDevices("audioinput");
export const useRoomVoiceSnapshot = (session: RoomVoiceSession | null) =>
  useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
  );

export function RoomVoicePanel({
  session,
  beforeJoin,
  showMicrophone = true,
}: {
  session: RoomVoiceSession | null;
  beforeJoin?: () => Promise<void>;
  showMicrophone?: boolean;
}) {
  const state = useRoomVoiceSnapshot(session);
  const { t, vis } = useCopy();
  const [settings, setSettings] = useState(false);
  if (!session) return null;
  const error: CopyKey | null = state.error
    ? `voice.error.${state.error}`
    : null;
  const participants = labelPresence(
    state.participants.map((person) => ({
      ...person,
      displayName: person.name,
    })),
  );
  return (
    <section className="lr-room-voice" aria-label={t("voice.title")}>
      <div className="lr-room-voice-controls">
        <span className="lr-room-voice-label">{t("voice.title")}</span>
        {!state.joined ? (
          <Btn
            id="voice-join"
            icon="microphone"
            cap="voice.join"
            title="voice.join"
            disabled={!state.online}
            onClick={() => void session.join(beforeJoin)}
          />
        ) : (
          <>
            {showMicrophone && (
              <Btn
                id="voice-microphone"
                icon={state.muted ? "microphoneOff" : "microphone"}
                cap={state.muted ? "voice.unmute" : "voice.mute"}
                title={state.muted ? "voice.unmute" : "voice.mute"}
                disabled={state.pending || state.status !== "connected"}
                busy={state.pending}
                pressed={!state.muted}
                onClick={() => void session.setMicrophone(state.muted)}
              />
            )}
            <Btn
              icon="speaker"
              cap="voice.settings"
              title="voice.settings"
              pressed={settings}
              expanded={settings}
              onClick={() => setSettings(!settings)}
            />
            <Btn
              id="voice-leave"
              icon="stop"
              cap="voice.leave"
              title="voice.leave"
              onClick={() => session.leave()}
            />
            <span className="lr-room-voice-status" role="status">
              {t(`voice.status.${state.status}` as CopyKey)}
            </span>
          </>
        )}
        {state.playbackBlocked && state.joined && (
          <Btn
            icon="speaker"
            cap="voice.resume"
            title="voice.resume"
            onClick={() => void session.resume().catch(() => {})}
          />
        )}
      </div>
      {state.joined && settings && (
        <div className="lr-room-voice-settings">
          <MicrophoneDeviceSelect
            value={state.deviceId}
            load={microphoneDevices}
            onChange={(device) => void session.setDevice(device)}
            browser
            disabled={state.pending}
            revision={!state.muted}
          />
          <label>
            {t("voice.volume")}
            <input
              aria-label={t("voice.volume")}
              type="range"
              min="0"
              max="100"
              value={Math.round(state.volume * 100)}
              onChange={(e) => session.setVolume(Number(e.target.value) / 100)}
            />
            <output>{Math.round(state.volume * 100)}%</output>
          </label>
        </div>
      )}
      {state.joined && !vis && (
        <div className="lr-room-voice-people">
          {participants.map((person) => (
            <span key={person.peerId}>
              {person.label} ·{" "}
              {t(person.muted ? "voice.muted" : "voice.microphoneOn")}
            </span>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="lr-room-voice-error">
          {t(error)}
        </p>
      )}
      {!state.joined && !vis && !error && <small>{t("voice.hint")}</small>}
    </section>
  );
}
