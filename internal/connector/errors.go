package connector

import "errors"

// ErrBadRequest is returned when request payload is invalid.
var ErrBadRequest = errors.New("bad request")

// ErrConflict is returned when an operation cannot be applied due to state conflict.
var ErrConflict = errors.New("conflict")

// ErrNotFound is returned when a mutate operation targets a row that does not exist.
var ErrNotFound = errors.New("not found")

// ErrForbidden is returned when the data source denies the requested operation.
var ErrForbidden = errors.New("forbidden")

// ErrReadOnly is returned when a write is attempted on a read-only connection.
var ErrReadOnly = errors.New("connection is read-only")

// ErrTimeout is returned when the data source times out while serving a request.
var ErrTimeout = errors.New("timeout")

// ErrUnavailable is returned when the data source cannot be reached.
var ErrUnavailable = errors.New("unavailable")

// ErrRelationNotFound is returned when a requested relation or index does not exist.
var ErrRelationNotFound = errors.New("relation not found")
