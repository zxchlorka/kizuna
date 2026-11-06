package config

import (
	"cmp"
	"errors"
	"slices"
	"strings"
)

// FolderConfig groups connections on the connection list. Folders nest through
// ParentID ("" = top level); a connection points at its folder via FolderID.
type FolderConfig struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parent_id,omitempty"`
	// Position orders folders among their siblings, from 1. Load numbers the
	// ones a config from before ordering existed lacks, by name.
	Position int `json:"position,omitempty"`
}

var (
	ErrFolderNotFound     = errors.New("folder not found")
	ErrConnectionNotFound = errors.New("connection not found")
	ErrFolderCycle        = errors.New("a folder cannot be moved into itself or its own subfolder")
)

func (c *AppConfig) GetFolders() []FolderConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]FolderConfig{}, c.Folders...)
}

// AddFolder stores a folder at the end of parentID, which must exist unless
// it is "", and returns it with its position.
func (c *AppConfig) AddFolder(folder FolderConfig) (FolderConfig, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.folderExists(folder.ParentID) {
		return FolderConfig{}, ErrFolderNotFound
	}
	folder.Position = c.lastFolderPosition(folder.ParentID, folder.ID) + 1
	c.Folders = append(c.Folders, folder)
	return folder, nil
}

// UpdateFolder renames a folder and moves it under parentID, refusing a move
// that would hang the folder below itself and cut the branch off the tree.
func (c *AppConfig) UpdateFolder(id, name, parentID string) (FolderConfig, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	i := c.folderIndex(id)
	if i < 0 || !c.folderExists(parentID) {
		return FolderConfig{}, ErrFolderNotFound
	}
	if c.isWithinFolder(parentID, id) {
		return FolderConfig{}, ErrFolderCycle
	}
	if c.Folders[i].ParentID != parentID {
		c.Folders[i].Position = c.lastFolderPosition(parentID, id) + 1
	}
	c.Folders[i].Name = name
	c.Folders[i].ParentID = parentID
	return c.Folders[i], nil
}

// ArrangeFolders puts folderIDs under parentID in exactly that order. The list
// is the parent's whole new order, a folder dragged in from elsewhere
// included, so one call both moves and orders.
func (c *AppConfig) ArrangeFolders(parentID string, folderIDs []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.folderExists(parentID) {
		return ErrFolderNotFound
	}
	for _, id := range folderIDs {
		if c.folderIndex(id) < 0 {
			return ErrFolderNotFound
		}
		if c.isWithinFolder(parentID, id) {
			return ErrFolderCycle
		}
	}
	for position, id := range folderIDs {
		folder := &c.Folders[c.folderIndex(id)]
		folder.ParentID = parentID
		folder.Position = position + 1
	}
	return nil
}

// RemoveFolder deletes a folder and lifts what it held, subfolders and
// connections alike, into its parent: deleting a folder never deletes a
// connection.
func (c *AppConfig) RemoveFolder(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	i := c.folderIndex(id)
	if i < 0 {
		return false
	}
	parentID := c.Folders[i].ParentID
	c.Folders = append(c.Folders[:i], c.Folders[i+1:]...)
	for j := range c.Folders {
		if c.Folders[j].ParentID == id {
			c.Folders[j].ParentID = parentID
		}
	}
	for j := range c.Connections {
		if c.Connections[j].FolderID == id {
			c.Connections[j].FolderID = parentID
		}
	}
	return true
}

// SetConnectionFolder moves a connection to the end of folderID ("" = top level).
func (c *AppConfig) SetConnectionFolder(connID, folderID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.folderExists(folderID) {
		return ErrFolderNotFound
	}
	last := 0
	for _, conn := range c.Connections {
		if conn.FolderID == folderID && conn.ID != connID {
			last = max(last, conn.Position)
		}
	}
	for i := range c.Connections {
		if c.Connections[i].ID == connID {
			c.Connections[i].FolderID = folderID
			c.Connections[i].Position = last + 1
			return nil
		}
	}
	return ErrConnectionNotFound
}

// ArrangeConnections puts connIDs into folderID in exactly that order. The
// list is the folder's whole new order, a connection dragged in from another
// folder included, so one call both moves and orders.
func (c *AppConfig) ArrangeConnections(folderID string, connIDs []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.folderExists(folderID) {
		return ErrFolderNotFound
	}
	index := make(map[string]int, len(c.Connections))
	for i, conn := range c.Connections {
		index[conn.ID] = i
	}
	for _, id := range connIDs {
		if _, ok := index[id]; !ok {
			return ErrConnectionNotFound
		}
	}
	for position, id := range connIDs {
		conn := &c.Connections[index[id]]
		conn.FolderID = folderID
		conn.Position = position + 1
	}
	return nil
}

// normalizeFolders repairs what only a hand-edited config.json can hold: a
// parent that does not exist, a folder inside its own subtree, a connection
// in a missing folder. Each lands at top level instead of vanishing from the
// list or turning every later rename into "folder not found". Run on Load,
// before the config is shared.
func (c *AppConfig) normalizeFolders() {
	for i := range c.Folders {
		folder := &c.Folders[i]
		if !c.folderExists(folder.ParentID) {
			folder.ParentID = ""
			continue
		}
		for p, hops := folder.ParentID, 0; p != ""; hops++ {
			if p == folder.ID || hops > len(c.Folders) {
				folder.ParentID = ""
				break
			}
			j := c.folderIndex(p)
			if j < 0 {
				break
			}
			p = c.Folders[j].ParentID
		}
	}
	for i := range c.Connections {
		if !c.folderExists(c.Connections[i].FolderID) {
			c.Connections[i].FolderID = ""
		}
	}
	// Folders saved before they had an order: behind their positioned
	// siblings, by name, as the list used to sort them.
	unordered := make([]*FolderConfig, 0)
	for i := range c.Folders {
		if c.Folders[i].Position == 0 {
			unordered = append(unordered, &c.Folders[i])
		}
	}
	slices.SortStableFunc(unordered, func(a, b *FolderConfig) int {
		return cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	for _, folder := range unordered {
		folder.Position = c.lastFolderPosition(folder.ParentID, folder.ID) + 1
	}
}

// folderIndex and folderExists expect c.mu to be held.
func (c *AppConfig) folderIndex(id string) int {
	for i, folder := range c.Folders {
		if folder.ID == id {
			return i
		}
	}
	return -1
}

func (c *AppConfig) folderExists(id string) bool {
	return id == "" || c.folderIndex(id) >= 0
}

// isWithinFolder reports whether folderID is ancestorID or sits anywhere
// below it. Bounded by the folder count so a hand-edited config.json that
// already holds a loop cannot hang the request.
func (c *AppConfig) isWithinFolder(folderID, ancestorID string) bool {
	for p, hops := folderID, 0; p != "" && hops <= len(c.Folders); hops++ {
		if p == ancestorID {
			return true
		}
		j := c.folderIndex(p)
		if j < 0 {
			return false
		}
		p = c.Folders[j].ParentID
	}
	return false
}

// lastFolderPosition is the highest position among parentID's folders,
// leaving out exceptID.
func (c *AppConfig) lastFolderPosition(parentID, exceptID string) int {
	last := 0
	for _, folder := range c.Folders {
		if folder.ParentID == parentID && folder.ID != exceptID {
			last = max(last, folder.Position)
		}
	}
	return last
}
