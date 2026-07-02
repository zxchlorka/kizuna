package history

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/qsnake66/kizuna/internal/connector"
)

const maxEntriesPerConnection = 100

type Store struct {
	baseDir string
	mu      sync.Mutex
}

func NewStore(configPath string) *Store {
	baseDir := filepath.Join(filepath.Dir(configPath), "history")
	return &Store{baseDir: baseDir}
}

func (s *Store) Append(connectionID string, entry connector.HistoryEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.load(connectionID)
	if err != nil {
		return err
	}

	entries = append(entries, entry)
	if len(entries) > maxEntriesPerConnection {
		entries = entries[len(entries)-maxEntriesPerConnection:]
	}

	return s.save(connectionID, entries)
}

func (s *Store) List(connectionID string, limit int, search string) ([]connector.HistoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.load(connectionID)
	if err != nil {
		return nil, err
	}

	search = strings.ToLower(strings.TrimSpace(search))
	filtered := make([]connector.HistoryEntry, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		if search != "" && !strings.Contains(strings.ToLower(entry.Command), search) {
			continue
		}
		filtered = append(filtered, entry)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}

	return filtered, nil
}

func (s *Store) Clear(connectionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.filePath(connectionID)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove history: %w", err)
	}
	return nil
}

func (s *Store) load(connectionID string) ([]connector.HistoryEntry, error) {
	path := s.filePath(connectionID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read history: %w", err)
	}

	var entries []connector.HistoryEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("decode history: %w", err)
	}

	return entries, nil
}

func (s *Store) save(connectionID string, entries []connector.HistoryEntry) error {
	if err := os.MkdirAll(s.baseDir, 0o755); err != nil {
		return fmt.Errorf("create history dir: %w", err)
	}

	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return fmt.Errorf("encode history: %w", err)
	}

	if err := os.WriteFile(s.filePath(connectionID), data, 0o600); err != nil {
		return fmt.Errorf("write history: %w", err)
	}

	return nil
}

func (s *Store) filePath(connectionID string) string {
	return filepath.Join(s.baseDir, connectionID+".json")
}
