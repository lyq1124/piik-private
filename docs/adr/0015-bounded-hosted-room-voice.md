# ADR-0015: Bounded Hosted room voice

Accepted for the private deployment, 2026-10-24.

## Decision

Add optional room voice to the existing Hosted Go process. Each voice member
owns one audio-only WebRTC connection to the embedded media service. The service
forwards that member's Opus publication to the other admitted voice members,
excluding the source. The Browser owns capture, speech processing and playback.
No audio decoding, mixing, recording or transcoding runs on the server.

Picture and source sound keep ADR-0005's existing controller. Voice does not
change the picture graph or add P2P probes, relay selection, TURN or an external
conference service. A room policy that forbids server media also forbids voice.
Stopping or replacing a picture does not end an admitted room call.

`ROOM_VOICE_MAX_ROOMS=0` disables the capability by default. The private site
uses `1` and its existing `MAX_VIEWERS_PER_ROOM=3`. The store's room admission
also bounds voice membership. An opted-in authenticated session is the authority;
connections and pending negotiation have independent freshness identities.
Signaling recovery retains healthy media for the existing disconnect grace.

## Reuse and limits

The Pion audio transport and its original integration tests are reused from
upstream commit `63fb1919`, with upstream authorship retained. Only its standalone
audio adapter is imported; the subsequent room-tree, LAN and UI changes are not
required. The adapter shares the application's existing UDP mux and teardown.

One reserved upstream audio section lets a muted member start speaking without
rebuilding transport. Membership changes serialize SDP; microphone mute changes
the server's RTP permission without renegotiation. Reused output slots project a
replacement publication's sequence/timestamp origin onto the existing SSRC so
SRTP replay protection and the receiver's clock do not reject the new source.
Within one source, loss, reordering and timestamp gaps remain unchanged.

Voice requests mono speech at 32 kbit/s. Four speakers produce twelve forwarded
copies, about 384 kbit/s encoded outbound payload; network overhead and recovery
still require measurement. This is a small-room operating plan, not a claim of
capacity for every server or device.

## Capture and compatibility

Before a Host joins voice, release commentary capture, including pending device
permission results, while retaining source sound and video. The native App's
existing microphone command disables commentary before Browser voice capture.
Source sound must exclude the call's playback. Scoped tab/application capture,
verified own-audio restriction or existing native process exclusion provides
that boundary; unsupported full-system combinations produce actionable feedback.

The runtime capability descriptor is additive. New messages are sent only to
explicit voice members; the existing v24 picture messages and SQLite schema 2
are unchanged. Existing App capture remains usable, with Browser voice capture
at the Site. Pure Local App rooms do not gain an unconfigured media listener.

## Evidence

The private voice gate uses isolated Browser contexts, synthetic camera and
microphone devices, decoded receive samples and nonzero Web Audio PCM. It checks
four speakers, source lifetime separation, reauthentication, bounded join/leave
and mobile layout. Device-specific echo, browser permissions, smart-glasses
hardware and public networks require their own actual-device evidence.

Primary implementation references:

- [Pion multi-party RTP forwarding](https://github.com/pion/example-webrtc-applications/tree/main/sfu-ws).
- [Opus payload and speech bitrate](https://www.rfc-editor.org/rfc/rfc7587.html#section-3.1.1).
- [WebRTC remote stream playback](https://webrtc.org/getting-started/remote-streams).
- [Chromium remote audio/Web Audio sink boundary](https://issues.chromium.org/issues/40094084).
