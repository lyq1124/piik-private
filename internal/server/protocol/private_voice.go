package protocol

import "errors"

// Room voice is opt-in and independent of a screen publication.
type VoiceCommandMessage struct {
	Type         string `json:"type"`
	Action       string `json:"action"`
	ConnectionID string `json:"connectionId,omitempty"`
	Muted        *bool  `json:"muted,omitempty"`
}

func (VoiceCommandMessage) isClientMessage() {}

type VoiceTrack struct {
	MID           string `json:"mid"`
	PublicationID string `json:"publicationId"`
}

func (v *VoiceTrack) UnmarshalJSON(data []byte) error {
	type plain VoiceTrack
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("mid", "publicationId"); err != nil {
		return err
	}
	if len(v.MID) < 1 || len(v.MID) > 128 || !ValidOpaqueID(v.PublicationID) {
		return errors.New("invalid voice track")
	}
	return nil
}

type VoiceDescription struct {
	Revision Int                `json:"revision"`
	SDP      SessionDescription `json:"sdp"`
	Tracks   []VoiceTrack       `json:"tracks"`
}

func (v *VoiceDescription) UnmarshalJSON(data []byte) error {
	type plain VoiceDescription
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("revision", "sdp", "tracks"); err != nil {
		return err
	}
	if v.Revision < 1 || len(v.Tracks) > MaxParticipantsPerRoomLimit*2 {
		return errors.New("invalid voice description")
	}
	return nil
}

type VoiceSignalMessage struct {
	Type         string            `json:"type"`
	ConnectionID string            `json:"connectionId"`
	Description  *VoiceDescription `json:"description,omitempty"`
	Candidate    *IceCandidate     `json:"candidate,omitempty"`
}

func (VoiceSignalMessage) isClientMessage() {}
func (VoiceSignalMessage) isServerMessage() {}

type VoiceParticipant struct {
	PeerID        string `json:"peerId"`
	PublicationID string `json:"publicationId"`
	Name          string `json:"name"`
	Muted         bool   `json:"muted"`
}

func (v *VoiceParticipant) UnmarshalJSON(data []byte) error {
	type plain VoiceParticipant
	f, err := decodeObject(data, (*plain)(v))
	if err != nil {
		return err
	}
	if err = f.require("peerId", "publicationId", "name", "muted"); err != nil {
		return err
	}
	if !ValidOpaqueID(v.PeerID) || !ValidOpaqueID(v.PublicationID) || UTF16Length(v.Name) > 128 {
		return errors.New("invalid voice participant")
	}
	return nil
}

type VoiceStateMessage struct {
	Type         string             `json:"type"`
	PeerID       string             `json:"peerId"`
	ConnectionID string             `json:"connectionId"`
	Participants []VoiceParticipant `json:"participants"`
}

func (VoiceStateMessage) isServerMessage() {}

type VoiceErrorMessage struct {
	Type string `json:"type"`
	Code string `json:"code"`
}

func (VoiceErrorMessage) isServerMessage() {}

func decodeVoiceCommand(data []byte) (ClientMessage, error) {
	var v VoiceCommandMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "action"); err != nil {
		return nil, err
	}
	if err = f.optional("connectionId", "muted"); err != nil {
		return nil, err
	}
	if f.has("connectionId") && !ValidOpaqueID(v.ConnectionID) {
		return nil, errors.New("invalid voice connection")
	}
	switch v.Action {
	case "join":
		if v.Muted != nil {
			return nil, errors.New("join starts muted")
		}
	case "leave", "recover":
		if v.ConnectionID == "" || v.Muted != nil {
			return nil, errors.New("invalid voice command")
		}
	case "mute":
		if v.ConnectionID == "" || v.Muted == nil {
			return nil, errors.New("invalid mute command")
		}
	default:
		return nil, errors.New("unknown voice command")
	}
	return v, nil
}
func decodeVoiceSignal(data []byte) (VoiceSignalMessage, error) {
	var v VoiceSignalMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return v, err
	}
	if err = f.require("type", "connectionId"); err != nil {
		return v, err
	}
	if err = f.optional("description", "candidate"); err != nil {
		return v, err
	}
	if !ValidOpaqueID(v.ConnectionID) || (v.Description == nil) == (v.Candidate == nil) {
		return v, errors.New("one current voice signal is required")
	}
	return v, nil
}
func decodeVoiceState(data []byte) (ServerMessage, error) {
	var v VoiceStateMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "peerId", "connectionId", "participants"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(v.PeerID) || !ValidOpaqueID(v.ConnectionID) || len(v.Participants) > MaxParticipantsPerRoomLimit {
		return nil, errors.New("invalid voice state")
	}
	for _, p := range v.Participants {
		if !ValidOpaqueID(p.PeerID) || !ValidOpaqueID(p.PublicationID) || UTF16Length(p.Name) > 128 {
			return nil, errors.New("invalid voice participant")
		}
	}
	return v, nil
}
func decodeVoiceError(data []byte) (ServerMessage, error) {
	var v VoiceErrorMessage
	f, err := decodeObject(data, &v)
	if err != nil {
		return nil, err
	}
	if err = f.require("type", "code"); err != nil {
		return nil, err
	}
	switch v.Code {
	case "unavailable", "room-limit", "forbidden", "connection-failed":
		return v, nil
	}
	return nil, errors.New("invalid voice error")
}
