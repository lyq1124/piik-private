package signal

import (
	"encoding/json"
	"errors"
	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu/sfutest"
	"sync"
	"testing"
)

type admittedVoiceMedia struct {
	mu     sync.Mutex
	plans  map[string]sfu.VoiceConnectionPlan
	muted  map[string]bool
	closed []string
}

func (f *admittedVoiceMedia) ConfigureVoice(p sfu.VoiceConnectionPlan, _ func(sfu.VoiceMediaEvent)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.plans[p.ConnectionID] = p
	return nil
}
func (f *admittedVoiceMedia) SignalVoice(_, _, _, id string, _ sfu.VoiceSignal) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.plans[id]; !ok {
		return errors.New("unknown voice connection")
	}
	return nil
}
func (f *admittedVoiceMedia) SetVoiceMuted(_, _, _, id string, muted bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.muted[id] = muted
	return nil
}
func (f *admittedVoiceMedia) RestartVoice(_, _, _, _ string) error { return nil }
func (f *admittedVoiceMedia) CloseVoice(_, _, _, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.plans, id)
	delete(f.muted, id)
	f.closed = append(f.closed, id)
	return nil
}
func newAdmittedVoiceMedia() *admittedVoiceMedia {
	return &admittedVoiceMedia{plans: map[string]sfu.VoiceConnectionPlan{}, muted: map[string]bool{}}
}
func sendVoice(c *testClient, m protocol.VoiceCommandMessage) {
	value := map[string]any{"type": m.Type, "action": m.Action}
	if m.ConnectionID != "" {
		value["connectionId"] = m.ConnectionID
	}
	if m.Muted != nil {
		value["muted"] = *m.Muted
	}
	c.sendJSON(value)
}
func readVoiceState(t *testing.T, c *testClient, count int) protocol.VoiceStateMessage {
	t.Helper()
	for {
		var state protocol.VoiceStateMessage
		if err := json.Unmarshal(c.next("voice-state").raw, &state); err != nil {
			t.Fatal(err)
		}
		if len(state.Participants) == count {
			return state
		}
	}
}
func voiceHarness(t *testing.T) (*harness, *admittedVoiceMedia) {
	f := newAdmittedVoiceMedia()
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 3, viewerDisconnectGraceMs: 5000, voiceMedia: f, voiceMaxRooms: 1,
		sfu: &SfuFallback{Media: sfutest.New(), Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 3})}})
	t.Cleanup(h.close)
	return h, f
}
func TestPrivateRoomVoiceFourMembersStayIndependentOfPictureAndRetireExactly(t *testing.T) {
	h, media := voiceHarness(t)
	clients := make([]*testClient, 4)
	for i := range clients {
		clients[i] = openClient(t, h)
		role := protocol.RoleViewer
		if i == 0 {
			role = protocol.RoleHost
		}
		authenticate(t, clients[i], h.room, role, []string{"voice-host-12345678", "voice-one-12345678", "voice-two-12345678", "voice-three-12345678"}[i], 1, "", presenceOptions{roomSession: i == 0, roomOnly: i == 0, viewerPresence: true})
		sendVoice(clients[i], protocol.VoiceCommandMessage{Type: "voice-command", Action: "join"})
		readVoiceState(t, clients[i], i+1)
	}
	host := readVoiceState(t, clients[0], 4)
	viewer := readVoiceState(t, clients[1], 4)
	media.mu.Lock()
	if len(media.plans) != 4 {
		t.Fatalf("voice transports=%d", len(media.plans))
	}
	for _, p := range media.plans {
		if len(p.Publish) != 1 || len(p.Subscribe) != 3 {
			t.Fatalf("unexpected fanout: %+v", p)
		}
		for _, source := range p.Subscribe {
			if source.PeerID == p.PeerID {
				t.Fatal("self audio was subscribed")
			}
		}
	}
	media.mu.Unlock()
	unmuted := false
	sendVoice(clients[1], protocol.VoiceCommandMessage{Type: "voice-command", Action: "mute", ConnectionID: host.ConnectionID, Muted: &unmuted})
	sendVoice(clients[1], protocol.VoiceCommandMessage{Type: "voice-command", Action: "mute", ConnectionID: viewer.ConnectionID, Muted: &unmuted})
	readVoiceState(t, clients[1], 4)
	media.mu.Lock()
	if !media.muted[host.ConnectionID] || media.muted[viewer.ConnectionID] {
		t.Fatal("voice mute escaped the authenticated member's connection")
	}
	media.mu.Unlock()
	h.server.mu.Lock()
	h.server.stopSharing(h.room.RoomID)
	h.server.mu.Unlock()
	media.mu.Lock()
	if len(media.plans) != 4 || len(media.closed) != 0 {
		t.Fatal("stopping picture retired voice")
	}
	media.mu.Unlock()
	sendVoice(clients[1], protocol.VoiceCommandMessage{Type: "voice-command", Action: "leave", ConnectionID: viewer.ConnectionID})
	readVoiceState(t, clients[0], 3)
	media.mu.Lock()
	if len(media.plans) != 3 || len(media.closed) != 1 || media.closed[0] != viewer.ConnectionID {
		t.Fatal("voice leave did not retire exactly its own transport")
	}
	media.mu.Unlock()
}
func TestPrivateRoomVoiceHealthySignalingReconnectKeepsTransportAndGlobalAdmission(t *testing.T) {
	h, media := voiceHarness(t)
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "voice-resume-12345678", 1, "", presenceOptions{roomSession: true, roomOnly: true})
	sendVoice(host, protocol.VoiceCommandMessage{Type: "voice-command", Action: "join"})
	state := readVoiceState(t, host, 1)
	h.closeClient(host)
	replacement := openClient(t, h)
	authenticate(t, replacement, h.room, protocol.RoleHost, "voice-resume-12345678", 1, "", presenceOptions{roomSession: true, roomOnly: true})
	sendVoice(replacement, protocol.VoiceCommandMessage{Type: "voice-command", Action: "join", ConnectionID: state.ConnectionID})
	rebound := readVoiceState(t, replacement, 1)
	if rebound.ConnectionID != state.ConnectionID {
		t.Fatal("healthy voice was recreated on signaling reauthentication")
	}
	media.mu.Lock()
	if len(media.plans) != 1 || len(media.closed) != 0 {
		t.Fatal("signaling reconnect leaked/replaced a transport")
	}
	media.mu.Unlock()
	other, err := h.server.CreateRoom(protocol.CodeEntryOpen, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	second := openClient(t, h)
	authenticate(t, second, other, protocol.RoleHost, "voice-other-12345678", 1, "", presenceOptions{roomSession: true, roomOnly: true})
	sendVoice(second, protocol.VoiceCommandMessage{Type: "voice-command", Action: "join"})
	var rejected protocol.VoiceErrorMessage
	if err := json.Unmarshal(second.next("voice-error").raw, &rejected); err != nil {
		t.Fatal(err)
	}
	if rejected.Code != "room-limit" {
		t.Fatalf("voice admission=%q", rejected.Code)
	}
	media.mu.Lock()
	if len(media.plans) != 1 {
		t.Fatal("rejected room allocated media")
	}
	media.mu.Unlock()
}
