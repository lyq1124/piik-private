// Microphone echo cancellation cannot remove room playback captured directly
// as system sound. Prove own-audio restriction or use scoped App capture.
export async function requireVoiceSafeSource(
  stream: MediaStream,
): Promise<void> {
  if (stream.getVideoTracks()[0]?.getSettings().displaySurface === "browser")
    return;
  for (const track of stream.getAudioTracks()) {
    const supported =
      navigator.mediaDevices.getSupportedConstraints() as MediaTrackSupportedConstraints & {
        restrictOwnAudio?: boolean;
      };
    if (supported.restrictOwnAudio) {
      await track.applyConstraints({
        restrictOwnAudio: true,
      } as MediaTrackConstraints);
      const settings = track.getSettings() as MediaTrackSettings & {
        restrictOwnAudio?: boolean;
      };
      if (settings.restrictOwnAudio === true) continue;
    }
    throw new Error("source-audio");
  }
}
