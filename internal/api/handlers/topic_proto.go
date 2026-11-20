package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/zxchlorka/kizuna/internal/config"
	"github.com/zxchlorka/kizuna/internal/connector"
	"github.com/zxchlorka/kizuna/internal/protoschema"
)

// maxProtoSourceBytes bounds an attached .proto. Contracts are a few kilobytes;
// anything near this is not one.
const maxProtoSourceBytes = 1 << 20

type topicProtoRequest struct {
	FileName string `json:"file_name"`
	// Source empty keeps the attached file, so a request can switch the
	// message alone.
	Source  string `json:"source"`
	Message string `json:"message"`
}

type topicProtoResponse struct {
	FileName string   `json:"file_name"`
	Message  string   `json:"message"`
	Messages []string `json:"messages"`
}

// topicFromPath reads the topic name, which the browser percent-encodes.
func topicFromPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	topic, err := url.PathUnescape(chi.URLParam(r, "name"))
	if err != nil || strings.TrimSpace(topic) == "" {
		writeError(w, http.StatusBadRequest, "invalid topic name")
		return "", false
	}
	return topic, true
}

// GetTopicProto answers null when the topic has no contract attached.
func (h *DataHandler) GetTopicProto(w http.ResponseWriter, r *http.Request) {
	topic, ok := topicFromPath(w, r)
	if !ok {
		return
	}
	attached, ok := h.cfg.GetTopicProto(chi.URLParam(r, "id"), topic)
	if !ok {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	schema, err := protoschema.Compile(r.Context(), attached.FileName, attached.Source)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "the attached .proto no longer compiles: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, topicProtoResponse{FileName: attached.FileName, Message: attached.Message, Messages: schema.Messages()})
}

// PutTopicProto attaches a contract to the topic, or switches the message of
// the one attached. Without a message it takes the file's likely top-level one.
func (h *DataHandler) PutTopicProto(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	topic, ok := topicFromPath(w, r)
	if !ok {
		return
	}
	conn, ok := h.cfg.GetConnection(id)
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	if conn.Type != "kafka" {
		writeError(w, http.StatusBadRequest, "a .proto can only be attached to a Kafka topic")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4*maxProtoSourceBytes)
	var req topicProtoRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Source) > maxProtoSourceBytes {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("the .proto is too large: over %d KiB", maxProtoSourceBytes>>10))
		return
	}

	attached := config.TopicProtoConfig{ConnID: id, Topic: topic, FileName: path.Base(req.FileName), Source: req.Source}
	if req.Source == "" {
		current, ok := h.cfg.GetTopicProto(id, topic)
		if !ok {
			writeError(w, http.StatusBadRequest, "source is required: the topic has no .proto attached yet")
			return
		}
		attached.FileName, attached.Source = current.FileName, current.Source
	}
	if attached.FileName == "." || attached.FileName == "/" {
		attached.FileName = "contract.proto"
	}

	schema, err := protoschema.Compile(r.Context(), attached.FileName, attached.Source)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	attached.Message = req.Message
	if attached.Message == "" {
		attached.Message = schema.DefaultMessage()
	}
	if _, err := schema.Decoder(attached.Message); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	h.cfg.SetTopicProto(attached)
	if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
		slog.Error("failed to save config", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save configuration")
		return
	}
	writeJSON(w, http.StatusOK, topicProtoResponse{FileName: attached.FileName, Message: attached.Message, Messages: schema.Messages()})
}

func (h *DataHandler) DeleteTopicProto(w http.ResponseWriter, r *http.Request) {
	topic, ok := topicFromPath(w, r)
	if !ok {
		return
	}
	if h.cfg.RemoveTopicProto(chi.URLParam(r, "id"), topic) {
		if err := h.cfg.Save(h.cfg.GetPath()); err != nil {
			slog.Error("failed to save config", "error", err)
			writeError(w, http.StatusInternalServerError, "failed to save configuration")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// topicValueDecoder compiles the contract attached to the topic; nil when there
// is none.
//
// ponytail: compiles on every request (about a millisecond for a contract);
// cache by source and message if it ever shows up next to a Kafka fetch.
func (h *DataHandler) topicValueDecoder(ctx context.Context, connID, topic string) (connector.PayloadDecoder, error) {
	attached, ok := h.cfg.GetTopicProto(connID, topic)
	if !ok {
		return nil, nil
	}
	schema, err := protoschema.Compile(ctx, attached.FileName, attached.Source)
	if err != nil {
		return nil, fmt.Errorf("the .proto attached to %s no longer compiles: %w", topic, err)
	}
	decoder, err := schema.Decoder(attached.Message)
	if err != nil {
		return nil, err
	}
	return decoder, nil
}
