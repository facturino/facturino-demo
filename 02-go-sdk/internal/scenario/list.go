package scenario

import (
	"encoding/json"
	"fmt"

	facturino "github.com/facturino/facturino-go/v2"
)

// unmarshalFirst decodes the first element of a *facturino.ListResponse
// into dest. It is used for the handful of endpoints whose SDK methods
// return the raw ListResponse envelope (companies, invoice events, audit
// trail) rather than a typed iterator. Returns an error when the page is
// empty so callers can react instead of operating on a zero value.
func unmarshalFirst(list *facturino.ListResponse, dest any) error {
	if list == nil || len(list.Data) == 0 {
		return fmt.Errorf("list is empty")
	}
	return json.Unmarshal(list.Data[0], dest)
}
