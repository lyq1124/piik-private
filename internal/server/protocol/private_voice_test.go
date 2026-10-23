package protocol

import "testing"

func TestRoomVoiceMessagesAreBoundedAndDoNotRelaxPictureMessages(t *testing.T) {
	for _, body := range []string{
		`{"type":"voice-command","action":"join"}`,
		`{"type":"voice-command","action":"mute","connectionId":"voice_connection_1234","muted":true}`,
		`{"type":"voice-signal","connectionId":"voice_connection_1234","candidate":{"candidate":""}}`,
	} {
		if _, err := DecodeClientMessage([]byte(body)); err != nil {
			t.Errorf("valid voice message rejected: %v", err)
		}
	}
	for _, body := range []string{
		`{"type":"voice-command","action":"join","muted":false}`,
		`{"type":"voice-command","action":"mute","connectionId":"voice_connection_1234"}`,
		`{"type":"voice-command","action":"leave","connectionId":null}`,
		`{"type":"voice-command","action":"join","roomId":"1234"}`,
		`{"type":"voice-signal","connectionId":"voice_connection_1234"}`,
		`{"type":"signal","kind":"voice","connectionId":"voice_connection_1234"}`,
	} {
		if _, err := DecodeClientMessage([]byte(body)); err == nil {
			t.Errorf("invalid voice message admitted: %s", body)
		}
	}
	if _, err := DecodeServerMessage([]byte(`{"type":"voice-state","peerId":"voice_peer_123456","connectionId":"voice_connection_1234","participants":[{"peerId":"voice_peer_123456","publicationId":"publication_123456","name":"Host"}]}`)); err == nil {
		t.Fatal("missing muted fact was accepted")
	}
}
