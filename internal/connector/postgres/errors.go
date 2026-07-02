package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/qsnake66/kizuna/internal/connector"
)

func normalizePostgresError(err error) error {
	if err == nil {
		return nil
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "22P02", "22007", "22003", "23502", "23514", "42601":
			return fmt.Errorf("%w: %s", connector.ErrBadRequest, pgErr.Message)
		case "23505", "23503":
			return fmt.Errorf("%w: %s", connector.ErrConflict, pgErr.Message)
		case "42501":
			return fmt.Errorf("%w: %s", connector.ErrForbidden, pgErr.Message)
		case "42P01", "42703", "42704":
			return fmt.Errorf("%w: %s", connector.ErrRelationNotFound, pgErr.Message)
		case "57014":
			return fmt.Errorf("%w: %s", connector.ErrTimeout, pgErr.Message)
		}
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	}

	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout"):
		return fmt.Errorf("%w: %s", connector.ErrTimeout, err.Error())
	case strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "failed to connect"),
		strings.Contains(msg, "connection reset"),
		strings.Contains(msg, "dial tcp"),
		strings.Contains(msg, "broken pipe"):
		return fmt.Errorf("%w: %s", connector.ErrUnavailable, err.Error())
	default:
		return err
	}
}
