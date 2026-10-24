import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useSurfaceDocument } from "../ui/panel-window";
import { useCopy } from "../ui/copy";
import { Glyph } from "../ui/icons";
import type { RoomVoiceView } from "./RoomVoicePanel";

/** The admitted room session survives reconnects; its two explicit choices do too. */
export function RoomVoiceOnboarding({ session }: { session: RoomVoiceView }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const owner = useSurfaceDocument();
  const { t } = useCopy();
  const dialog = useRef<HTMLDialogElement>(null);
  const seen = useRef({ join: false, microphone: false });
  const [prompt, setPrompt] = useState<"join" | "microphone" | null>(null);
  const joined = Boolean(state.room?.members.some(member => member.peerId === state.peerId && member.joined));

  useEffect(() => {
    if (!state.channelControl || !state.connected || !state.room?.enabled) {
      setPrompt(null); return;
    }
    if (joined && !seen.current.microphone) {
      seen.current.join = seen.current.microphone = true;
      if (!state.microphone && !state.capturePending) setPrompt("microphone");
    } else if (!joined && !seen.current.join) {
      seen.current.join = true; setPrompt("join");
    } else if (!joined && prompt === "microphone") setPrompt(null);
  }, [state.channelControl, state.connected, state.room?.enabled, joined, state.microphone, state.capturePending, prompt]);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node || !prompt) return;
    const previous = node.ownerDocument.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [prompt, owner]);

  if (!owner || !state.channelControl) return null;
  const microphone = prompt === "microphone";
  const dismiss = () => {
    setPrompt(null);
  };
  return createPortal(<dialog ref={dialog} className="lr-voice-onboarding" aria-label={t(microphone ? "voice.askMicrophone" : "voice.askJoin")}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClose={event => { if (!event.currentTarget.open) setPrompt(null); }}>
    <header><Glyph name={microphone ? "microphone" : "headphones"} size={24} />
      <h2>{t(microphone ? "voice.askMicrophone" : "voice.askJoin")}</h2>
      <button type="button" className="lr-btn is-dense is-quiet" aria-label={t("common.close")} onClick={dismiss}><Glyph name="x" size={18} /></button>
    </header>
    <p>{t(microphone ? "voice.askMicrophoneHint" : "voice.askJoinHint")}</p>
    {state.role === "host" && !microphone && <p className="lr-voice-onboarding-note">{t("voice.relayOnly")}</p>}
    <footer>
      <button type="button" className="lr-btn" autoFocus onClick={dismiss}>{t(microphone ? "voice.notNowMicrophone" : "voice.notNowJoin")}</button>
      <button type="button" className="lr-btn is-primary" onClick={() => {
        setPrompt(null);
        if (microphone) void session.startMicrophone();
        else { session.resumeAudio(); session.command({ action: "join" }); }
      }}>{t(microphone ? "voice.microphoneOn" : "voice.join")}</button>
    </footer>
  </dialog>, owner.body);
}
