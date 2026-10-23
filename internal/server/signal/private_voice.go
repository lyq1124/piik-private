package signal

import (
	"sort"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
	"github.com/TNTcraftHIM/Piik/internal/server/sfu"
	"github.com/pion/webrtc/v4"
)

// The admitted room session owns voice; picture generations never own it.
// All fields except the physical media adapter are guarded by Server.mu.
type roomVoiceMember struct {
	deadlineSequence                                            uint64
	graceSequence                                               uint64
	room, peer, connection, transportSession, publication, name string
	session                                                     *session
	muted, pending, established, recovering                     bool
	recoveries                                                  int
	state                                                       webrtc.PeerConnectionState
	grace, deadline                                             func() bool
}

func (s *Server) voiceError(sess *session, code string) {
	if sess == nil {
		return
	}
	s.send(sess, protocol.VoiceErrorMessage{Type: "voice-error", Code: code})
}

func (s *Server) handleVoiceCommand(sess *session, actor *authenticatedSession, message protocol.VoiceCommandMessage) {
	if s.closing || !s.isCurrentSession(sess) || sess.authenticated != actor {
		return
	}
	if s.voiceMedia == nil || s.voiceMaxRooms <= 0 {
		s.voiceError(sess, "unavailable")
		return
	}
	if s.routePolicyOf(actor.roomID).PeerOnly {
		s.voiceError(sess, "forbidden")
		return
	}
	members := s.voiceRooms[actor.roomID]
	m := members[actor.peerID]
	if message.Action == "join" {
		if m != nil {
			s.clearVoiceGrace(m)
			m.session = sess
			if actor.displayName != nil {
				m.name = *actor.displayName
			}
			// A healthy transport survives signaling recovery. An unfinished SDP
			// exchange cannot be replayed safely; replace only that transport.
			if m.pending || message.ConnectionID != m.connection || (m.established && m.state != webrtc.PeerConnectionStateConnected) {
				s.replaceVoiceTransport(m)
			}
			s.broadcastVoiceState(actor.roomID)
			return
		}
		if members == nil {
			if len(s.voiceRooms) >= s.voiceMaxRooms {
				s.voiceError(sess, "room-limit")
				return
			}
			members = map[string]*roomVoiceMember{}
			s.voiceRooms[actor.roomID] = members
		}
		if len(members) >= s.voiceMaxParticipants {
			s.voiceError(sess, "room-limit")
			return
		}
		name := protocol.DefaultViewerDisplayName
		if actor.role == protocol.RoleHost {
			name = protocol.DefaultHostDisplayNamePrefix
		}
		if actor.displayName != nil {
			name = *actor.displayName
		}
		m = &roomVoiceMember{room: actor.roomID, peer: actor.peerID, session: sess, transportSession: sess.sessionID, connection: opaqueID(), publication: opaqueID(), name: name, muted: true}
		members[m.peer] = m
		s.broadcastVoiceState(m.room)
		s.configureRoomVoice(m.room)
		return
	}
	if m == nil || m.session != sess || m.connection != message.ConnectionID {
		return
	}
	switch message.Action {
	case "leave":
		s.removeVoiceMember(m.room, m.peer)
	case "mute":
		m.muted = *message.Muted
		if err := s.voiceMedia.SetVoiceMuted(m.room, m.peer, m.transportSession, m.connection, m.muted); err != nil {
			s.voiceError(sess, "connection-failed")
			return
		}
		s.broadcastVoiceState(m.room)
	case "recover":
		s.recoverVoice(m)
	}
}

func (s *Server) broadcastVoiceState(room string) {
	members := s.voiceRooms[room]
	people := make([]protocol.VoiceParticipant, 0, len(members))
	for _, m := range members {
		people = append(people, protocol.VoiceParticipant{PeerID: m.peer, PublicationID: m.publication, Name: m.name, Muted: m.muted})
	}
	sort.Slice(people, func(i, j int) bool { return people[i].PeerID < people[j].PeerID })
	for _, m := range members {
		if m.session != nil && m.session.open() && s.isCurrentSession(m.session) {
			s.send(m.session, protocol.VoiceStateMessage{Type: "voice-state", PeerID: m.peer, ConnectionID: m.connection, Participants: people})
		}
	}
}

func (s *Server) configureRoomVoice(room string) {
	members := s.voiceRooms[room]
	for _, m := range members {
		plan := sfu.VoiceConnectionPlan{RoomID: room, PeerID: m.peer, SessionID: m.transportSession, ConnectionID: m.connection,
			Publish: []sfu.VoicePublication{{ID: m.publication, PeerID: m.peer}}, Subscribe: []sfu.VoicePublication{}}
		for _, other := range members {
			if other != m {
				plan.Subscribe = append(plan.Subscribe, sfu.VoicePublication{ID: other.publication, PeerID: other.peer})
			}
		}
		if err := s.voiceMedia.ConfigureVoice(plan, s.handleVoiceMediaEvent); err != nil {
			s.voiceError(m.session, "connection-failed")
		}
		_ = s.voiceMedia.SetVoiceMuted(room, m.peer, m.transportSession, m.connection, m.muted)
	}
}

func (s *Server) handleVoiceMediaEvent(event sfu.VoiceMediaEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.voiceRooms[event.RoomID][event.PeerID]
	if s.closing || m == nil || m.connection != event.ConnectionID || m.transportSession != event.SessionID {
		return
	}
	message := protocol.VoiceSignalMessage{Type: "voice-signal", ConnectionID: m.connection}
	if event.Description != nil {
		d := event.Description
		tracks := make([]protocol.VoiceTrack, 0, len(d.Tracks))
		for _, t := range d.Tracks {
			tracks = append(tracks, protocol.VoiceTrack{MID: t.MID, PublicationID: t.PublicationID})
		}
		message.Description = &protocol.VoiceDescription{Revision: protocol.Int(d.Revision), SDP: protocol.SessionDescription{Type: d.SDP.Type.String(), SDP: d.SDP.SDP}, Tracks: tracks}
		m.pending = true
		s.armVoiceDeadline(m)
	} else if event.Candidate != nil {
		message.Candidate = voiceCandidateToWire(event.Candidate)
	} else {
		m.state = event.State
		switch event.State {
		case webrtc.PeerConnectionStateConnected:
			m.established = true
			m.recovering = false
			m.recoveries = 0
			if !m.pending {
				s.clearVoiceDeadline(m)
			}
		case webrtc.PeerConnectionStateFailed:
			s.recoverVoice(m)
		}
		return
	}
	if m.session != nil && m.session.open() && s.isCurrentSession(m.session) {
		s.send(m.session, message)
	}
}

func voiceCandidateToWire(c *webrtc.ICECandidateInit) *protocol.IceCandidate {
	result := &protocol.IceCandidate{Candidate: c.Candidate}
	if c.SDPMid != nil {
		result.SDPMid = protocol.Nullable[string]{Set: true, Value: c.SDPMid}
	}
	if c.SDPMLineIndex != nil {
		n := protocol.Int(*c.SDPMLineIndex)
		result.SDPMLineIndex = protocol.Nullable[protocol.Int]{Set: true, Value: &n}
	}
	if c.UsernameFragment != nil {
		result.UsernameFragment = protocol.Nullable[string]{Set: true, Value: c.UsernameFragment}
	}
	return result
}

func (s *Server) handleVoiceSignal(sess *session, actor *authenticatedSession, message protocol.VoiceSignalMessage) {
	m := s.voiceRooms[actor.roomID][actor.peerID]
	if m == nil || m.session != sess || m.connection != message.ConnectionID || !s.isCurrentSession(sess) {
		return
	}
	input := sfu.VoiceSignal{}
	if message.Description != nil {
		d := message.Description
		if d.SDP.Type != "answer" {
			s.voiceError(sess, "forbidden")
			return
		}
		tracks := make([]sfu.VoiceTrack, 0, len(d.Tracks))
		for _, t := range d.Tracks {
			tracks = append(tracks, sfu.VoiceTrack{MID: t.MID, PublicationID: t.PublicationID})
		}
		input.Description = &sfu.VoiceDescription{Revision: uint64(d.Revision), SDP: webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: d.SDP.SDP}, Tracks: tracks}
	} else if c := message.Candidate; c != nil {
		value := &webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid.Value, UsernameFragment: c.UsernameFragment.Value}
		if c.SDPMLineIndex.Value != nil {
			n := uint16(*c.SDPMLineIndex.Value)
			value.SDPMLineIndex = &n
		}
		input.Candidate = value
	}
	if err := s.voiceMedia.SignalVoice(m.room, m.peer, m.transportSession, m.connection, input); err != nil {
		s.voiceError(sess, "connection-failed")
		return
	}
	if message.Description != nil {
		m.pending = false
		if m.state == webrtc.PeerConnectionStateConnected {
			s.clearVoiceDeadline(m)
		}
	}
}

func (s *Server) armVoiceDeadline(m *roomVoiceMember) {
	s.clearVoiceDeadline(m)
	connection := m.connection
	sequence := m.deadlineSequence
	m.deadline = s.afterFunc(15*time.Second, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.voiceRooms[m.room][m.peer] != m || m.connection != connection || m.deadlineSequence != sequence {
			return
		}
		m.deadline = nil
		m.recovering = false
		s.recoverVoice(m)
	})
}

func (s *Server) clearVoiceDeadline(m *roomVoiceMember) {
	m.deadlineSequence++
	if m.deadline != nil {
		m.deadline()
		m.deadline = nil
	}
}
func (s *Server) clearVoiceGrace(m *roomVoiceMember) {
	m.graceSequence++
	if m.grace != nil {
		m.grace()
		m.grace = nil
	}
}

func (s *Server) replaceVoiceTransport(m *roomVoiceMember) {
	old, session := m.connection, m.transportSession
	m.connection = opaqueID()
	m.transportSession = m.session.sessionID
	m.established = false
	m.state = webrtc.PeerConnectionStateNew
	m.pending = false
	s.clearVoiceDeadline(m)
	_ = s.voiceMedia.CloseVoice(m.room, m.peer, session, old)
	s.broadcastVoiceState(m.room)
	s.configureRoomVoice(m.room)
}

func (s *Server) recoverVoice(m *roomVoiceMember) {
	if m.session == nil || !m.session.open() || !s.isCurrentSession(m.session) {
		return
	}
	if m.recovering {
		return
	}
	m.recoveries++
	if m.recoveries > 2 {
		s.voiceError(m.session, "connection-failed")
		s.removeVoiceMember(m.room, m.peer)
		return
	}
	m.recovering = true
	if m.recoveries == 1 && m.established && !m.pending {
		if err := s.voiceMedia.RestartVoice(m.room, m.peer, m.transportSession, m.connection); err == nil {
			return
		}
	}
	s.replaceVoiceTransport(m)
}

func (s *Server) disconnectVoice(sess *session) {
	if sess.authenticated == nil {
		return
	}
	a := sess.authenticated
	m := s.voiceRooms[a.roomID][a.peerID]
	if m == nil || m.session != sess {
		return
	}
	if s.closing || sess.revoked {
		s.removeVoiceMember(a.roomID, a.peerID)
		return
	}
	m.session = nil
	s.clearVoiceGrace(m)
	sequence := m.graceSequence
	m.grace = s.afterFunc(time.Duration(s.viewerDisconnectGraceMs)*time.Millisecond, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.voiceRooms[m.room][m.peer] == m && m.session == nil && m.graceSequence == sequence {
			s.removeVoiceMember(m.room, m.peer)
		}
	})
}

func (s *Server) removeVoiceMember(room, peer string) {
	members := s.voiceRooms[room]
	m := members[peer]
	if m == nil {
		return
	}
	delete(members, peer)
	s.clearVoiceGrace(m)
	s.clearVoiceDeadline(m)
	if len(members) == 0 {
		delete(s.voiceRooms, room)
	}
	_ = s.voiceMedia.CloseVoice(room, peer, m.transportSession, m.connection)
	if !s.closing {
		s.broadcastVoiceState(room)
		s.configureRoomVoice(room)
	}
}

func (s *Server) closeRoomVoice(room string) {
	members := s.voiceRooms[room]
	delete(s.voiceRooms, room)
	for _, m := range members {
		s.clearVoiceGrace(m)
		s.clearVoiceDeadline(m)
		_ = s.voiceMedia.CloseVoice(room, m.peer, m.transportSession, m.connection)
	}
}
