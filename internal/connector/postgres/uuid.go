package postgres

import (
	"regexp"
	"strings"
)

var uuidCanonicalRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

func normalizeCanonicalUUID(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if !uuidCanonicalRe.MatchString(s) {
		return "", false
	}
	return strings.ToLower(s), true
}
