package handlers

import (
	"context"
	"time"

	"github.com/qsnake66/kizuna/internal/connector"
)

const connectionAcquireTimeout = 6 * time.Second

func getConnector(ctx context.Context, manager *connector.ConnectionManager, id string) (connector.Connector, context.CancelFunc, error) {
	timeoutCtx, cancel := context.WithTimeout(ctx, connectionAcquireTimeout)
	c, err := manager.Get(timeoutCtx, id)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return c, cancel, nil
}
