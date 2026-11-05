// export_test.go exposes internal functions for white-box testing.
// This file is only compiled when running `go test`.
package api

import (
	"encoding/json"

	"github.com/gin-gonic/gin"
)

// ExportedVerifyMath exposes the unexported verifyMath function to the test package.
func ExportedVerifyMath(raw json.RawMessage) gin.H {
	return verifyMath(raw)
}
